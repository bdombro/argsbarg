/*
Per-invocation output capture shared by every argsbarg copy in the process.

Installs the stdout, stderr, console, process.exit, and process.chdir patches once, then routes
each call to the AsyncLocalStorage scope of the invocation that made it. Overlapping invocations
(HTTP requests, concurrent MCP calls, parallel `app.invoke`) never mix their output. Bundled
argsbarg copies loaded by the MCP gateway find the same state through a global symbol.
*/

import { AsyncLocalStorage } from "node:async_hooks";
import { format } from "node:util";
import type { Surface } from "../core/invocation.ts";

/** Output buffers and process hooks for one running invocation. */
export interface InvocationScope {
  /** Captured stdout text. */
  stdout: string;
  /** Captured stderr text. */
  stderr: string;
  /** Replaces process.exit for code inside the invocation; must throw. */
  exit: (code: number) => never;
  /** When true, process.chdir throws inside this invocation (concurrent MCP calls share the process cwd). */
  forbidChdir: boolean;
  /** Set once the invocation settles; later writes from its async callbacks take the outside path. */
  closed: boolean;
  /** Stable source and surface metadata, with no handler inputs, locals, or credentials. */
  readonly metadata: {
    /** Binder-selected credential source family. */
    readonly source: "local" | "http";
    /** Binder-selected application surface. */
    readonly surface: Surface;
  };
  /** Cooperative cancellation signal captured for this invocation. */
  readonly signal: AbortSignal;
}

/** Process-wide capture state, shared across argsbarg copies through {@link SCOPE_STATE_KEY}. */
export interface InvocationScopeState {
  /** Contract version; argsbarg copies only share state with the same version. */
  version: number;
  /** Tracks which invocation is running in the current async context. */
  storage: AsyncLocalStorage<InvocationScope>;
  /** Unpatched stdout writer, for protocol messages that must bypass capture. */
  rawStdoutWrite: (text: string) => boolean;
  /** When true, stdout writes outside any invocation go to stderr (MCP stdio: stdout is the wire). */
  stdoutOutsideToStderr: boolean;
}

/** Bumped when {@link InvocationScopeState} changes incompatibly. */
export const INVOCATION_SCOPE_VERSION = 2;

/** Global key under which the first argsbarg copy publishes the shared state. */
const SCOPE_STATE_KEY = Symbol.for("argsbarg.invocation-scope");

/** Message for process.chdir inside a concurrent MCP invocation. */
const CHDIR_FORBIDDEN =
  "process.chdir isn't allowed inside a command while MCP calls run concurrently; pass the directory as an argument";

/** Returns the shared capture state, installing the process patches on first use. */
export function invocationScopeState(): InvocationScopeState {
  const globals = globalThis as Record<symbol, unknown>;
  const existing = globals[SCOPE_STATE_KEY] as InvocationScopeState | undefined;
  if (existing) {
    if (existing.version !== INVOCATION_SCOPE_VERSION) {
      throw new Error(
        `argsbarg invocation scope version ${existing.version} is already installed; this copy needs ${INVOCATION_SCOPE_VERSION}. Rebuild every bundle with the same argsbarg version.`,
      );
    }
    return existing;
  }

  const storage = new AsyncLocalStorage<InvocationScope>();
  const rawStdoutWrite = process.stdout.write.bind(process.stdout);
  const rawStderrWrite = process.stderr.write.bind(process.stderr);
  const rawExit = process.exit.bind(process);
  const rawChdir = process.chdir.bind(process);
  const rawConsole = {
    error: console.error.bind(console),
    info: console.info.bind(console),
    log: console.log.bind(console),
    warn: console.warn.bind(console),
  };
  const state: InvocationScopeState = {
    version: INVOCATION_SCOPE_VERSION,
    storage,
    rawStdoutWrite: (text) => rawStdoutWrite(text),
    stdoutOutsideToStderr: false,
  };

  /** The open scope for the current async context, if any. */
  const active = (): InvocationScope | undefined => {
    const scope = storage.getStore();
    return scope && !scope.closed ? scope : undefined;
  };

  /** Converts a write chunk to text. */
  const text = (chunk: string | Uint8Array): string =>
    typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);

  /** Calls the optional write callback the way a real stream would. */
  const callback = (args: unknown[]): void => {
    const cb = args.find((arg) => typeof arg === "function") as (() => void) | undefined;
    cb?.();
  };

  process.stdout.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    const scope = active();
    if (scope) {
      scope.stdout += text(chunk);
      callback(args);
      return true;
    }
    const write = state.stdoutOutsideToStderr ? rawStderrWrite : rawStdoutWrite;
    return (write as (...a: unknown[]) => boolean)(chunk, ...args);
  }) as typeof process.stdout.write;

  process.stderr.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    const scope = active();
    if (scope) {
      scope.stderr += text(chunk);
      callback(args);
      return true;
    }
    return (rawStderrWrite as (...a: unknown[]) => boolean)(chunk, ...args);
  }) as typeof process.stderr.write;

  console.log = (...args: unknown[]) => {
    const scope = active();
    if (scope) scope.stdout += `${format(...args)}\n`;
    else rawConsole.log(...args);
  };
  console.info = (...args: unknown[]) => {
    const scope = active();
    if (scope) scope.stdout += `${format(...args)}\n`;
    else rawConsole.info(...args);
  };
  console.warn = (...args: unknown[]) => {
    const scope = active();
    if (scope) scope.stderr += `${format(...args)}\n`;
    else rawConsole.warn(...args);
  };
  console.error = (...args: unknown[]) => {
    const scope = active();
    if (scope) scope.stderr += `${format(...args)}\n`;
    else rawConsole.error(...args);
  };

  process.exit = ((code?: number | string | null) => {
    const scope = active();
    if (scope) return scope.exit(Number(code ?? 0));
    return rawExit(code as number | undefined);
  }) as typeof process.exit;

  process.chdir = (directory: string) => {
    if (storage.getStore()?.forbidChdir) throw new Error(CHDIR_FORBIDDEN);
    rawChdir(directory);
  };

  globals[SCOPE_STATE_KEY] = state;
  return state;
}

/** Runs `fn` inside a fresh scope; the scope closes when `fn` settles. */
export async function runInInvocationScope<T>(
  /** Scope to make active for `fn` and everything it schedules. */
  scope: InvocationScope,
  /** Invocation body. */
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await invocationScopeState().storage.run(scope, fn);
  } finally {
    scope.closed = true;
  }
}

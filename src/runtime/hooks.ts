/*
Safe async hook runner, built-in path detection (hooks skip framework commands),
failure classification, and the invoke error pipeline.
*/

import { InputError } from "../core/leaf-inputs.ts";
import type { InvocationBase, InvocationOutcome } from "../core/invocation.ts";
import type {
  ClientErrorOverride,
  ErrorHookContext,
  InvokeFailureKind,
  InvokeHookContext,
  Locals,
} from "../core/types.ts";
import { SchemaValidationError } from "../core/types.ts";
import { firstErrorLine } from "../http/result.ts";
import { type LogEmitter, obscureUnexpectedClientMessage } from "../log/emitter.ts";
import type { ErrorReporter } from "../log/error-report.ts";
import { ZodError } from "zod";
import type { Capabilities } from "./capabilities.ts";

/** App-owned hook wiring registered for one native bound declaration. */
export interface InvocationHookRegistration {
  /** Fixed declaration path used by hook observers and error reporting. */
  readonly path: readonly string[];
  /** App lifecycle hooks applied to this declaration. */
  readonly hooks: import("../core/types.ts").AppHooks | undefined;
  /** App reporter receiving unexpected hook or handler failures. */
  readonly reporter?: ErrorReporter;
}

/** Hook registration keyed by immutable declaration identity across every native and mirror call. */
const invocationHookRegistrations = new WeakMap<object, InvocationHookRegistration>();

/** Registers app hooks on one native declaration without changing its invocation function. */
export function registerInvocationHooks(
  /** Bound declaration shared by native and mirror adapters. */
  declaration: object,
  /** Fixed app hook wiring for that declaration. */
  registration: InvocationHookRegistration,
): void {
  invocationHookRegistrations.set(declaration, registration);
}

/** Returns the app hook registration for one native bound declaration, if any. */
export function invocationHooksFor(
  /** Bound declaration selected by a native or mirror adapter. */
  declaration: object,
): InvocationHookRegistration | undefined {
  return invocationHookRegistrations.get(declaration);
}

/** Runs app hooks around one exact D2 outcome without invoking the declaration twice. */
export async function runInvocationHookLifecycle<Seed extends object, Result>(
  /** Hook registration retained for the selected declaration. */
  registration: InvocationHookRegistration,
  /** Exact source, signal, surface, and mutable locals for this call. */
  base: InvocationBase<Seed>,
  /** Raw binding supplied to the one D2 parse. */
  rawInputs: unknown,
  /** One invocation of the selected declaration. */
  invoke: () => Promise<InvocationOutcome<Result>>,
  /** Returns output captured at the current invocation checkpoint. */
  captured: () => { readonly stdout: string; readonly stderr: string },
): Promise<InvocationOutcome<Result>> {
  const summary = rawInvokeSummary(rawInputs);
  const hookContext = (): InvokeHookContext => ({
    surface: base.surface,
    signal: base.signal,
    path: [...registration.path],
    rawInputs: summary,
    locals: base.locals,
  });
  let outcome: InvocationOutcome<Result>;
  try {
    await runHook(() => registration.hooks?.beforeInvoke?.(hookContext()), "beforeInvoke");
    outcome = await invoke();
    if (outcome.kind === "ok") {
      await runHook(
        () =>
          registration.hooks?.afterInvoke?.({
            ...hookContext(),
            result: { kind: "ok", exitCode: 0 },
          }),
        "afterInvoke",
      );
      return outcome;
    }
    if (outcome.kind === "denied") return outcome;
    await settleInvocationHookFailure(
      registration,
      hookContext(),
      outcome.kind === "invalid" ? outcome.error : outcome.error,
      classifyFailureKind(outcome.kind === "invalid" ? outcome.error : outcome.error, {
        parseError: outcome.kind === "invalid",
      }),
    );
    return outcome;
  } catch (error) {
    await settleInvocationHookFailure(registration, hookContext(), error, classifyFailureKind(error, {}));
    return { kind: "error", error, ...captured() };
  }
}

/** Runs the error pipeline once while preserving the terminal invocation outcome. */
async function settleInvocationHookFailure(
  /** Hook registration for the selected declaration. */
  registration: InvocationHookRegistration,
  /** Read-only hook context for the failed invocation. */
  hookContext: InvokeHookContext,
  /** Original validation, handler, or hook failure. */
  error: unknown,
  /** Stable classification consumed by hook observers. */
  failureKind: InvokeFailureKind,
): Promise<void> {
  try {
    await runErrorPipeline(
      hookContext,
      error,
      failureKind,
      registration.hooks,
      undefined,
      false,
      registration.reporter,
    );
  } catch {
    // Error hooks are observe-only; their own failures cannot replace the invocation outcome.
  }
}

/** Freezes a raw binding summary while retaining a stable value marker for scalar schemas. */
function rawInvokeSummary(rawInputs: unknown): Readonly<Record<string, unknown>> {
  if (typeof rawInputs === "object" && rawInputs !== null && !Array.isArray(rawInputs)) {
    return Object.freeze({ ...(rawInputs as Record<string, unknown>) });
  }
  return Object.freeze({ value: rawInputs });
}

/** Root command keys owned by argsbarg built-ins. */
const BUILTIN_ROOTS = new Set(["completion", "version", "http", "mcp"]);

/** True when `path` routes to a framework built-in (hooks are skipped). */
export function isBuiltinInvokePath(
  /** Routed command path. */
  path: string[],
  /** Active capabilities; a disabled built-in's name belongs to the app. */
  caps: Capabilities,
): boolean {
  const root = path[0];
  if (!root || !BUILTIN_ROOTS.has(root)) {
    return false;
  }
  if ((root === "completion" && !caps.completion) || (root === "http" && !caps.http) || (root === "mcp" && !caps.mcp)) {
    return false;
  }
  if (root === "http") {
    return path.length <= 1 || path[1] === "serve";
  }
  if (root === "mcp") {
    return path.length <= 1 || path[1] === "serve" || path[1] === "bundle";
  }
  return true;
}

/** Runs a hook without letting hook throws escape uncaught. */
export async function runHook<T>(hook: (() => T | Promise<T>) | undefined, label: string): Promise<T | undefined> {
  if (!hook) {
    return undefined;
  }
  try {
    return await Promise.resolve(hook());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${label} hook failed: ${message}`, { cause: err });
  }
}

/** Classifies an invoke failure for status mapping and logging. */
export function classifyFailureKind(err: unknown, opts: { parseError?: boolean; help?: boolean }): InvokeFailureKind {
  if (opts.help) {
    return "help";
  }
  if (opts.parseError || err instanceof InputError) {
    return "validation";
  }
  if (err instanceof Error) {
    return "validation";
  }
  return "unexpected";
}

/** HTTP status for a classified failure kind. */
export function failureKindHttpStatus(kind: InvokeFailureKind): number {
  switch (kind) {
    case "validation":
    case "help":
      return 400;
    case "unknown_route":
      return 404;
    case "unexpected":
      return 500;
  }
}

/** Builds the read-only bind summary used by native CLI hooks before the sole D2 parse. */
export function buildBoundInvokeHookContext(options: {
  /** Routed command path. */
  readonly path: readonly string[];
  /** Coerced raw values supplied to the one runtime parse. */
  readonly rawInputs: Readonly<Record<string, unknown>>;
  /** Exact signal retained for the invocation. */
  readonly signal: AbortSignal;
  /** Fresh mutable per-call locals shared with D2. */
  readonly locals: Locals;
}): InvokeHookContext {
  return {
    surface: "cli",
    signal: options.signal,
    path: [...options.path],
    rawInputs: Object.freeze({ ...options.rawInputs }),
    locals: options.locals,
  };
}

function defaultClientError(err: unknown, _failureKind: InvokeFailureKind): ClientErrorOverride {
  const message =
    err instanceof Error ? err.message : typeof err === "string" ? err : firstErrorLine(String(err)) || "Error";
  return { message, exitCode: 1 };
}

export interface ErrorPipelineResult {
  failureKind: InvokeFailureKind;
  clientError: ClientErrorOverride;
  errorMsg: string;
}

/**
 * True for failures worth an error report: handler throws and crashes. Bad input, help, unknown
 * routes, cancellations and deliberate `process.exit` calls are the caller's business, not bugs.
 */
function isReportableFailure(
  /** Thrown value. */
  err: unknown,
  /** Classified failure kind. */
  failureKind: InvokeFailureKind,
): boolean {
  if (failureKind === "help" || failureKind === "unknown_route") return false;
  if (err instanceof InputError || err instanceof SchemaValidationError || err instanceof ZodError) return false;
  return !(err instanceof Error && (err.name === "CliInvokeExit" || err.name === "AbortError"));
}

/** Runs formatError → onError → ECS emit for one invoke failure. */
export async function runErrorPipeline(
  hookCtx: InvokeHookContext,
  err: unknown,
  failureKind: InvokeFailureKind,
  hooks: import("../core/types.ts").AppHooks | undefined,
  emitter: LogEmitter | undefined,
  obscureUnexpected: boolean,
  /** App's error reporter; receives unexpected failures only. */
  reporter?: ErrorReporter,
): Promise<ErrorPipelineResult> {
  let clientError = defaultClientError(err, failureKind);
  if (failureKind === "unexpected" && obscureUnexpected) {
    clientError = { message: obscureUnexpectedClientMessage(), exitCode: 1 };
  }

  const errorCtx: ErrorHookContext = {
    ...hookCtx,
    failureKind,
    error: err,
    clientError: { ...clientError },
  };

  const formatted = await runHook(() => hooks?.formatError?.(errorCtx), "formatError");
  if (formatted) {
    clientError = { ...clientError, ...formatted };
    errorCtx.clientError = { ...clientError };
  }

  await runHook(() => hooks?.onError?.(errorCtx), "onError");

  if (reporter && isReportableFailure(err, failureKind)) {
    await reporter.reportError(err, { surface: hookCtx.surface, path: hookCtx.path.join(" ") });
  }

  const displayMessage =
    failureKind === "unexpected" && obscureUnexpected ? obscureUnexpectedClientMessage() : clientError.message;

  emitter?.emitInvokeError(failureKind, err, displayMessage, {
    labels: {
      invocation: hookCtx.surface,
      path: hookCtx.path.join(" "),
    },
    requestId: hookCtx.locals.requestId,
  });

  return { failureKind, clientError, errorMsg: displayMessage };
}

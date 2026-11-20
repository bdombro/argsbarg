/*
Native CLI binding after parser routing.
It coerces argv values and builds one local D2 base without validating or invoking the handler.
*/

import type { z } from "zod";
import type { InvocationBase, NameView } from "../core/invocation.ts";
import { coerceCliLeafInputs } from "../core/leaf-inputs.ts";
import { collectPathOptionDefs, ParseKind, type ParseResult } from "../core/parse.ts";
import type { AppSpec, Locals, RunnableCommand } from "../core/types.ts";
import { runtimeLeafInputSchema } from "../core/zod-schema.ts";

/** Native values ready for one D2 CLI declaration invocation. */
export interface CliBoundCommand<Seed extends object = Locals> {
  /** Exact selected runnable declaration. */
  readonly leaf: RunnableCommand;
  /** One schema parsed by `invokeBound`; the binder never calls it. */
  readonly inputSchema: z.ZodType;
  /** Flat coerced options, positionals, and path values. */
  readonly rawInputs: Readonly<Record<string, unknown>>;
  /** Fresh source, locals, signal, and CLI surface. */
  readonly base: InvocationBase<Seed>;
  /** Routed command path retained for hooks and scoped help. */
  readonly path: readonly string[];
}

/** Dependencies and native parser state for one CLI binding operation. */
export interface CliBindOptions<Seed extends object = Locals> {
  /** Validated app declaration containing the routed leaf. */
  readonly program: AppSpec;
  /** Selected parser leaf. */
  readonly leaf: RunnableCommand;
  /** Successful parser result for argv, options, args, and path captures. */
  readonly parsed: ParseResult;
  /** Optional piped JSON values read before binding. */
  readonly preloadedJson?: Readonly<Record<string, unknown>>;
  /** Exact cancellation signal owned by this call. */
  readonly signal: AbortSignal;
  /** Registered schema reused by every call to this declaration. */
  readonly inputSchema?: z.ZodType;
  /** Fresh locals shared with `beforeInvoke` and D2. */
  readonly locals: Seed;
  /** Optional local environment injection used by tests and embedders. */
  readonly env?: NameView;
}

/** Captures one finite, read-only string environment view without exposing its backing object. */
export function processEnvView(source: NodeJS.ProcessEnv = process.env): NameView {
  const entries = Object.entries(source).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  const snapshot = new Map(entries);
  return Object.freeze({ get: (name: string) => snapshot.get(name) });
}

/** Binds one successful CLI parse into coercion-only raw input plus a local D2 base. */
export function bindCliCommand<Seed extends object = Locals>(
  /** Native parser state and per-call dependencies. */
  options: CliBindOptions<Seed>,
): CliBoundCommand<Seed> {
  if (options.parsed.kind !== ParseKind.Ok) throw new TypeError("CLI binding requires a successful parse");
  const rawInputs = coerceCliLeafInputs({
    program: options.program,
    commandPath: options.parsed.path,
    opts: options.parsed.opts,
    args: options.parsed.args,
    ...(options.preloadedJson === undefined ? {} : { preloadedJson: options.preloadedJson }),
    pathParams: options.parsed.pathParams,
  });
  const inputSchema =
    options.inputSchema ??
    runtimeLeafInputSchema({
      leaf: options.leaf,
      options: collectPathOptionDefs(options.program, options.parsed.path),
      pathNames: Object.keys(options.parsed.pathParams),
    });
  return {
    leaf: options.leaf,
    inputSchema,
    rawInputs,
    base: {
      source: "local",
      env: options.env ?? processEnvView(),
      locals: options.locals,
      signal: options.signal,
      surface: "cli",
    },
    path: [...options.parsed.path],
  };
}

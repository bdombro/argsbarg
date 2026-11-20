/*
Shared runtime for native-bound invocation.
It validates once, runs one typed guard plan, invokes the handler, and captures all terminal output.
*/

import type { z } from "zod";
import type {
  BoundDeclaration,
  CompiledGuard,
  Denial,
  Guard,
  GuardResult,
  InvocationBase,
  InvocationContext,
  InvocationOutcome,
} from "../core/invocation.ts";
import { invocationHooksFor, runInvocationHookLifecycle } from "./hooks.ts";
import { type InvocationScope, runInInvocationScope } from "./invocation-scope.ts";

/** Added locals inferred from a concrete guard's resolved result. */
type AddedLocals<G> = G extends (...args: never[]) => infer R
  ? Awaited<R> extends infer Resolved
    ? Resolved extends { readonly kind: "allow"; readonly locals?: infer Added }
      ? Added extends object
        ? Added
        : never
      : never
    : never
  : never;

/** Detects a value widened to `any`. */
type IsAny<T> = 0 extends 1 & T ? true : false;

/** Shallow merge whose right-hand properties replace matching left-hand properties. */
type MergeLocals<L extends object, R extends object> = [R] extends [never]
  ? L
  : {
      [K in keyof L | keyof R]: K extends keyof R ? R[K] : K extends keyof L ? L[K] : never;
    };

/** Prevents a concrete guard from silently contributing `any` locals. */
type SafeAddedLocals<G> = IsAny<AddedLocals<G>> extends true ? never : unknown;

/** Overloads for D2 supplement, override, and public guard composition. */
interface GuardCompiler<Input, Seed extends object> {
  <const SurfaceGuard extends Guard<Input, Seed, object>, const OverrideGuard extends Guard<Input, Seed, object>>(
    /** Surface default plus an operation replacement. */
    guards: {
      readonly surface?: SurfaceGuard;
      readonly operation: {
        readonly mode: "override";
        readonly run: OverrideGuard;
      };
    } & SafeAddedLocals<SurfaceGuard> &
      SafeAddedLocals<OverrideGuard>,
  ): CompiledGuard<Input, Seed, MergeLocals<Seed, AddedLocals<OverrideGuard>>>;
  <const SurfaceGuard extends Guard<Input, Seed, object>>(
    /** Explicit public operation replacing the surface guard. */
    guards: { readonly surface?: SurfaceGuard; readonly operation: "public" } & SafeAddedLocals<SurfaceGuard>,
  ): CompiledGuard<Input, Seed, Seed>;
  <
    const SurfaceGuard extends Guard<Input, Seed, object>,
    const OperationGuard extends Guard<Input, MergeLocals<Seed, AddedLocals<SurfaceGuard>>, object>,
  >(
    /** Required surface default followed by one required supplement. */
    guards: {
      readonly surface: SurfaceGuard;
      readonly operation: OperationGuard;
    } & SafeAddedLocals<SurfaceGuard> &
      SafeAddedLocals<OperationGuard>,
  ): CompiledGuard<Input, Seed, MergeLocals<MergeLocals<Seed, AddedLocals<SurfaceGuard>>, AddedLocals<OperationGuard>>>;
  <
    const SurfaceGuard extends Guard<Input, Seed, object> = Guard<Input, Seed, Record<never, never>>,
    const OperationGuard extends Guard<Input, MergeLocals<Seed, AddedLocals<SurfaceGuard>>, object> = Guard<
      Input,
      MergeLocals<Seed, AddedLocals<SurfaceGuard>>,
      Record<never, never>
    >,
  >(
    /** Surface default followed by an optional supplement. */
    guards: {
      readonly surface?: SurfaceGuard;
      readonly operation?: OperationGuard;
    } & SafeAddedLocals<SurfaceGuard> &
      SafeAddedLocals<OperationGuard>,
  ): CompiledGuard<Input, Seed, MergeLocals<MergeLocals<Seed, AddedLocals<SurfaceGuard>>, AddedLocals<OperationGuard>>>;
}

/** Runtime callback erased from the public generic compiler surface. */
type RuntimeGuard = (context: { readonly locals: object }) => MaybePromiseGuardResult;

/** Union accepted from a runtime guard callback after generic erasure. */
type MaybePromiseGuardResult = GuardResult<object> | Promise<GuardResult<object>>;

/** Runtime plans keyed by their opaque compiled-plan object identity. */
const runtimePlans = new WeakMap<object, readonly RuntimeGuard[]>();

/** Guard composition modes retained so a later surface guard can respect operation replacement. */
const runtimePlanModes = new WeakMap<object, "public" | "override" | "supplement">();

/** Supplement callbacks retained separately from the prior surface for registry-owned recomposition. */
const runtimePlanOperations = new WeakMap<object, RuntimeGuard | undefined>();

/** Stable denial emitted when a guard returns `false`. */
const DEFAULT_DENIAL: Denial = Object.freeze({ code: "DENIED", message: "Access denied" });

/** Internal thrown marker for process.exit calls inside the invocation. */
class InvocationExit extends Error {
  /** Requested process exit code. */
  readonly code: number;

  /** Creates a marker that does not terminate the process. */
  constructor(code: number) {
    super(`process.exit(${code})`);
    this.name = "InvocationExit";
    this.code = code;
  }
}

/** Creates the package-internal curried guard compiler fixed to validated input and transport-seed types. */
export function compileGuardPlan<Input, Seed extends object>(): GuardCompiler<Input, Seed> {
  /** Compiles guard order into a runtime plan while retaining its opaque type at the call site. */
  const compile = (guards: {
    /** Optional surface default callback. */
    surface?: RuntimeGuard;
    /** Optional operation supplement, replacement, or public marker. */
    operation?: RuntimeGuard | { readonly mode: "override"; readonly run: RuntimeGuard } | "public";
  }): object => {
    const plan = Object.freeze({});
    if (guards.operation === "public") {
      runtimePlans.set(plan, []);
      runtimePlanModes.set(plan, "public");
      runtimePlanOperations.set(plan, undefined);
    } else if (typeof guards.operation === "object") {
      runtimePlans.set(plan, [guards.operation.run]);
      runtimePlanModes.set(plan, "override");
      runtimePlanOperations.set(plan, guards.operation.run);
    } else {
      runtimePlans.set(
        plan,
        [guards.surface, guards.operation].filter((guard): guard is RuntimeGuard => guard !== undefined),
      );
      runtimePlanModes.set(plan, "supplement");
      runtimePlanOperations.set(plan, guards.operation);
    }
    return plan;
  };
  return compile as GuardCompiler<Input, Seed>;
}

/** Adds one new surface guard before an existing supplement plan without defeating override/public operations. */
export function composeGuardPlanSurface<Input, Seed extends object, Final extends object>(
  /** Existing operation-aware guard plan retained by a registered declaration. */
  plan: CompiledGuard<Input, Seed, Final>,
  /** Newly supplied surface guard to prepend for supplement plans. */
  surface: Guard<Input, Seed, object> | undefined,
): CompiledGuard<Input, Seed, Final> {
  const composed = Object.freeze({});
  const existing = runtimePlans.get(plan);
  const mode = runtimePlanModes.get(plan);
  if (existing === undefined || mode === undefined || !runtimePlanOperations.has(plan)) {
    throw new TypeError("Invalid compiled invocation guard plan");
  }
  const runtimeSurface = surface as RuntimeGuard | undefined;
  const operation = runtimePlanOperations.get(plan);
  runtimePlans.set(
    composed,
    mode === "supplement" && runtimeSurface !== undefined
      ? [runtimeSurface, ...(operation === undefined ? [] : [operation])]
      : [...existing],
  );
  runtimePlanModes.set(composed, mode);
  runtimePlanOperations.set(composed, operation);
  return composed as CompiledGuard<Input, Seed, Final>;
}

/** Invokes one registered declaration through validation, serial guards, and handler execution. */
export async function invokeBound<
  InputSchema extends z.ZodType,
  Result,
  Locals extends object,
  Seed extends object = Locals,
  Handler extends (
    context: InvocationContext<z.output<InputSchema>, Locals>,
  ) => import("../core/invocation.ts").MaybePromise<Result> = (
    context: InvocationContext<z.output<InputSchema>, Locals>,
  ) => import("../core/invocation.ts").MaybePromise<Result>,
>(request: {
  /** Registered declaration and compiled plan. */
  declaration: BoundDeclaration<InputSchema, Result, Locals, Seed, Handler>;
  /** Raw values supplied by the native binder. */
  rawInputs: unknown;
  /** Per-call source, seed locals, cancellation, and surface. */
  base: InvocationBase<Seed>;
  /** Package-internal option preventing process cwd mutation in overlapping MCP calls. */
  forbidChdir?: boolean;
}): Promise<InvocationOutcome<Result>> {
  const scope: InvocationScope = {
    stdout: "",
    stderr: "",
    exit: (code) => {
      throw new InvocationExit(code);
    },
    forbidChdir: request.forbidChdir ?? false,
    closed: false,
    metadata: { source: request.base.source, surface: request.base.surface },
    signal: request.base.signal,
  };

  /** Returns a copy of captured output at the current terminal checkpoint. */
  const output = () => ({ stdout: scope.stdout, stderr: scope.stderr });

  /** Wraps non-validation failures without flattening their thrown values. */
  const failure = (error: unknown): InvocationOutcome<Result> => ({ kind: "error", error, ...output() });

  try {
    return await runInInvocationScope(scope, async () => {
      const invokeOnce = async (): Promise<InvocationOutcome<Result>> => {
        try {
          request.base.signal.throwIfAborted();
          const parsed = request.declaration.inputSchema.safeParse(request.rawInputs);
          request.base.signal.throwIfAborted();
          if (!parsed.success) {
            return { kind: "invalid", error: parsed.error, ...output() };
          }

          const locals = { ...request.base.locals } as Seed & Locals;
          const context = {
            ...request.base,
            inputs: parsed.data,
            locals,
          } as InvocationContext<z.output<InputSchema>, Locals>;
          const plan = runtimePlans.get(request.declaration.guardPlan);
          if (plan === undefined) throw new TypeError("Invalid compiled invocation guard plan");

          for (const guard of plan) {
            request.base.signal.throwIfAborted();
            const result = await guard(context);
            request.base.signal.throwIfAborted();
            if (result === false) return { kind: "denied", denial: DEFAULT_DENIAL, ...output() };
            if (result === true) continue;
            if (result.kind === "deny") return { kind: "denied", denial: result.denial, ...output() };
            if (result.locals !== undefined) Object.assign(locals, result.locals);
          }

          request.base.signal.throwIfAborted();
          const result = await request.declaration.handler(context);
          return { kind: "ok", result, ...output() };
        } catch (error) {
          return failure(error);
        }
      };
      const hooks = invocationHooksFor(request.declaration);
      if (hooks !== undefined) {
        return runInvocationHookLifecycle(hooks, request.base, request.rawInputs, invokeOnce, output);
      }
      return invokeOnce();
    });
  } catch (error) {
    return failure(error);
  }
}

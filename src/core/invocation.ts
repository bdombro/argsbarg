/*
Shared transport-neutral contracts for native-bound invocation.
Adapters bind wire-local values to these types; the shared runtime owns validation and execution.
*/

import type { z } from "zod";

/** A source-owned, name-oriented view that never exposes its backing credential store. */
export interface NameView {
  /** Returns the value for `name`, or `undefined` when the source does not contain it. */
  get(name: string): string | undefined;
}

/** Exactly one credential source for a call, with no local/HTTP fallback. */
export type InvocationSource =
  | {
      /** Selects the process-local environment source. */
      readonly source: "local";
      /** Local environment name view exposed to guards and handlers. */
      readonly env: NameView;
      /** Prevents HTTP headers from appearing in a local invocation. */
      readonly headers?: never;
    }
  | {
      /** Selects the request-owned HTTP header source. */
      readonly source: "http";
      /** HTTP header name view exposed to guards and handlers. */
      readonly headers: NameView;
      /** Prevents process-local environment values from appearing in an HTTP invocation. */
      readonly env?: never;
    };

/** Native application surface that bound this invocation. */
export type Surface = "cli" | "http" | "jsonRpc" | "mcp";

/** Per-call locals, cancellation, source, and surface fixed before guard evaluation. */
export type InvocationBase<Locals extends object> = {
  /** Fresh transport or mount locals for this invocation. */
  readonly locals: Locals;
  /** Cooperative cancellation signal retained by reference. */
  readonly signal: AbortSignal;
  /** Surface requesting invocation. */
  readonly surface: Surface;
} & InvocationSource;

/** Validated inputs plus source/locals/cancellation context shared by every guard and handler. */
export type InvocationContext<Input, Locals extends object> = InvocationBase<Locals> & {
  /** Zod-parsed input value, including defaults and transforms. */
  readonly inputs: Input;
};

/** Structured access denial with optional native transport metadata. */
export type Denial = {
  /** Stable denial code for application and transport use. */
  readonly code: string;
  /** Human-readable denial message. */
  readonly message: string;
  /** Optional HTTP response metadata. */
  readonly http?: {
    /** Optional HTTP status. */
    readonly status?: number;
    /** Optional HTTP response headers. */
    readonly headers?: Readonly<Record<string, string>>;
  };
  /** Optional bearer authentication challenge metadata. */
  readonly challenge?: {
    /** Required challenge scheme. */
    readonly scheme: "bearer";
    /** Optional bearer error category. */
    readonly error?: "invalid_token" | "insufficient_scope";
    /** Optional retry scopes. */
    readonly scopes?: readonly string[];
  };
};

/** A guard continuation, typed locals addition, or structured denial. */
export type GuardResult<Added extends object = Record<never, never>> =
  | boolean
  | {
      /** Identifies a continuation with optional typed locals. */
      readonly kind: "allow";
      /** Locals shallow-merged before the next guard. */
      readonly locals?: Added;
    }
  | {
      /** Identifies a terminal structured denial. */
      readonly kind: "deny";
      /** Denial returned unchanged in the terminal outcome. */
      readonly denial: Denial;
    };

/** A synchronous or asynchronous value accepted from guards and handlers. */
export type MaybePromise<T> = T | Promise<T>;

/** Guard evaluated against the currently accumulated locals. */
export type Guard<Input, Current extends object, Added extends object = Record<never, never>> = (
  /** Validated context visible at this guard stage. */
  context: InvocationContext<Input, Current>,
) => MaybePromise<GuardResult<Added>>;

/** An operation guard supplements, replaces, or publicly replaces its surface default. */
export type OperationGuard<G> =
  | G
  | {
      /** Selects operation-owned replacement of the surface default. */
      readonly mode: "override";
      /** Replacement guard run in the surface guard's place. */
      readonly run: G;
    }
  | "public";

/** True exactly when `T` has widened to `any`. */
type IsAny<T> = 0 extends 1 & T ? true : false;

/** True when `T` has widened to `unknown` but not `any`. */
type IsUnknown<T> = unknown extends T ? (IsAny<T> extends true ? false : true) : false;

/** The concrete parameter type of a handler callback. */
type HandlerContext<Handler extends (...args: never[]) => unknown> = Parameters<Handler>[0];

/** Rejects a handler whose concrete context was explicitly widened to `any` or `unknown`. */
type StrictHandler<Handler extends (...args: never[]) => unknown> =
  IsAny<HandlerContext<Handler>> extends true
    ? never
    : IsUnknown<HandlerContext<Handler>> extends true
      ? never
      : Handler;

/** Runtime-erased marker for a guard plan compiled with specific input and locals stages. */
declare const compiledGuard: unique symbol;

/** Opaque compiled guard plan preserving its inferred locals evolution. */
export interface CompiledGuard<Input, Seed extends object, Final extends object> {
  /** Type-only witnesses for the plan's input, seed, and final locals. */
  readonly [compiledGuard]: {
    /** Input identity witness. */
    readonly input: (value: Input) => Input;
    /** Seed-locals identity witness. */
    readonly seed: (value: Seed) => Seed;
    /** Final-locals identity witness. */
    readonly final: (value: Final) => Final;
  };
}

/** Native-bound declaration consumed by the shared invocation runner. */
export interface BoundDeclaration<
  InputSchema extends z.ZodType,
  Result,
  Locals extends object,
  Seed extends object = Locals,
  Handler extends (context: InvocationContext<z.output<InputSchema>, Locals>) => MaybePromise<Result> = (
    context: InvocationContext<z.output<InputSchema>, Locals>,
  ) => MaybePromise<Result>,
> {
  /** Schema parsed once before any guard or handler. */
  readonly inputSchema: InputSchema;
  /** Compiled guard plan from the declaration compiler. */
  readonly guardPlan: CompiledGuard<z.output<InputSchema>, Seed, Locals>;
  /** Handler receiving parsed inputs and the final evolved locals. */
  handler: Handler & StrictHandler<Handler>;
}

/** Transport-neutral terminal outcome, including captured process output. */
export type InvocationOutcome<Result> =
  | {
      /** Identifies a successful handler result. */
      readonly kind: "ok";
      /** Handler value preserved without transport encoding. */
      readonly result: Result;
      /** Captured stdout at settlement. */
      readonly stdout: string;
      /** Captured stderr at settlement. */
      readonly stderr: string;
    }
  | {
      /** Identifies a guard denial. */
      readonly kind: "denied";
      /** Structured denial that short-circuited the handler. */
      readonly denial: Denial;
      /** Captured stdout at denial. */
      readonly stdout: string;
      /** Captured stderr at denial. */
      readonly stderr: string;
    }
  | {
      /** Identifies invalid raw input. */
      readonly kind: "invalid";
      /** Original Zod validation error from the single parse. */
      readonly error: z.ZodError;
      /** Captured stdout before validation settled. */
      readonly stdout: string;
      /** Captured stderr before validation settled. */
      readonly stderr: string;
    }
  | {
      /** Identifies a thrown guard, handler, schema, or cancellation value. */
      readonly kind: "error";
      /** Original thrown value retained for native transport encoding. */
      readonly error: unknown;
      /** Captured stdout before failure. */
      readonly stdout: string;
      /** Captured stderr before failure. */
      readonly stderr: string;
    };

/** Returns a guard continuation without locals. */
export function allow(): {
  /** Identifies a continuation without added locals. */
  kind: "allow";
};
/** Returns a guard continuation that shallow-merges precisely typed locals. */
export function allow<const Added extends object>(
  /** Locals to merge before the next guard. */
  locals: Added,
): {
  /** Identifies a continuation with typed locals. */
  kind: "allow";
  /** Locals shallow-merged before the next guard. */
  locals: Added;
};
/** Implements both typed allow forms. */
export function allow<const Added extends object>(
  locals?: Added,
): {
  /** Identifies a successful guard continuation. */
  kind: "allow";
  /** Optional locals shallow-merged before the next guard. */
  locals?: Added;
} {
  return locals === undefined ? { kind: "allow" } : { kind: "allow", locals };
}

/** Returns a structured denial that stops later guards and the handler. */
export function deny(
  /** Denial carried unchanged into the terminal outcome. */
  denial: Denial,
): {
  /** Identifies a terminal guard denial. */
  kind: "deny";
  /** Structured denial returned through the invocation outcome. */
  denial: Denial;
} {
  return { kind: "deny", denial };
}

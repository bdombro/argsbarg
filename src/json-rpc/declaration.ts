/*
Typed JSON-RPC method declarations.
The identity builder preserves Zod input/output inference without exposing compiled invocation state.
*/

import type { z } from "zod";
import type { Guard, InvocationContext, MaybePromise, OperationGuard } from "../core/invocation.ts";

/** Type of a handler result inferred from an optional output schema. */
export type JsonRpcResultOf<OutputSchema> = OutputSchema extends z.ZodType ? z.output<OutputSchema> : unknown;

/** Author-facing shape accepted by the JSON-RPC method identity builder. */
export interface JsonRpcMethodSpec<
  Locals extends object,
  InputSchema extends z.ZodType,
  OutputSchema extends z.ZodType | undefined,
> {
  /** Exact, case-sensitive wire method name. */
  readonly name: string;
  /** Human-readable method description. */
  readonly description: string;
  /** Optional short discovery summary. */
  readonly summary?: string;
  /** Schema parsed by the shared invocation runner. */
  readonly inputSchema: InputSchema;
  /** Optional result schema used for typing and discovery. */
  readonly outputSchema?: OutputSchema;
  /** Required, unique names for a fixed tuple input root. */
  readonly paramNames?: readonly string[];
  /** Optional operation-owned guard supplement, replacement, or public marker. */
  readonly guard?: OperationGuard<Guard<z.output<InputSchema>, Locals, object>>;
  /** Handler receiving parsed native inputs and the declaration's final locals. */
  handler(context: InvocationContext<z.output<InputSchema>, Locals>): MaybePromise<JsonRpcResultOf<OutputSchema>>;
}

/** Runtime and type-only identity carried only by declarations returned from {@link method}. */
const methodIdentity: unique symbol = Symbol("argsbarg.json-rpc.method");

/** Catalog-safe authored declaration returned from the public identity builder. */
export interface JsonRpcMethod<
  Locals extends object = object,
  InputSchema extends z.ZodType = z.ZodType,
  OutputSchema extends z.ZodType | undefined = z.ZodType | undefined,
> extends JsonRpcMethodSpec<Locals, InputSchema, OutputSchema> {
  /** Proves that the declaration passed through the identity builder. */
  readonly [methodIdentity]: true;
}

/** Erased authored metadata accepted by the heterogeneous catalog constructor. */
export interface JsonRpcMethodMetadata {
  /** Exact method name retained for lookup and discovery. */
  readonly name: string;
  /** Human-readable method description. */
  readonly description: string;
  /** Optional short discovery summary. */
  readonly summary?: string;
  /** Input schema retained for D2 validation and OpenRPC input mapping. */
  readonly inputSchema: z.ZodType;
  /** Optional output schema retained for typing and OpenRPC discovery. */
  readonly outputSchema?: z.ZodType;
  /** Optional fixed tuple parameter names. */
  readonly paramNames?: readonly string[];
  /** Runtime-erased authored operation guard. */
  readonly guard?: unknown;
  /** Runtime-erased handler; concrete declaration typing is fixed by {@link method}. */
  readonly handler: unknown;
  /** Proves that catalog input came from {@link method}. */
  readonly [methodIdentity]: true;
}

/** Returns true only for an authored value that passed through the identity builder. */
export function isJsonRpcMethod(
  /** Candidate catalog declaration. */
  value: unknown,
): value is JsonRpcMethodMetadata {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Partial<Record<typeof methodIdentity, unknown>>)[methodIdentity] === true
  );
}

/**
 * Creates one identity builder fixed to the declaration's concrete final locals.
 * The second call preserves Zod schema inference independently of the surrounding heterogeneous array.
 */
export function method<Locals extends object = object>(): <
  const InputSchema extends z.ZodType,
  const OutputSchema extends z.ZodType | undefined = undefined,
>(
  spec: JsonRpcMethodSpec<Locals, InputSchema, OutputSchema>,
) => JsonRpcMethod<Locals, InputSchema, OutputSchema> {
  return <const InputSchema extends z.ZodType, const OutputSchema extends z.ZodType | undefined = undefined>(
    spec: JsonRpcMethodSpec<Locals, InputSchema, OutputSchema>,
  ): JsonRpcMethod<Locals, InputSchema, OutputSchema> =>
    Object.freeze({
      ...spec,
      ...(spec.paramNames === undefined ? {} : { paramNames: Object.freeze([...spec.paramNames]) }),
      [methodIdentity]: true as const,
    });
}

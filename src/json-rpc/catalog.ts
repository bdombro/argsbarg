/*
Immutable JSON-RPC method registration and exact lookup.
Catalog creation binds every authored method to the shared D2 invocation runner and validates OpenRPC once.
*/

import type { z } from "zod";
import type {
  BoundDeclaration,
  Guard,
  InvocationBase,
  InvocationContext,
  InvocationOutcome,
  MaybePromise,
} from "../core/invocation.ts";
import { compileGuardPlan, invokeBound } from "../runtime/invoke.ts";
import { isJsonRpcMethod, type JsonRpcMethodMetadata } from "./declaration.ts";
import { type PreparedOpenRpcMethod, prepareOpenRpcMethod } from "./openrpc.ts";

/** Runtime-erased D2 declaration stored behind one catalog entry. */
type CatalogBoundDeclaration<Seed extends object> = BoundDeclaration<
  z.ZodType,
  unknown,
  object,
  Seed,
  (context: InvocationContext<unknown, object>) => MaybePromise<unknown>
>;

/** One fixed, authored and bound JSON-RPC registration. */
export interface JsonRpcCatalogEntry<Seed extends object = object> {
  /** Original immutable declaration metadata. */
  readonly method: JsonRpcMethodMetadata;
  /** D2 declaration used by native dispatch. */
  readonly declaration: CatalogBoundDeclaration<Seed>;
  /** Catalog-validated OpenRPC projection. */
  readonly openRpc: PreparedOpenRpcMethod;
}

/** Fixed registration array plus exact-name lookup for dispatch and discovery. */
export interface JsonRpcCatalog<Seed extends object = object> {
  /** Stable registration order. */
  readonly methods: readonly JsonRpcCatalogEntry<Seed>[];
  /** Returns the exactly matching registered method, or `undefined`. */
  get(name: string): JsonRpcCatalogEntry<Seed> | undefined;
}

/** Options for one side-effect-free, fixed JSON-RPC catalog construction. */
export interface JsonRpcCatalogOptions<Seed extends object> {
  /** Authored declarations in stable discovery/registration order. */
  readonly methods: readonly JsonRpcMethodMetadata[];
  /** Optional default guard run before an operation guard. */
  readonly guard?: Guard<unknown, Seed, object>;
  /** Per-registration guards used by mounted child declarations. */
  readonly guardsByRegistration?: ReadonlyMap<
    JsonRpcMethodMetadata,
    Guard<unknown, Seed, object> | undefined
  >;
  /** Optional package-runtime wrapper applied around one registered method invocation. */
  readonly decorateInvoke?: (
    /** Authored method selected by exact lookup. */
    method: JsonRpcMethodMetadata,
    /** Concrete bound invocation for that method. */
    invoke: (rawInputs: unknown, base: InvocationBase<Seed>) => Promise<InvocationOutcome<unknown>>,
    /** Raw structured RPC params. */
    rawInputs: unknown,
    /** Exact request source, signal, and seed locals. */
    base: InvocationBase<Seed>,
  ) => Promise<InvocationOutcome<unknown>>;
}

/** Bound invocation closures retained without changing catalog lookup metadata. */
const jsonRpcInvocations = new WeakMap<
  object,
  (rawInputs: unknown, base: InvocationBase<object>) => Promise<InvocationOutcome<unknown>>
>();

/** Validates the DP-22 exact method-name profile. */
function validateMethodName(name: unknown): asserts name is string {
  const containsControl =
    typeof name === "string" &&
    [...name].some((character) => {
      const point = character.codePointAt(0);
      return point !== undefined && (point <= 31 || (point >= 127 && point <= 159));
    });
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name.trim() !== name ||
    containsControl ||
    name.startsWith("rpc.")
  ) {
    throw new TypeError(`Invalid JSON-RPC method name ${JSON.stringify(name)}`);
  }
}

/** Compiles one erased catalog declaration using the accepted D2 runtime plan. */
function bindMethod<Seed extends object>(
  /** Authored identity-builder declaration. */
  method: JsonRpcMethodMetadata,
  /** Optional surface-wide default guard. */
  surfaceGuard: Guard<unknown, Seed, object> | undefined,
): CatalogBoundDeclaration<Seed> {
  const compiler = compileGuardPlan<unknown, Seed>();
  const operation = method.guard as
    | Guard<unknown, object, object>
    | { readonly mode: "override"; readonly run: Guard<unknown, object, object> }
    | "public"
    | undefined;
  const runtimeSurface = surfaceGuard as Guard<unknown, Seed, object> | undefined;
  const guardPlan =
    operation === undefined
      ? compiler({ surface: runtimeSurface })
      : operation === "public" || typeof operation === "object"
        ? compiler({ surface: runtimeSurface, operation: operation as never })
        : compiler({ surface: runtimeSurface, operation: operation as never });
  const handler = method.handler as (context: InvocationContext<unknown, object>) => MaybePromise<unknown>;
  return {
    inputSchema: method.inputSchema,
    guardPlan,
    handler,
  } as CatalogBoundDeclaration<Seed>;
}

/** Creates an immutable JSON-RPC catalog and rejects duplicate or unrepresentable methods immediately. */
export function createJsonRpcCatalog<Seed extends object = object>(
  options: JsonRpcCatalogOptions<Seed>,
): JsonRpcCatalog<Seed> {
  const names = new Set<string>();
  const entries = options.methods.map((method) => {
    if (!isJsonRpcMethod(method)) {
      throw new TypeError("JSON-RPC catalog methods must be created with method()");
    }
    validateMethodName(method.name);
    if (names.has(method.name)) {
      throw new TypeError(`Duplicate JSON-RPC method name ${JSON.stringify(method.name)}`);
    }
    names.add(method.name);
    const openRpc = prepareOpenRpcMethod(method);
    const surfaceGuard =
      options.guardsByRegistration?.has(method) === true
        ? options.guardsByRegistration.get(method)
        : options.guard;
    const declaration = bindMethod(method, surfaceGuard);
    const entry = Object.freeze({
      method,
      declaration,
      openRpc,
    });
    const invoke = (
      rawInputs: unknown,
      base: InvocationBase<Seed>,
    ): Promise<InvocationOutcome<unknown>> =>
      invokeBound({ declaration, rawInputs, base });
    jsonRpcInvocations.set(
      entry,
      (rawInputs, base) =>
        options.decorateInvoke === undefined
          ? invoke(rawInputs, base as InvocationBase<Seed>)
          : options.decorateInvoke(method, invoke, rawInputs, base as InvocationBase<Seed>),
    );
    return entry;
  });
  Object.freeze(entries);
  const lookup = new Map(entries.map((entry) => [entry.method.name, entry]));
  return Object.freeze({
    methods: entries,
    get(name: string) {
      return lookup.get(name);
    },
  });
}

/** Invokes one catalog method through its startup-selected declaration wrapper. */
export function invokeRegisteredJsonRpcMethod<Seed extends object>(
  /** Bound catalog entry selected by exact method lookup. */
  entry: JsonRpcCatalogEntry<Seed>,
  /** Raw native params passed unchanged to D2. */
  rawInputs: unknown,
  /** Exact request source, signal, and seed locals. */
  base: InvocationBase<Seed>,
): Promise<InvocationOutcome<unknown>> {
  const invoke = jsonRpcInvocations.get(entry);
  if (invoke === undefined) throw new TypeError("Invalid JSON-RPC catalog registration");
  return invoke(rawInputs, base);
}

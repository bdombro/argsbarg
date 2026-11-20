/*
OpenRPC 1.3.2 discovery generated from one registered JSON-RPC catalog.
It maps native object and fixed-tuple input roots and rejects unrepresentable schemas.
*/

import type { JsonSchema } from "../core/types.ts";
import { toJsonSchema } from "../core/zod-schema.ts";
import type { JsonRpcCatalog } from "./catalog.ts";
import type { JsonRpcMethodMetadata } from "./declaration.ts";

/** Application identity embedded in an OpenRPC document. */
export interface OpenRpcAppInfo {
  /** Stable application title. */
  readonly title: string;
  /** Application version. */
  readonly version: string;
  /** Optional human-readable application description. */
  readonly description?: string;
}

/** One prepared OpenRPC parameter descriptor. */
export interface PreparedOpenRpcParam {
  /** Native parameter name. */
  readonly name: string;
  /** Whether the input schema requires this slot. */
  readonly required: boolean;
  /** Dereferenced JSON Schema for this parameter. */
  readonly schema: JsonSchema;
}

/** Catalog-time OpenRPC projection for one method. */
export interface PreparedOpenRpcMethod {
  /** Whether parameters are supplied by property name or tuple position. */
  readonly paramStructure: "by-name" | "by-position";
  /** Stable ordered native parameter descriptors. */
  readonly params: readonly PreparedOpenRpcParam[];
  /** Dereferenced output schema, or an unconstrained schema when none was declared. */
  readonly resultSchema: JsonSchema;
}

/** Standard and JSON-RPC-profile errors listed on every method. */
const OPEN_RPC_ERRORS = Object.freeze([
  { code: -32700, message: "Parse error" },
  { code: -32600, message: "Invalid Request" },
  { code: -32601, message: "Method not found" },
  { code: -32602, message: "Invalid params" },
  { code: -32603, message: "Internal error" },
  { code: -32001, message: "Access denied" },
  { code: -32000, message: "Application error" },
]);

/** Returns a resolved JSON Pointer target for a local OpenRPC schema reference. */
function resolveLocalPointer(
  /** Complete emitted schema document. */
  root: JsonSchema,
  /** Local JSON Pointer beginning with `#/`. */
  pointer: string,
): unknown {
  if (!pointer.startsWith("#/")) {
    throw new TypeError(`OpenRPC does not support external schema reference ${JSON.stringify(pointer)}`);
  }
  let current: unknown = root;
  for (const raw of pointer.slice(2).split("/")) {
    const segment = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (typeof current !== "object" || current === null || Array.isArray(current) || !(segment in current)) {
      throw new TypeError(`OpenRPC schema reference is unresolved: ${pointer}`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Deeply dereferences local schema nodes while rejecting circular and external references. */
function dereferenceValue(
  /** Current schema value. */
  value: unknown,
  /** Complete emitted schema document. */
  root: JsonSchema,
  /** References currently on this resolution branch. */
  resolving: ReadonlySet<string>,
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => dereferenceValue(entry, root, resolving));
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.$ref === "string") {
    if (resolving.has(record.$ref)) {
      throw new TypeError(`OpenRPC schema reference is circular: ${record.$ref}`);
    }
    const target = dereferenceValue(resolveLocalPointer(root, record.$ref), root, new Set([...resolving, record.$ref]));
    const siblings = Object.fromEntries(
      Object.entries(record)
        .filter(([key]) => key !== "$ref")
        .map(([key, child]) => [key, dereferenceValue(child, root, resolving)]),
    );
    if (typeof target !== "object" || target === null || Array.isArray(target)) {
      if (Object.keys(siblings).length > 0) {
        throw new TypeError("OpenRPC cannot combine a non-object schema reference with sibling keywords");
      }
      return target;
    }
    return { ...(target as Record<string, unknown>), ...siblings };
  }

  return Object.fromEntries(
    Object.entries(record)
      .filter(([key]) => key !== "$schema" && key !== "$id" && key !== "$defs" && key !== "definitions")
      .map(([key, child]) => [key, dereferenceValue(child, root, resolving)]),
  );
}

/** Emits and strictly dereferences a Zod schema for one OpenRPC descriptor side. */
function emitSchema(
  /** Zod schema retained by the authored declaration. */
  schema: NonNullable<JsonRpcMethodMetadata["inputSchema"]>,
  /** Whether the schema is used as native input or handler output. */
  io: "input" | "output",
): JsonSchema {
  const emitted = toJsonSchema(schema, io) as JsonSchema;
  const dereferenced = dereferenceValue(emitted, emitted, new Set());
  if (typeof dereferenced !== "object" || dereferenced === null || Array.isArray(dereferenced)) {
    throw new TypeError("OpenRPC schema root must be a JSON object");
  }
  return dereferenced as JsonSchema;
}

/** Validates the strict object-root input mapping and prepares property descriptors. */
function prepareObjectParams(
  /** Dereferenced input schema. */
  schema: JsonSchema,
): PreparedOpenRpcMethod {
  if (schema.type !== "object" || schema.additionalProperties !== false) {
    throw new TypeError("OpenRPC JSON-RPC input objects must declare additionalProperties: false");
  }
  if (typeof schema.properties !== "object" || schema.properties === null || Array.isArray(schema.properties)) {
    throw new TypeError("OpenRPC JSON-RPC input object must have named properties");
  }
  const required = new Set(
    Array.isArray(schema.required) ? schema.required.filter((entry): entry is string => typeof entry === "string") : [],
  );
  const params = Object.entries(schema.properties as Record<string, unknown>).map(([name, value]) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TypeError(`OpenRPC input property ${JSON.stringify(name)} is not a schema object`);
    }
    return { name, required: required.has(name), schema: value as JsonSchema };
  });
  return { paramStructure: "by-name", params, resultSchema: {} };
}

/** Validates one fixed tuple root and its authored positional names. */
function prepareTupleParams(
  /** Authored method metadata used for tuple names. */
  method: JsonRpcMethodMetadata,
  /** Dereferenced tuple input schema. */
  schema: JsonSchema,
): PreparedOpenRpcMethod {
  if (!Array.isArray(schema.prefixItems) || schema.minItems === undefined) {
    throw new TypeError("OpenRPC tuple input must contain fixed prefixItems and minItems");
  }
  if (schema.items !== false && schema.maxItems !== schema.prefixItems.length) {
    throw new TypeError("OpenRPC does not represent variadic or unbounded tuple inputs");
  }
  const names = method.paramNames;
  if (names === undefined || names.length !== schema.prefixItems.length) {
    throw new TypeError(`OpenRPC tuple method ${JSON.stringify(method.name)} requires one paramNames entry per slot`);
  }
  const seen = new Set<string>();
  for (const name of names) {
    if (name.trim() !== name || name.length === 0 || seen.has(name)) {
      throw new TypeError(`OpenRPC tuple method ${JSON.stringify(method.name)} has invalid or duplicate paramNames`);
    }
    seen.add(name);
  }
  const minItems = schema.minItems;
  if (!Number.isInteger(minItems) || (minItems as number) < 0 || (minItems as number) > names.length) {
    throw new TypeError("OpenRPC tuple minItems must be a fixed prefix length");
  }
  return {
    paramStructure: "by-position",
    params: schema.prefixItems.map((value, index) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new TypeError(`OpenRPC tuple input slot ${index} is not a schema object`);
      }
      return { name: names[index] ?? "", required: index < (minItems as number), schema: value as JsonSchema };
    }),
    resultSchema: {},
  };
}

/** Prepares and validates one method's OpenRPC schema projection during catalog registration. */
export function prepareOpenRpcMethod(method: JsonRpcMethodMetadata): PreparedOpenRpcMethod {
  const input = emitSchema(method.inputSchema, "input");
  const inputProjection =
    input.type === "object"
      ? prepareObjectParams(input)
      : input.type === "array" && Array.isArray(input.prefixItems)
        ? prepareTupleParams(method, input)
        : (() => {
            throw new TypeError(
              `OpenRPC method ${JSON.stringify(method.name)} requires a strict object or fixed tuple input root`,
            );
          })();
  if (method.paramNames !== undefined && inputProjection.paramStructure !== "by-position") {
    throw new TypeError(`OpenRPC method ${JSON.stringify(method.name)} permits paramNames only for fixed tuples`);
  }
  return {
    ...inputProjection,
    resultSchema: method.outputSchema === undefined ? {} : emitSchema(method.outputSchema, "output"),
  };
}

/** Produces one pure OpenRPC 1.3.2 document in the catalog's stable registration order. */
export function generateOpenRpc<Seed extends object>(
  catalog: JsonRpcCatalog<Seed>,
  appInfo: OpenRpcAppInfo,
): Record<string, unknown> {
  return {
    openrpc: "1.3.2",
    info: {
      title: appInfo.title,
      version: appInfo.version,
      ...(appInfo.description === undefined ? {} : { description: appInfo.description }),
    },
    methods: catalog.methods.map(({ method, openRpc }) => ({
      name: method.name,
      ...(method.summary === undefined ? {} : { summary: method.summary }),
      description: method.description,
      paramStructure: openRpc.paramStructure,
      params: openRpc.params.map((param) => ({
        name: param.name,
        required: param.required,
        schema: param.schema,
      })),
      result: { name: "result", schema: openRpc.resultSchema },
      errors: OPEN_RPC_ERRORS.map((entry) => ({ ...entry })),
    })),
  };
}

/*
Schema adapter: the single boundary between argsbarg and Zod.
Emits JSON Schema (draft 2020-12) for MCP, OpenAPI, help, and schema export, and validates data with
human-readable, path-prefixed error messages. Nothing else in argsbarg imports zod at runtime.
*/

import { z } from "zod";
import { resolveJsonPointer } from "./json-pointer.ts";
import type { CommandOption, JsonSchema, RunnableCommand } from "./types.ts";
import { OptionKind, ValueFormat } from "./types.ts";

/** Which side of a schema to emit: what callers send (`input`) or what the schema produces (`output`). */
export type SchemaIo = "input" | "output";

/** Result of {@link validateWithSchema}; `value` is the parsed output (defaults and transforms applied). */
export type SchemaValidateResult = { valid: true; value: unknown; errors: [] } | { valid: false; errors: string[] };

/** Maximum number of errors reported before collapsing the remainder into a count. */
const MAX_ERRORS = 10;

/** Emitted JSON Schema memo per schema instance and `io` side (help, MCP, and OpenAPI re-read schemas often). */
const emitted = new WeakMap<z.ZodType, Partial<Record<SchemaIo, JsonSchema>>>();

/**
 * True when `value` is a Zod 4 schema. Duck-typed (not `instanceof`) so schemas built with a different
 * copy of zod in the same process still count.
 */
export function isZodSchema(
  /** Candidate schema value from program config. */
  value: unknown,
): value is z.ZodType {
  return (
    typeof value === "object" &&
    value !== null &&
    "_zod" in value &&
    typeof (value as { safeParse?: unknown }).safeParse === "function"
  );
}

/** True when `value` is a Zod object schema (has a `shape`). */
export function isZodObjectSchema(
  /** Candidate schema value from program config. */
  value: unknown,
): value is z.ZodObject {
  return isZodSchema(value) && (value as { _zod: { def: { type?: string } } })._zod.def.type === "object";
}

/**
 * Emits the JSON Schema for `schema` (draft 2020-12). Throws when the schema contains constructs JSON Schema
 * cannot represent (transforms, dates, …). Results are memoized and frozen.
 */
export function toJsonSchema(
  /** Zod schema to emit. */
  schema: z.ZodType,
  /** `input` for accepted arguments and config; `output` for results and errors. */
  io: SchemaIo,
): JsonSchema {
  const cached = emitted.get(schema)?.[io];
  if (cached !== undefined) {
    return cached;
  }
  const json = Object.freeze(
    z.toJSONSchema(schema, { target: "draft-2020-12", io, unrepresentable: "throw" }) as JsonSchema,
  );
  emitted.set(schema, { ...emitted.get(schema), [io]: json });
  return json;
}

/** Formats a Zod issue path as `a.b.0.c`, or `$` for the root. */
function formatIssuePath(
  /** Issue path segments from Zod. */
  path: readonly PropertyKey[],
): string {
  return path.length === 0 ? "$" : path.map((segment) => String(segment)).join(".");
}

/** Maximum number of allowed keys listed in an unknown-key error. */
const MAX_ALLOWED_KEYS = 20;

/** Value in `data` at a Zod issue path (`undefined` when any segment is missing). */
function valueAtPath(
  /** Validated input. */
  data: unknown,
  /** Issue path segments. */
  path: readonly PropertyKey[],
): unknown {
  let value: unknown = data;
  for (const segment of path) {
    if (typeof value !== "object" || value === null) return undefined;
    value = (value as Record<PropertyKey, unknown>)[segment];
  }
  return value;
}

/** Follows a local `$ref` (if any) to its target schema node. */
function derefNode(
  /** Schema node. */
  node: unknown,
  /** Emitted root schema. */
  root: JsonSchema,
): Record<string, unknown> | undefined {
  if (typeof node !== "object" || node === null || Array.isArray(node)) return undefined;
  const ref = (node as Record<string, unknown>).$ref;
  if (typeof ref === "string") {
    const target = resolveJsonPointer(root, ref);
    return typeof target === "object" && target !== null ? (target as Record<string, unknown>) : undefined;
  }
  return node as Record<string, unknown>;
}

/**
 * Picks the object branch of a union node that fits `instance`: the branch whose `const` / `enum` properties all
 * match the instance's values (a discriminator), else the only object branch.
 */
function objectBranch(
  /** Union or plain schema node. */
  node: Record<string, unknown>,
  /** Instance value at this node. */
  instance: unknown,
  /** Emitted root schema. */
  root: JsonSchema,
): Record<string, unknown> | undefined {
  const branches = (node.anyOf ?? node.oneOf) as unknown[] | undefined;
  if (!Array.isArray(branches)) return node;
  const objects = branches
    .map((b) => derefNode(b, root))
    .filter((b): b is Record<string, unknown> => b !== undefined && typeof b.properties === "object");
  const record = typeof instance === "object" && instance !== null ? (instance as Record<string, unknown>) : {};
  const matching = objects.filter((b) =>
    Object.entries(b.properties as Record<string, Record<string, unknown>>).every(([key, prop]) => {
      if (prop?.const !== undefined) return record[key] === prop.const;
      if (Array.isArray(prop?.enum) && prop.enum.every((v) => typeof v === "string"))
        return (prop.enum as unknown[]).includes(record[key]);
      return true;
    }),
  );
  return matching.length === 1 ? matching[0] : objects.length === 1 ? objects[0] : undefined;
}

/** Declared property names of the emitted schema object at `path`, or `undefined` when it can't be resolved. */
function allowedKeysAt(
  /** Emitted root schema. */
  root: JsonSchema,
  /** Validated input. */
  data: unknown,
  /** Issue path segments. */
  path: readonly PropertyKey[],
): string[] | undefined {
  let node = objectBranch(derefNode(root, root) ?? {}, data, root);
  for (let i = 0; i < path.length && node !== undefined; i++) {
    const segment = path[i] as PropertyKey;
    const props = node.properties as Record<string, unknown> | undefined;
    const next = typeof segment === "number" ? node.items : props?.[String(segment)];
    const resolved = derefNode(next, root);
    node = resolved === undefined ? undefined : objectBranch(resolved, valueAtPath(data, path.slice(0, i + 1)), root);
  }
  const props = node?.properties;
  return typeof props === "object" && props !== null ? Object.keys(props).sort() : undefined;
}

/** Rewrites one Zod issue into argsbarg's `"<path>: <message>"` line. */
function formatIssue(
  /** Zod issue. */
  issue: z.core.$ZodIssue,
  /** Schema that produced the issue. */
  schema: z.ZodType,
  /** Validated input. */
  data: unknown,
): string {
  const path = formatIssuePath(issue.path);
  if (issue.code === "invalid_type" && valueAtPath(data, issue.path) === undefined && issue.path.length > 0) {
    return `${path}: required`;
  }
  if (issue.code === "unrecognized_keys") {
    let allowed: string[] | undefined;
    try {
      allowed = allowedKeysAt(toJsonSchema(schema, "input"), data, issue.path);
    } catch {
      allowed = undefined;
    }
    const list = allowed?.slice(0, MAX_ALLOWED_KEYS).join(", ");
    return `${path}: ${issue.message}${list ? ` (allowed: ${list}${(allowed?.length ?? 0) > MAX_ALLOWED_KEYS ? ", …" : ""})` : ""}`;
  }
  return `${path}: ${issue.message}${receivedSuffix(issue, data)}`;
}

/** Issue codes whose Zod messages omit the rejected value (e.g. an unknown discriminator). */
const ECHO_RECEIVED_CODES = new Set(["invalid_union", "invalid_value"]);

/** ` (got "x")` for union/enum mismatches on a present primitive value, so callers see what was rejected. */
function receivedSuffix(
  /** Zod issue. */
  issue: z.core.$ZodIssue,
  /** Validated input. */
  data: unknown,
): string {
  if (!ECHO_RECEIVED_CODES.has(issue.code) || issue.path.length === 0) {
    return "";
  }
  const value = valueAtPath(data, issue.path);
  if (typeof value === "string") return ` (got ${JSON.stringify(value)})`;
  if (typeof value === "number" || typeof value === "boolean") return ` (got ${String(value)})`;
  return "";
}

/** Validates `data` against `schema`, returning the parsed value or `"<path>: <message>"` error lines. */
export function validateWithSchema(
  /** Zod schema to validate against. */
  schema: z.ZodType,
  /** Candidate value (tool arguments, config document, …). */
  data: unknown,
): SchemaValidateResult {
  const result = schema.safeParse(data);
  if (result.success) {
    return { valid: true, value: result.data, errors: [] };
  }
  const all = result.error.issues.map((issue) => formatIssue(issue, schema, data));
  if (all.length <= MAX_ERRORS) {
    return { valid: false, errors: all };
  }
  return { valid: false, errors: [...all.slice(0, MAX_ERRORS), `…and ${all.length - MAX_ERRORS} more errors`] };
}

/** Inputs used to synthesize the one runtime schema for a routed CLI command. */
export interface RuntimeLeafSchemaOptions {
  /** Leaf whose authored and structural inputs are combined. */
  readonly leaf: RunnableCommand;
  /** Effective root and ancestor/leaf option definitions in parser order. */
  readonly options: readonly CommandOption[];
  /** Exact path names that were captured while routing. */
  readonly pathNames: readonly string[];
}

/** Creates a finite strict object schema for one CLI option definition. */
function optionZodSchema(option: CommandOption): z.ZodType {
  let schema: z.ZodType;
  if (option.kind === OptionKind.Presence) return z.boolean();
  if (option.kind === OptionKind.Number) schema = z.number().finite();
  else if (option.kind === OptionKind.Enum) schema = z.enum(option.choices as [string, ...string[]]);
  else if (option.kind === OptionKind.Json) schema = z.unknown();
  else {
    schema =
      option.format === ValueFormat.Duration
        ? z.number().finite()
        : option.format === ValueFormat.CommaList
          ? z.array(z.string())
          : z.string();
    if (option.pattern !== undefined) schema = z.string().regex(new RegExp(option.pattern));
  }
  return option.required || option.default !== undefined ? schema : schema.optional();
}

/** Resolves emitted object property names, or throws for a schema that cannot expose finite object fields. */
function objectPropertyNames(schema: z.ZodType): Set<string> {
  const emitted = toJsonSchema(schema, "input");
  const properties = emitted.properties;
  if (typeof properties !== "object" || properties === null || Array.isArray(properties)) {
    throw new TypeError("CLI inputSchema must be a plain Zod object when composed with path inputs");
  }
  return new Set(Object.keys(properties));
}

/**
 * Synthesizes the one Zod schema parsed by `invokeBound` for a routed CLI declaration.
 * Authored schemas remain authoritative while path values are parsed in the same outer schema operation.
 */
export function runtimeLeafInputSchema(options: RuntimeLeafSchemaOptions): z.ZodType {
  const { leaf, options: optionDefs, pathNames } = options;
  const pathNameSet = new Set(pathNames);
  const structuralNames = new Set<string>();
  for (const name of [
    ...optionDefs.map((option) => option.name),
    ...(leaf.positionals ?? []).map((slot) => slot.name),
  ]) {
    if (structuralNames.has(name) || pathNameSet.has(name)) {
      throw new TypeError(`CLI input key "${name}" is declared more than once`);
    }
    structuralNames.add(name);
  }

  if (leaf.inputSchema === undefined) {
    const shape: Record<string, z.ZodType> = {};
    for (const option of optionDefs) {
      const schema = optionZodSchema(option);
      shape[option.name] = option.kind === OptionKind.Presence ? schema.default(false) : schema;
    }
    for (const slot of leaf.positionals ?? []) {
      const many = slot.argMax === 0 || (slot.argMax ?? 1) > 1;
      const minimum = slot.argMin ?? 1;
      let schema: z.ZodType = many ? z.array(z.string()).min(minimum) : z.string();
      if (minimum === 0) schema = schema.optional();
      shape[slot.name] = schema;
    }
    const pathShape = leaf.pathParams?.shape ?? {};
    for (const name of pathNames) {
      if (!(name in pathShape)) shape[name] = z.string();
    }
    Object.assign(shape, pathShape);
    return z.strictObject(shape);
  }

  if (leaf.pathParams === undefined && pathNames.length === 0) return leaf.inputSchema;
  const authoredNames = objectPropertyNames(leaf.inputSchema);
  for (const name of pathNames) {
    if (authoredNames.has(name)) {
      throw new TypeError(`CLI path key "${name}" is also declared by inputSchema`);
    }
  }
  const authoredPathShape = (leaf.pathParams?.shape ?? {}) as Record<string, z.ZodType>;
  const undeclaredPathSchema = z.strictObject(
    Object.fromEntries(pathNames.map((name) => [name, authoredPathShape[name] ?? z.string()])),
  );
  return z
    .unknown()
    .transform((value) => {
      const raw =
        typeof value === "object" && value !== null && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : value;
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { body: raw, path: {} };
      const record = raw as Record<string, unknown>;
      const path = Object.fromEntries(pathNames.map((name) => [name, record[name]]));
      const body = Object.fromEntries(Object.entries(record).filter(([name]) => !pathNameSet.has(name)));
      return { body, path };
    })
    .pipe(z.strictObject({ body: leaf.inputSchema, path: undeclaredPathSchema }))
    .transform(({ body, path }) => {
      if (typeof body !== "object" || body === null || Array.isArray(body)) return body;
      return { ...path, ...(body as Record<string, unknown>) };
    });
}

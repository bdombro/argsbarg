/*
Native REST request binding for the explicit HTTP route catalog.
It maps path, query, and document body into one raw input without parsing with Zod.
*/

import type { z } from "zod";
import { decodeDocument } from "../core/document.ts";
import type { InvocationBase } from "../core/invocation.ts";
import { toJsonSchema } from "../core/zod-schema.ts";
import { requestDocumentFormat } from "./media.ts";
import type { HttpRouteCatalog, RegisteredHttpRoute } from "./routes.ts";
import { matchHttpCatalogRoute } from "./routes.ts";
import { dereferenceJsonSchema } from "./schema-deref.ts";

/** One stable pre-invocation wire error returned by the HTTP binder. */
export interface HttpBindError {
  /** Terminal error discriminator. */
  readonly ok: false;
  /** HTTP status for the wire error. */
  readonly status: number;
  /** Stable REST error code. */
  readonly code: string;
  /** Human-readable client-safe message. */
  readonly message: string;
  /** Optional client-safe structured details. */
  readonly details?: unknown;
}

/** A successfully bound request ready for exactly one `invokeBound` call. */
export interface HttpBoundRequest<Seed extends object = Record<never, never>> {
  /** Successful binding discriminator. */
  readonly ok: true;
  /** Matched immutable route registration. */
  readonly route: RegisteredHttpRoute;
  /** Raw merged path/query/body value passed to the shared invocation runner. */
  readonly rawInputs: Readonly<Record<string, unknown>>;
  /** HTTP-only source, signal, surface, and fresh seed locals. */
  readonly base: InvocationBase<Seed>;
}

/** Per-call options for native HTTP binding. */
export interface HttpBindOptions<Seed extends object = Record<never, never>> {
  /** Fixed route mount stripped before catalog matching. */
  readonly mountPath?: string;
  /** Seed locals copied into a fresh per-invocation object. */
  readonly locals?: Seed;
}

/** JSON input already decoded by a generated `api` command. */
export interface HttpCallInput {
  /** Case-insensitive REST method selected by the generated command. */
  readonly method: string;
  /** Absolute mount path with its exact query text and no fragment. */
  readonly fullPath: string;
  /** Optional non-null JSON object supplied as the request body. */
  readonly body?: Record<string, unknown>;
}

/** One route and flat raw input selected without invoking a handler. */
export interface HttpBoundCall {
  /** Successful pure binding discriminator. */
  readonly ok: true;
  /** Matched immutable route registration. */
  readonly route: RegisteredHttpRoute;
  /** Flat path, query, and body inputs for the single declaration parse. */
  readonly rawInputs: Readonly<Record<string, unknown>>;
}

/** Produces a stable binder error without exposing request values. */
function bindError(status: number, code: string, message: string, details?: unknown): HttpBindError {
  return {
    ok: false,
    status,
    code,
    message,
    ...(details === undefined ? {} : { details }),
  };
}

/** Narrows a record-like binding result to the stable failure variant. */
function isBindError(value: object): value is HttpBindError {
  return (value as { ok?: unknown }).ok === false;
}

/** Resolves a mount-relative pathname or a 404 wire result. */
function relativePath(url: URL, mountPath: string): string | HttpBindError {
  if (url.pathname !== mountPath && !url.pathname.startsWith(`${mountPath}/`)) {
    return bindError(404, "NOT_FOUND", "No REST route matched the request");
  }
  const relative = url.pathname.slice(mountPath.length);
  return relative === "" ? "/" : relative;
}

/** Returns dereferenced emitted properties for one query object. */
function queryProperties(schema: z.ZodObject): Record<string, Record<string, unknown>> {
  const emitted = dereferenceJsonSchema(toJsonSchema(schema, "input"));
  const properties = emitted.properties;
  return typeof properties === "object" && properties !== null
    ? (properties as Record<string, Record<string, unknown>>)
    : {};
}

/** Exact JSON-number spelling accepted by query number coercion. */
const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/** Tagged result that keeps valid application objects separate from binder failures. */
type QueryCoercionResult =
  | {
      /** Identifies a successfully coerced scalar or JSON object. */
      readonly kind: "value";
      /** Coerced value retained under its declared query name. */
      readonly value: string | number | boolean | Record<string, unknown>;
    }
  | {
      /** Identifies an object-coercion failure that stops binding. */
      readonly kind: "error";
      /** Stable pre-invocation wire failure. */
      readonly error: HttpBindError;
    };

/** Coerces one scalar query text using only its emitted JSON Schema profile. */
function coerceQueryScalar(value: string, schema: Record<string, unknown>): QueryCoercionResult {
  if (schema.type === "boolean") {
    if (value === "true") return { kind: "value", value: true };
    if (value === "false") return { kind: "value", value: false };
    return { kind: "value", value };
  }
  if ((schema.type === "number" || schema.type === "integer") && JSON_NUMBER.test(value)) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return { kind: "value", value: numeric };
  }
  return { kind: "value", value };
}

/** Coerces one object query value from JSON text. */
function coerceQueryObject(name: string, value: string): QueryCoercionResult {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {
        kind: "error",
        error: bindError(400, "INVALID_QUERY_JSON", "Query object must contain JSON object text", { name }),
      };
    }
    return { kind: "value", value: parsed as Record<string, unknown> };
  } catch {
    return {
      kind: "error",
      error: bindError(400, "INVALID_QUERY_JSON", "Query object contains malformed JSON text", { name }),
    };
  }
}

/** Binds URLSearchParams according to the route's exact query schema. */
function bindQuery(search: URLSearchParams, route: RegisteredHttpRoute): Record<string, unknown> | HttpBindError {
  const schema = route.spec.queryParams;
  if (schema === undefined) {
    if ([...search].length > 0) return bindError(400, "UNKNOWN_QUERY", "Query parameters are not declared");
    return {};
  }
  const properties = queryProperties(schema);
  const seen = new Map<string, string[]>();
  for (const [name, value] of search) {
    if (!Object.hasOwn(properties, name)) {
      return bindError(400, "UNKNOWN_QUERY", "Query parameter is not declared", { name });
    }
    const values = seen.get(name);
    if (values === undefined) seen.set(name, [value]);
    else values.push(value);
  }

  const raw: Record<string, unknown> = {};
  for (const [name, values] of seen) {
    const property = properties[name];
    if (property === undefined) continue;
    const array = property.type === "array";
    if (!array && values.length > 1) {
      return bindError(400, "REPEATED_QUERY", "Scalar query parameter may appear only once", { name });
    }
    const itemSchema =
      array && typeof property.items === "object" && property.items !== null
        ? (property.items as Record<string, unknown>)
        : property;
    const coerced = values.map((value) => {
      if (itemSchema.type === "object") return coerceQueryObject(name, value);
      return coerceQueryScalar(value, itemSchema);
    });
    const failure = coerced.find((result) => result.kind === "error");
    if (failure?.kind === "error") return failure.error;
    const valuesToBind = coerced.map((result) => {
      if (result.kind === "error") throw new TypeError("Unreachable query coercion failure");
      return result.value;
    });
    raw[name] = array ? valuesToBind : valuesToBind[0];
  }
  return raw;
}

/** Parsed native body and whether non-empty request text was supplied. */
interface BoundHttpBody {
  /** Decoded JSON object, or an empty object when the body is absent. */
  readonly value: Record<string, unknown>;
  /** Whether the native request contained non-whitespace body text. */
  readonly provided: boolean;
}

/** Binds one accepted body object or an empty object. */
async function bindBody(request: Request, route: RegisteredHttpRoute): Promise<BoundHttpBody | HttpBindError> {
  const text = await request.text();
  if (text.trim().length === 0) return { value: {}, provided: false };
  if (route.spec.body === undefined) {
    return bindError(400, "BODY_NOT_DECLARED", "This route does not accept a request body");
  }
  const format = requestDocumentFormat(request.headers.get("content-type"));
  if (format === undefined) {
    return bindError(415, "UNSUPPORTED_MEDIA_TYPE", "A UTF-8 JSON or YAML request body is required");
  }
  let parsed: unknown;
  try {
    parsed = decodeDocument(text, format);
  } catch {
    return format === "yaml"
      ? bindError(400, "INVALID_YAML", "Request body is not a valid YAML document")
      : bindError(400, "INVALID_JSON", "Request body is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return bindError(400, "INVALID_BODY", format === "yaml" ? "Request body must be a YAML mapping" : "Request body must be a JSON object");
  }
  return { value: parsed as Record<string, unknown>, provided: true };
}

/** Decodes captured path text with strict percent-decoding. */
function bindPath(route: RegisteredHttpRoute, captures: readonly string[]): Record<string, string> | HttpBindError {
  const path: Record<string, string> = {};
  for (let index = 0; index < route.paramNames.length; index += 1) {
    const name = route.paramNames[index];
    const capture = captures[index];
    if (name === undefined || capture === undefined) {
      return bindError(400, "INVALID_PATH", "Request path parameters do not match the route");
    }
    try {
      const decoded = decodeURIComponent(capture);
      if (decoded.length === 0) return bindError(400, "INVALID_PATH", "Path parameter must not be empty");
      path[name] = decoded;
    } catch {
      return bindError(400, "INVALID_PATH", "Request path contains invalid percent encoding");
    }
  }
  return path;
}

/** Selects and binds one mount path, query string, and already-decoded JSON body. */
function bindHttpParts(
  catalog: HttpRouteCatalog,
  method: string,
  pathname: string,
  searchParams: URLSearchParams,
  body: Record<string, unknown>,
  bodyProvided: boolean,
  mountPath: string,
): HttpBoundCall | HttpBindError {
  const relative = relativePath(new URL(`http://argsbarg.invalid${pathname}`), mountPath);
  if (typeof relative !== "string") return relative;
  const match = matchHttpCatalogRoute(catalog, method.toUpperCase(), relative);
  if (!match.ok) return bindError(404, "NOT_FOUND", "No REST route matched the request");
  if (bodyProvided && match.route.spec.body === undefined) {
    return bindError(400, "BODY_NOT_DECLARED", "This route does not accept a request body");
  }

  const path = bindPath(match.route, match.captures);
  if (isBindError(path)) return path;
  const query = bindQuery(searchParams, match.route);
  if (isBindError(query)) return query;

  return {
    ok: true,
    route: match.route,
    rawInputs: { ...path, ...query, ...body },
  };
}

/** Binds one generated REST call without creating a Fetch `Request`. */
export function bindHttpCall(
  /** Immutable explicit REST catalog used by native dispatch. */
  catalog: HttpRouteCatalog,
  /** One parsed generated-command input value. */
  input: HttpCallInput,
  /** Fixed route mount stripped before catalog matching. */
  options: Pick<HttpBindOptions, "mountPath"> = {},
): HttpBoundCall | HttpBindError {
  if (
    typeof input.method !== "string" ||
    typeof input.fullPath !== "string" ||
    !input.fullPath.startsWith("/") ||
    input.fullPath.startsWith("//") ||
    input.fullPath.includes("#")
  ) {
    return bindError(400, "INVALID_CALL", "REST method and absolute full path are required");
  }
  if (
    input.body !== undefined &&
    (typeof input.body !== "object" || input.body === null || Array.isArray(input.body))
  ) {
    return bindError(400, "INVALID_BODY", "Request body must be a JSON object");
  }
  let url: URL;
  try {
    url = new URL(input.fullPath, "http://argsbarg.invalid");
  } catch {
    return bindError(400, "INVALID_CALL", "REST full path is not valid");
  }
  if (url.origin !== "http://argsbarg.invalid" || url.hash.length > 0) {
    return bindError(400, "INVALID_CALL", "REST full path must be origin-relative without a fragment");
  }
  return bindHttpParts(
    catalog,
    input.method,
    url.pathname,
    url.searchParams,
    input.body ?? {},
    input.body !== undefined,
    options.mountPath ?? "/api",
  );
}

/** Binds one native `Request` to one registered route without invoking Zod or any guard. */
export async function bindHttpRequest<Seed extends object = Record<never, never>>(
  /** Immutable explicit REST catalog. */
  catalog: HttpRouteCatalog,
  /** Native Fetch request to bind. */
  request: Request,
  /** Mount and per-call seed options. */
  options: HttpBindOptions<Seed> = {},
): Promise<HttpBoundRequest<Seed> | HttpBindError> {
  const mountPath = options.mountPath ?? "/api";
  const url = new URL(request.url);
  const relative = relativePath(url, mountPath);
  if (typeof relative !== "string") return relative;
  const match = matchHttpCatalogRoute(catalog, request.method.toUpperCase(), relative);
  if (!match.ok) return bindError(404, "NOT_FOUND", "No REST route matched the request");
  const body = await bindBody(request, match.route);
  if (isBindError(body)) return body;
  const bound = bindHttpParts(
    catalog,
    request.method,
    url.pathname,
    url.searchParams,
    body.value,
    body.provided,
    mountPath,
  );
  if (isBindError(bound)) return bound;

  return {
    ok: true,
    route: bound.route,
    rawInputs: bound.rawInputs,
    base: {
      source: "http",
      headers: {
        get: (name) => request.headers.get(name) ?? undefined,
      },
      locals: { ...(options.locals ?? ({} as Seed)) } as Seed,
      signal: request.signal,
      surface: "http",
    },
  };
}

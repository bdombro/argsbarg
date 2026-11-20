/*
Explicit REST route declarations and the immutable dispatch catalog.
*/

import { z } from "zod";
import type {
  BoundDeclaration,
  Guard,
  InvocationBase,
  InvocationContext,
  InvocationOutcome,
  MaybePromise,
  OperationGuard,
} from "../core/invocation.ts";
import { type HttpMethod } from "../core/types.ts";
import { isZodObjectSchema, toJsonSchema } from "../core/zod-schema.ts";
import { compileGuardPlan, invokeBound } from "../runtime/invoke.ts";

/** Default success HTTP status for a route method when handler omits status. */
export function defaultSuccessStatus(method: HttpMethod, hasBody: boolean): number {
  switch (method) {
    case "GET":
      return 200;
    case "POST":
      return 201;
    case "PUT":
    case "PATCH":
      return 200;
    case "DELETE":
      return hasBody ? 200 : 204;
    default:
      return 200;
  }
}

/** Metadata for one native REST response declared explicitly by a route. */
export interface HttpRouteResponse {
  /** HTTP status carried by the documented native response. */
  status: number;
  /** Human-readable OpenAPI response description. */
  description: string;
  /** Optional response media type. */
  contentType?: string;
  /** Optional Zod response schema. */
  schema?: z.ZodType;
  /** Optional documented response header names. */
  headers?: readonly string[];
}

/** Ordinary response defaults applied when a handler returns a JSON value. */
export interface HttpRouteResponseDefaults {
  /** Explicit success status overriding the method default. */
  status?: number;
  /** Headers added to ordinary JSON responses. */
  headers?: Readonly<Record<string, string>>;
}

/** Fields shared by every independently declared REST route. */
interface HttpRouteCommon<Seed extends object, Input, G> {
  /** Globally unique OpenAPI operation ID. */
  id: string;
  /** HTTP method accepted by the route. */
  method: HttpMethod;
  /** Leading-slash path relative to the fixed `/api` mount. */
  path: string;
  /** Stable route description used by OpenAPI. */
  description: string;
  /** Optional explicit OpenAPI tags. */
  tags?: readonly string[];
  /** Keeps the route callable while omitting it from discovery. */
  hidden?: boolean;
  /** Optional path-parameter Zod object. */
  pathParams?: z.ZodObject;
  /** Optional query-parameter Zod object. */
  queryParams?: z.ZodObject;
  /** Optional JSON-body Zod object. */
  body?: z.ZodObject;
  /** Optional operation guard evaluated after the HTTP surface guard. */
  guard?: G;
  /** Handler receiving one flat, parsed input object. */
  handler: (context: InvocationContext<Input, HttpRouteFinalLocals<Seed, G>>) => MaybePromise<unknown>;
  /** Optional ordinary response defaults. */
  response?: HttpRouteResponseDefaults;
  /** Native or additional documented responses. */
  responses?: readonly HttpRouteResponse[];
}

/** Locals contributed by a concrete operation guard result. */
type HttpGuardAdded<G> = G extends (...args: never[]) => infer Result
  ? Awaited<Result> extends { readonly kind: "allow"; readonly locals?: infer Added }
    ? Added extends object
      ? Added
      : Record<never, never>
    : Record<never, never>
  : G extends { readonly mode: "override"; readonly run: infer Run }
    ? HttpGuardAdded<Run>
    : Record<never, never>;

/** Final locals visible to a route handler after its operation guard. */
type HttpRouteFinalLocals<Seed extends object, G> = {
  [Key in keyof Seed | keyof HttpGuardAdded<G>]: Key extends keyof HttpGuardAdded<G>
    ? HttpGuardAdded<G>[Key]
    : Key extends keyof Seed
      ? Seed[Key]
      : never;
};

/** Parsed output fields supplied by one route source schema, or an empty object. */
type HttpSourceOutput<Schema> = Schema extends z.ZodType ? z.output<Schema> : Record<never, never>;

/** Flat parsed input formed from disjoint path, query, and body fields. */
type HttpRouteInput<PathSchema, QuerySchema, BodySchema> = HttpSourceOutput<PathSchema> &
  HttpSourceOutput<QuerySchema> &
  HttpSourceOutput<BodySchema>;

/** Shallow merge preserving operation-owned additions in the handler context. */
type MergeHttpRouteLocals<Seed extends object, Added extends object> = {
  [Key in keyof Seed | keyof Added]: Key extends keyof Added ? Added[Key] : Key extends keyof Seed ? Seed[Key] : never;
};

/** Contextually typed guard accepted by an extracted route builder. */
type HttpRouteBuilderGuard<Input, Seed extends object, Added extends object> =
  | Guard<Input, Seed, Added>
  | {
      /** Selects operation-owned replacement of the HTTP surface guard. */
      readonly mode: "override";
      /** Replacement guard evaluated from the transport seed. */
      readonly run: Guard<Input, Seed, Added>;
    }
  | "public";

/** Common contextual fields used directly by the extracted route identity builder. */
interface HttpRouteBuilderCommon<
  Seed extends object,
  PathSchema extends z.ZodObject | undefined,
  QuerySchema extends z.ZodObject | undefined,
  BodySchema extends z.ZodObject | undefined,
  Added extends object,
> {
  /** Globally unique OpenAPI operation ID. */
  id: string;
  /** HTTP method accepted by the route. */
  method: HttpMethod;
  /** Leading-slash path relative to the fixed `/api` mount. */
  path: string;
  /** Stable route description used by OpenAPI. */
  description: string;
  /** Optional explicit OpenAPI tags. */
  tags?: readonly string[];
  /** Keeps the route callable while omitting it from discovery. */
  hidden?: boolean;
  /** Optional path-parameter Zod object. */
  pathParams?: PathSchema;
  /** Optional query-parameter Zod object. */
  queryParams?: QuerySchema;
  /** Optional JSON-body Zod object. */
  body?: BodySchema;
  /** Optional operation guard. */
  guard?: HttpRouteBuilderGuard<HttpRouteInput<PathSchema, QuerySchema, BodySchema>, Seed, Added>;
  /** Optional ordinary response defaults. */
  response?: HttpRouteResponseDefaults;
  /** Optional additional native or ordinary response metadata. */
  responses?: readonly HttpRouteResponse[];
}

/** Ordinary contextual declaration accepted by the extracted route builder. */
type HttpOrdinaryRouteBuilderDeclaration<
  Seed extends object,
  PathSchema extends z.ZodObject | undefined,
  QuerySchema extends z.ZodObject | undefined,
  BodySchema extends z.ZodObject | undefined,
  OutputSchema extends z.ZodType,
  Added extends object,
> = HttpRouteBuilderCommon<Seed, PathSchema, QuerySchema, BodySchema, Added> & {
  /** Schema describing the ordinary JSON result. */
  outputSchema: OutputSchema;
  /** Handler receiving flat parsed input and evolved locals. */
  handler: (
    context: InvocationContext<HttpRouteInput<PathSchema, QuerySchema, BodySchema>, MergeHttpRouteLocals<Seed, Added>>,
  ) => MaybePromise<z.output<OutputSchema> | Response>;
};

/** Native-only contextual declaration accepted by the extracted route builder. */
type HttpNativeRouteBuilderDeclaration<
  Seed extends object,
  PathSchema extends z.ZodObject | undefined,
  QuerySchema extends z.ZodObject | undefined,
  BodySchema extends z.ZodObject | undefined,
  Added extends object,
> = HttpRouteBuilderCommon<Seed, PathSchema, QuerySchema, BodySchema, Added> & {
  /** Native-only routes omit ordinary output metadata. */
  outputSchema?: never;
  /** Native-only routes document at least one response. */
  responses: readonly [HttpRouteResponse, ...HttpRouteResponse[]];
  /** Handler returning a native Web response. */
  handler: (
    context: InvocationContext<HttpRouteInput<PathSchema, QuerySchema, BodySchema>, MergeHttpRouteLocals<Seed, Added>>,
  ) => MaybePromise<Response>;
};

/** Overloads carried by the curried route identity builder. */
interface HttpRouteBuilder<Seed extends object> {
  <
    const PathSchema extends z.ZodObject | undefined = undefined,
    const QuerySchema extends z.ZodObject | undefined = undefined,
    const BodySchema extends z.ZodObject | undefined = undefined,
    const OutputSchema extends z.ZodType = z.ZodType,
    const Added extends object = Record<never, never>,
  >(
    /** Ordinary JSON route declaration. */
    declaration: HttpOrdinaryRouteBuilderDeclaration<Seed, PathSchema, QuerySchema, BodySchema, OutputSchema, Added>,
  ): typeof declaration;
  <
    const PathSchema extends z.ZodObject | undefined = undefined,
    const QuerySchema extends z.ZodObject | undefined = undefined,
    const BodySchema extends z.ZodObject | undefined = undefined,
    const Added extends object = Record<never, never>,
  >(
    /** Native-response-only route declaration. */
    declaration: HttpNativeRouteBuilderDeclaration<Seed, PathSchema, QuerySchema, BodySchema, Added>,
  ): typeof declaration;
}

/** Independently declared REST route whose ordinary result is typed by `outputSchema`. */
export type HttpRouteDeclaration<
  Seed extends object = object,
  PathSchema extends z.ZodObject | undefined = undefined,
  QuerySchema extends z.ZodObject | undefined = undefined,
  BodySchema extends z.ZodObject | undefined = undefined,
  OutputSchema extends z.ZodType = z.ZodType,
  G = undefined,
> = HttpRouteCommon<Seed, HttpRouteInput<PathSchema, QuerySchema, BodySchema>, G> & {
  /** Schema describing the ordinary JSON result. */
  outputSchema: OutputSchema;
  /** Handler return matching the output schema, or a native REST response. */
  handler: (
    context: InvocationContext<HttpRouteInput<PathSchema, QuerySchema, BodySchema>, HttpRouteFinalLocals<Seed, G>>,
  ) => MaybePromise<z.output<OutputSchema> | Response>;
};

/** Independently declared REST route that returns only native Web responses. */
export type HttpNativeRouteDeclaration<
  Seed extends object = object,
  PathSchema extends z.ZodObject | undefined = undefined,
  QuerySchema extends z.ZodObject | undefined = undefined,
  BodySchema extends z.ZodObject | undefined = undefined,
  G = undefined,
> = HttpRouteCommon<Seed, HttpRouteInput<PathSchema, QuerySchema, BodySchema>, G> & {
  /** Native-only routes do not declare an ordinary output schema. */
  outputSchema?: never;
  /** Native-only routes must document at least one response. */
  responses: readonly [HttpRouteResponse, ...HttpRouteResponse[]];
  /** Handler returning a native Web response. */
  handler: (
    context: InvocationContext<HttpRouteInput<PathSchema, QuerySchema, BodySchema>, HttpRouteFinalLocals<Seed, G>>,
  ) => MaybePromise<Response>;
};

/** Either an ordinary JSON route or a native-response-only route. */
export type HttpRouteSpec<
  Seed extends object = object,
  PathSchema extends z.ZodObject | undefined = undefined,
  QuerySchema extends z.ZodObject | undefined = undefined,
  BodySchema extends z.ZodObject | undefined = undefined,
  G = undefined,
> =
  | HttpRouteDeclaration<Seed, PathSchema, QuerySchema, BodySchema, z.ZodType, G>
  | HttpNativeRouteDeclaration<Seed, PathSchema, QuerySchema, BodySchema, G>;

/**
 * Creates an identity builder for extracted REST routes with typed flat inputs and operation-guard locals.
 *
 * The builder performs no registration work; pass its result to `createHttpCatalog`.
 */
export function route<Seed extends object = Record<never, never>>(): HttpRouteBuilder<Seed> {
  return ((declaration: unknown) => declaration) as HttpRouteBuilder<Seed>;
}

/** Runtime route shape used only after public declarations have been accepted. */
interface RuntimeHttpRouteSpec {
  /** Globally unique operation identifier retained for dispatch and discovery. */
  id: string;
  /** Supported HTTP method matched after the fixed mount is removed. */
  method: HttpMethod;
  /** Canonical leading-slash route template relative to `/api`. */
  path: string;
  /** Human-readable route description exposed by OpenAPI. */
  description: string;
  /** Optional explicit OpenAPI tags, otherwise inferred from the first literal segment. */
  tags?: readonly string[];
  /** Whether the callable route is omitted from OpenAPI discovery. */
  hidden?: boolean;
  /** Optional finite Zod object schema for path placeholders. */
  pathParams?: z.ZodObject;
  /** Optional finite Zod object schema for query parameters. */
  queryParams?: z.ZodObject;
  /** Optional finite Zod object schema for a JSON request body. */
  body?: z.ZodObject;
  /** Optional ordinary JSON result schema; omitted for native-only routes. */
  outputSchema?: z.ZodType;
  /** Optional status and headers applied to ordinary JSON results. */
  response?: HttpRouteResponseDefaults;
  /** Optional explicit native or additional response metadata. */
  responses?: readonly HttpRouteResponse[];
  /** Optional supplement, replacement, or public operation guard. */
  guard?: OperationGuard<Guard<unknown, object, object>>;
  /** Route handler receiving the parsed flat input and final invocation locals. */
  handler: (context: InvocationContext<unknown, object>) => MaybePromise<unknown>;
}

/** Structurally registered REST declaration accepted by the package-internal catalog. */
export interface HttpRouteRegistration {
  /** Globally unique OpenAPI operation ID. */
  id: string;
  /** HTTP method accepted by the route. */
  method: HttpMethod;
  /** Leading-slash mount-relative route path. */
  path: string;
  /** Stable route description. */
  description: string;
  /** Optional explicit OpenAPI tags. */
  tags?: readonly string[];
  /** Callable route omitted from discovery. */
  hidden?: boolean;
  /** Optional path source schema. */
  pathParams?: z.ZodObject;
  /** Optional query source schema. */
  queryParams?: z.ZodObject;
  /** Optional body source schema. */
  body?: z.ZodObject;
  /** Optional ordinary output schema. */
  outputSchema?: z.ZodType;
  /** Optional ordinary response defaults. */
  response?: HttpRouteResponseDefaults;
  /** Optional native/additional response metadata. */
  responses?: readonly HttpRouteResponse[];
  /** Optional operation guard retained for runtime compilation. */
  guard?: unknown;
  /** Route handler retained for runtime invocation. */
  handler: (...args: never[]) => MaybePromise<unknown>;
}

/** Immutable registered route consumed by binding, dispatch, and OpenAPI. */
export interface RegisteredHttpRoute {
  /** Frozen public declaration metadata. */
  readonly spec: Readonly<Omit<RuntimeHttpRouteSpec, "pathParams" | "queryParams" | "body" | "guard" | "handler">> & {
    /** Canonical path segments retained for overlap registration checks. */
    readonly pathSegments: readonly string[];
    /** Path source schema, when declared. */
    readonly pathParams?: z.ZodObject;
    /** Query source schema, when declared. */
    readonly queryParams?: z.ZodObject;
    /** Body source schema, when declared. */
    readonly body?: z.ZodObject;
  };
  /** Bound declaration passed unchanged to `invokeBound`. */
  readonly declaration: BoundDeclaration<z.ZodObject, unknown, object>;
  /** Compiled matcher for a mount-relative pathname. */
  readonly pathPattern: RegExp;
  /** Placeholder names in URL order. */
  readonly paramNames: readonly string[];
  /** Canonical external OpenAPI path including `/api`. */
  readonly openApiPath: string;
}

/** Options for registering one immutable REST route catalog. */
export interface HttpCatalogOptions<Seed extends object = Record<never, never>> {
  /** Optional HTTP surface default guard run before operation supplements. */
  guard?: Guard<unknown, Seed, object>;
  /** Per-registration guards used when mounted child declarations retain independent policy. */
  guardsByRegistration?: ReadonlyMap<HttpRouteRegistration, Guard<unknown, Seed, object> | undefined>;
  /** Optional package-runtime wrapper applied around one registered route invocation. */
  decorateInvoke?: (
    /** Authored registration selected by the binder. */
    registration: HttpRouteRegistration,
    /** Concrete bound invocation for that registration. */
    invoke: (rawInputs: unknown, base: InvocationBase<Seed>) => Promise<InvocationOutcome<unknown>>,
    /** Raw native values passed to D2. */
    rawInputs: unknown,
    /** Exact request source, signal, and seed locals. */
    base: InvocationBase<Seed>,
  ) => Promise<InvocationOutcome<unknown>>;
}

/** Fixed, immutable REST registration snapshot. */
export interface HttpRouteCatalog {
  /** Frozen registered route list. */
  readonly routes: readonly RegisteredHttpRoute[];
}

/** Bound invocation closures retained without expanding the public catalog-entry shape. */
const httpInvocations = new WeakMap<
  object,
  (rawInputs: unknown, base: InvocationBase<object>) => Promise<InvocationOutcome<unknown>>
>();

/** True when a Zod source root is a finite, effect-free plain object. */
function assertSourceObject(
  schema: z.ZodObject | undefined,
  routeId: string,
  source: "pathParams" | "queryParams" | "body",
): void {
  if (schema === undefined) return;
  if (!isZodObjectSchema(schema)) {
    throw new TypeError(`HTTP route "${routeId}" ${source} must be a plain Zod object`);
  }
  const definition = (schema as unknown as { _zod: { def: { catchall?: z.ZodType } } })._zod.def;
  const catchallType = definition.catchall?._zod.def.type;
  if (catchallType !== undefined && catchallType !== "never") {
    throw new TypeError(`HTTP route "${routeId}" ${source} must be finite and may not declare a catchall`);
  }
  try {
    toJsonSchema(schema, "input");
  } catch (error) {
    throw new TypeError(`HTTP route "${routeId}" ${source} cannot be represented as OpenAPI input`, { cause: error });
  }
}

/** Parses and validates one route path into static and placeholder segments. */
function parseRoutePath(routeId: string, path: string): { segments: string[]; paramNames: string[] } {
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path === "/api" ||
    path.startsWith("/api/") ||
    path.includes("?") ||
    path.includes("#")
  ) {
    throw new TypeError(`HTTP route "${routeId}" path must be a leading-slash mount-relative path`);
  }
  const rawSegments = path === "/" ? [] : path.slice(1).replace(/\/$/, "").split("/");
  if (rawSegments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new TypeError(`HTTP route "${routeId}" path contains an invalid segment`);
  }
  const paramNames: string[] = [];
  const segments = rawSegments.map((segment) => {
    if (!segment.startsWith(":")) return segment;
    const name = segment.slice(1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new TypeError(`HTTP route "${routeId}" contains invalid path placeholder "${segment}"`);
    }
    if (paramNames.includes(name)) {
      throw new TypeError(`HTTP route "${routeId}" repeats path placeholder "${name}"`);
    }
    paramNames.push(name);
    return `:${name}`;
  });
  return { segments, paramNames };
}

/** Escapes one static route segment for a regular expression. */
function escapeRouteSegment(segment: string): string {
  return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when two canonical route languages can match the same pathname. */
function pathsOverlap(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((segment, index) => {
    const other = right[index];
    return segment.startsWith(":") || other?.startsWith(":") || segment === other;
  });
}

/** Validates one source field and returns whether its input JSON Schema is required. */
function sourceRequired(schema: z.ZodObject, key: string): boolean {
  const emitted = toJsonSchema(schema, "input");
  return Array.isArray(emitted.required) && emitted.required.some((required) => required === key);
}

/** Validates route source key disjointness and path-placeholder shape. */
function validateRouteSources(route: RuntimeHttpRouteSpec, paramNames: string[]): void {
  assertSourceObject(route.pathParams, route.id, "pathParams");
  assertSourceObject(route.queryParams, route.id, "queryParams");
  assertSourceObject(route.body, route.id, "body");

  const sources = [route.pathParams, route.queryParams, route.body];
  const owners = new Map<string, string>();
  for (const [index, schema] of sources.entries()) {
    if (schema === undefined) continue;
    const owner = ["pathParams", "queryParams", "body"][index] ?? "source";
    for (const key of Object.keys(schema.shape)) {
      const previous = owners.get(key);
      if (previous !== undefined) {
        throw new TypeError(`HTTP route "${route.id}" key "${key}" is declared by both ${previous} and ${owner}`);
      }
      owners.set(key, owner);
    }
  }

  const pathSchemaKeys = Object.keys(route.pathParams?.shape ?? {});
  const missing = paramNames.filter((name) => !pathSchemaKeys.includes(name));
  const extra = pathSchemaKeys.filter((name) => !paramNames.includes(name));
  if (missing.length > 0 || extra.length > 0) {
    throw new TypeError(
      `HTTP route "${route.id}" path schema keys must exactly match placeholders (missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"})`,
    );
  }
  for (const name of paramNames) {
    const schema = route.pathParams?.shape[name] as z.ZodType | undefined;
    const emitted = schema === undefined ? undefined : toJsonSchema(schema, "input");
    if (emitted === undefined || emitted.type !== "string" || !sourceRequired(route.pathParams as z.ZodObject, name)) {
      throw new TypeError(`HTTP route "${route.id}" path field "${name}" must be a required string schema`);
    }
  }
}

/** Builds a frozen catalog from independently declared REST routes. */
export function createHttpCatalog<Seed extends object = Record<never, never>>(
  /** Flat route declarations in deterministic registration order. */
  specs: readonly HttpRouteRegistration[],
  /** Optional HTTP surface guard compiled for every route. */
  options: HttpCatalogOptions<Seed> = {},
): HttpRouteCatalog {
  const ids = new Set<string>();
  const registered: RegisteredHttpRoute[] = [];
  for (const publicSpec of specs) {
    const spec = publicSpec as unknown as RuntimeHttpRouteSpec;
    if (spec.id.length === 0) throw new TypeError("HTTP route id must not be empty");
    if (ids.has(spec.id)) throw new TypeError(`Duplicate HTTP route id "${spec.id}"`);
    ids.add(spec.id);
    if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(spec.method)) {
      throw new TypeError(`HTTP route "${spec.id}" has unsupported method "${spec.method}"`);
    }
    if (typeof spec.description !== "string" || spec.description.length === 0) {
      throw new TypeError(`HTTP route "${spec.id}" requires a description`);
    }
    if (spec.outputSchema === undefined && (!spec.responses || spec.responses.length === 0)) {
      throw new TypeError(`Native HTTP route "${spec.id}" requires response metadata`);
    }
    if (spec.outputSchema !== undefined) {
      try {
        toJsonSchema(spec.outputSchema, "output");
      } catch (error) {
        throw new TypeError(`HTTP route "${spec.id}" outputSchema cannot be represented as OpenAPI output`, {
          cause: error,
        });
      }
      if (spec.response?.status === 204) {
        throw new TypeError(`HTTP route "${spec.id}" must use a native Response for status 204`);
      }
    }
    for (const response of spec.responses ?? []) {
      if (response.schema === undefined) continue;
      try {
        toJsonSchema(response.schema, "output");
      } catch (error) {
        throw new TypeError(`HTTP route "${spec.id}" response schema cannot be represented as OpenAPI output`, {
          cause: error,
        });
      }
    }
    const { segments, paramNames } = parseRoutePath(spec.id, spec.path);
    validateRouteSources(spec, paramNames);

    for (const prior of registered) {
      if (prior.spec.method === spec.method && pathsOverlap(prior.spec.pathSegments as string[], segments)) {
        throw new TypeError(`HTTP route "${spec.id}" overlaps registered route "${prior.spec.id}"`);
      }
    }

    const shape: z.ZodRawShape = {
      ...(spec.pathParams?.shape ?? {}),
      ...(spec.queryParams?.shape ?? {}),
      ...(spec.body?.shape ?? {}),
    };
    const inputSchema = z.strictObject(shape);
    const compile = compileGuardPlan<z.output<typeof inputSchema>, Seed>();
    const surfaceGuard =
      options.guardsByRegistration?.has(publicSpec) === true
        ? options.guardsByRegistration.get(publicSpec)
        : options.guard;
    const guardPlan =
      spec.guard === undefined
        ? compile({ surface: surfaceGuard } as Parameters<ReturnType<typeof compileGuardPlan<unknown, Seed>>>[0])
        : compile({ surface: surfaceGuard, operation: spec.guard } as Parameters<
            ReturnType<typeof compileGuardPlan<unknown, Seed>>
          >[0]);
    const declaration = {
      inputSchema,
      guardPlan,
      handler: spec.handler,
    } as unknown as BoundDeclaration<z.ZodObject, unknown, object>;
    const normalizedPath = segments.length === 0 ? "/" : `/${segments.join("/")}`;
    const pattern = `^/${segments.map((segment) => (segment.startsWith(":") ? "([^/]+)" : escapeRouteSegment(segment))).join("")}`;
    const pathTail =
      segments.length === 0
        ? ""
        : segments.map((segment) => (segment.startsWith(":") ? "([^/]+)" : escapeRouteSegment(segment))).join("/");
    const specSnapshot = Object.freeze({
      id: spec.id,
      method: spec.method,
      path: normalizedPath,
      pathSegments: Object.freeze(segments),
      description: spec.description,
      ...(spec.tags === undefined ? {} : { tags: Object.freeze([...spec.tags]) }),
      ...(spec.hidden === undefined ? {} : { hidden: spec.hidden }),
      ...(spec.pathParams === undefined ? {} : { pathParams: spec.pathParams }),
      ...(spec.queryParams === undefined ? {} : { queryParams: spec.queryParams }),
      ...(spec.body === undefined ? {} : { body: spec.body }),
      ...(spec.outputSchema === undefined ? {} : { outputSchema: spec.outputSchema }),
      ...(spec.response === undefined
        ? {}
        : {
            response: Object.freeze({
              ...spec.response,
              ...(spec.response.headers === undefined ? {} : { headers: Object.freeze({ ...spec.response.headers }) }),
            }),
          }),
      ...(spec.responses === undefined
        ? {}
        : {
            responses: Object.freeze(
              spec.responses.map((response) =>
                Object.freeze({
                  ...response,
                  ...(response.headers === undefined ? {} : { headers: Object.freeze([...response.headers]) }),
                }),
              ),
            ),
          }),
    });
    const entry = Object.freeze({
      spec: specSnapshot,
      declaration,
      pathPattern: new RegExp(pattern === "^/" ? "^/$" : `^/${pathTail}/?$`),
      paramNames: Object.freeze([...paramNames]),
      openApiPath: `/api${
        normalizedPath === "/"
          ? ""
          : normalizedPath
              .split("/")
              .map((segment) => (segment.startsWith(":") ? `{${segment.slice(1)}}` : segment))
              .join("/")
      }`,
    });
    const invoke = (
      rawInputs: unknown,
      base: InvocationBase<Seed>,
    ): Promise<InvocationOutcome<unknown>> =>
      invokeBound({ declaration, rawInputs, base });
    httpInvocations.set(
      entry,
      (rawInputs, base) =>
        options.decorateInvoke === undefined
          ? invoke(rawInputs, base as InvocationBase<Seed>)
          : options.decorateInvoke(publicSpec, invoke, rawInputs, base as InvocationBase<Seed>),
    );
    registered.push(entry);
  }
  return Object.freeze({ routes: Object.freeze(registered) });
}

/** Invokes one catalog route through its startup-selected declaration wrapper. */
export function invokeRegisteredHttpRoute<Seed extends object>(
  /** Bound catalog route selected by the native binder. */
  route: RegisteredHttpRoute,
  /** Raw bound values passed unchanged to the one D2 parse. */
  rawInputs: unknown,
  /** Exact request source, signal, and seed locals. */
  base: InvocationBase<Seed>,
): Promise<InvocationOutcome<unknown>> {
  const invoke = httpInvocations.get(route);
  if (invoke === undefined) throw new TypeError("Invalid HTTP route catalog registration");
  return invoke(rawInputs, base);
}

/** Finds the unique route for a request method and mount-relative pathname. */
export function matchHttpCatalogRoute(
  /** Immutable route catalog. */
  catalog: HttpRouteCatalog,
  /** Request method. */
  method: string,
  /** Mount-relative pathname. */
  pathname: string,
):
  | {
      /** Successful exact catalog match. */
      ok: true;
      /** Registered route. */
      route: RegisteredHttpRoute;
      /** Raw URL path captures. */
      captures: readonly string[];
    }
  | {
      /** No catalog route accepted the request method and path. */
      ok: false;
    } {
  const upper = method.toUpperCase();
  for (const route of catalog.routes) {
    if (route.spec.method !== upper) continue;
    const match = route.pathPattern.exec(pathname);
    if (match !== null) return { ok: true, route, captures: match.slice(1) };
  }
  return { ok: false };
}

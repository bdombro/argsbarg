/*
Generates OpenAPI 3.1 documents from explicit REST route catalogs.
The discovery document and dispatch catalog share one fixed registration snapshot.
*/

import { toJsonSchema } from "../core/zod-schema.ts";
import { documentMediaType } from "./media.ts";
import type { HttpRouteCatalog, RegisteredHttpRoute } from "./routes.ts";
import { defaultSuccessStatus } from "./routes.ts";
import { dereferenceJsonSchema } from "./schema-deref.ts";

/** Required identity for a catalog-owned OpenAPI document. */
export interface HttpCatalogOpenApiOptions {
  /** OpenAPI document title. */
  title: string;
  /** OpenAPI document version. */
  version: string;
  /** Optional document description. */
  description?: string;
}

/** Standard REST error shape for invocation-level failures. */
const HTTP_ERROR_SCHEMA = {
  type: "object",
  properties: {
    error: {
      type: "object",
      properties: {
        code: { type: "string" },
        message: { type: "string" },
        details: {},
      },
      required: ["code", "message"],
    },
  },
  required: ["error"],
} as const;

/** Builds one schema-bearing response entry. */
function documentedResponse(
  /** Response description. */
  description: string,
  /** Optional response schema. */
  schema?: Record<string, unknown>,
  /** Fixed native media type; omit for framework-negotiated responses. */
  contentType?: string,
): Record<string, unknown> {
  return {
    description,
    ...(schema === undefined ? {} : {
      content: contentType === undefined
        ? { "application/json; charset=utf-8": { schema }, [documentMediaType.yaml]: { schema } }
        : { [contentType]: { schema } },
    }),
  };
}

/** Converts an object schema into its dereferenced property map. */
function objectProperties(schema: import("zod").ZodObject): Record<string, Record<string, unknown>> {
  const properties = dereferenceJsonSchema(toJsonSchema(schema, "input")).properties;
  return typeof properties === "object" && properties !== null
    ? (properties as Record<string, Record<string, unknown>>)
    : {};
}

/** Returns the required property names from one Zod object schema. */
function objectRequired(schema: import("zod").ZodObject): ReadonlySet<string> {
  const required = dereferenceJsonSchema(toJsonSchema(schema, "input")).required;
  return new Set(Array.isArray(required) ? (required as string[]) : []);
}

/** Builds exact path and query parameter entries for one route. */
function routeParameters(route: RegisteredHttpRoute): Record<string, unknown>[] {
  const parameters: Record<string, unknown>[] = [];
  if (route.spec.pathParams !== undefined) {
    const properties = objectProperties(route.spec.pathParams);
    for (const name of route.paramNames) {
      const { description, ...schema } = properties[name] ?? { type: "string" };
      parameters.push({
        name,
        in: "path",
        required: true,
        ...(typeof description === "string" ? { description } : {}),
        schema,
      });
    }
  }
  if (route.spec.queryParams !== undefined) {
    const properties = objectProperties(route.spec.queryParams);
    const required = objectRequired(route.spec.queryParams);
    for (const [name, property] of Object.entries(properties)) {
      const { description, ...schema } = property;
      parameters.push({
        name,
        in: "query",
        required: required.has(name),
        style: "form",
        explode: true,
        ...(typeof description === "string" ? { description } : {}),
        schema,
      });
    }
  }
  return parameters;
}

/** Documents the same request schema for JSON and YAML. */
function requestBody(route: RegisteredHttpRoute): Record<string, unknown> | undefined {
  if (route.spec.body === undefined) return undefined;
  const schema = dereferenceJsonSchema(toJsonSchema(route.spec.body, "input"));
  return {
    required: false,
    content: {
      [documentMediaType.json]: { schema },
      [documentMediaType.yaml]: { schema },
    },
  };
}

/** Builds ordinary, native, and standard error responses for one route. */
function responses(route: RegisteredHttpRoute): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const response of route.spec.responses ?? []) {
    const schema =
      response.schema === undefined ? undefined : dereferenceJsonSchema(toJsonSchema(response.schema, "output"));
    result[String(response.status)] = documentedResponse(
      response.description,
      schema,
      response.contentType ?? "application/json; charset=utf-8",
    );
    if (response.headers !== undefined && response.headers.length > 0) {
      (result[String(response.status)] as Record<string, unknown>).headers = Object.fromEntries(
        response.headers.map((name) => [name, { schema: { type: "string" } }]),
      );
    }
  }
  if (route.spec.outputSchema !== undefined) {
    const status = route.spec.response?.status ?? defaultSuccessStatus(route.spec.method, true);
    result[String(status)] = documentedResponse(
      "Successful invocation",
      dereferenceJsonSchema(toJsonSchema(route.spec.outputSchema, "output")),
    );
  }
  for (const status of ["400", "403", "404", "415", "500"] as const) {
    result[status] ??= documentedResponse(
      status === "400"
        ? "Invalid REST input"
        : status === "403"
          ? "Invocation denied"
          : status === "404"
            ? "No route matched"
            : status === "415"
              ? "Unsupported body media type"
              : "Unexpected invocation failure",
      HTTP_ERROR_SCHEMA as unknown as Record<string, unknown>,
    );
  }
  return result;
}

/** Generates one OpenAPI document from the immutable explicit REST catalog. */
export function generateHttpCatalogOpenApi(
  /** Fixed route snapshot shared with dispatch. */
  catalog: HttpRouteCatalog,
  /** Stable application identity. */
  info: HttpCatalogOpenApiOptions,
): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  const tags = new Set<string>();
  for (const route of catalog.routes) {
    if (route.spec.hidden) continue;
    const routeTags = route.spec.tags ?? [
      route.spec.path.split("/").find((segment) => segment.length > 0 && !segment.startsWith(":")) ?? route.spec.id,
    ];
    for (const tag of routeTags) tags.add(tag);
    const operation: Record<string, unknown> = {
      tags: [...routeTags],
      operationId: route.spec.id,
      description: route.spec.description,
      responses: responses(route),
    };
    const parameters = routeParameters(route);
    if (parameters.length > 0) operation.parameters = parameters;
    const body = requestBody(route);
    if (body !== undefined) operation.requestBody = body;
    const pathItem = paths[route.openApiPath] ?? {};
    pathItem[route.spec.method.toLowerCase()] = operation;
    paths[route.openApiPath] = pathItem;
  }
  return {
    openapi: "3.1.0",
    info: {
      title: info.title,
      version: info.version,
      ...(info.description === undefined ? {} : { description: info.description }),
    },
    tags: [...tags].sort().map((name) => ({ name })),
    paths,
  };
}

/** Generates the public OpenAPI document for one explicit route catalog. */
export function generateOpenApi(
  /** Fixed route catalog. */
  catalog: HttpRouteCatalog,
  /** Stable application identity. */
  info: HttpCatalogOpenApiOptions,
): Record<string, unknown> {
  return generateHttpCatalogOpenApi(catalog, info);
}

/** Returns a pretty-printed catalog-owned OpenAPI document. */
export function openApiJson(
  /** Fixed route catalog. */
  catalog: HttpRouteCatalog,
  /** Stable application identity. */
  info: HttpCatalogOpenApiOptions,
): string {
  return `${JSON.stringify(generateOpenApi(catalog, info), null, 2)}\n`;
}

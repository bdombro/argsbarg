/*
Focused tests for catalog-owned OpenAPI and the in-process REST dispatch seam.
*/

import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { allow } from "../core/invocation.ts";
import { dispatchHttpRequest } from "./dispatch.ts";
import { generateHttpCatalogOpenApi, generateOpenApi } from "./openapi.ts";
import { createHttpCatalog, route } from "./routes.ts";

/** Catalog fixture covering disjoint source schemas, native output, and hidden visibility. */
function openApiCatalog() {
  return createHttpCatalog([
    route()({
      id: "createReport",
      method: "POST",
      path: "/projects/:id/reports",
      description: "Create a report.",
      pathParams: z.strictObject({ id: z.string().describe("Project ID.") }),
      queryParams: z.strictObject({
        tags: z.array(z.string()).default([]).describe("Repeated tag filter."),
        dryRun: z.boolean().optional(),
      }),
      body: z.strictObject({ format: z.enum(["short", "long"]).describe("Report format.") }),
      outputSchema: z.strictObject({ report: z.string() }),
      response: { status: 202 },
      handler: (ctx) => ({ report: `${ctx.inputs.id}:${ctx.inputs.format}` }),
    }),
    route()({
      id: "downloadReport",
      method: "GET",
      path: "/reports/:id/download",
      description: "Download a report.",
      pathParams: z.strictObject({ id: z.string() }),
      responses: [
        {
          status: 200,
          description: "Report file.",
          contentType: "application/octet-stream",
          headers: ["Content-Disposition"],
        },
      ],
      hidden: true,
      handler: (ctx) => new Response(ctx.inputs.id),
    }),
  ]);
}

test("catalog OpenAPI uses external /api paths, exact operation IDs, and disjoint parameter locations", () => {
  const document = generateHttpCatalogOpenApi(openApiCatalog(), {
    title: "Reports",
    version: "1.0.0",
    description: "Report API.",
  }) as {
    openapi: string;
    tags: { name: string }[];
    paths: Record<string, { post: Record<string, unknown> }>;
  };
  assert.equal(document.openapi, "3.1.0");
  assert.deepEqual(Object.keys(document.paths), ["/api/projects/{id}/reports"]);
  const operation = document.paths["/api/projects/{id}/reports"]?.post;
  assert.equal(operation?.operationId, "createReport");
  assert.deepEqual(operation?.tags, ["projects"]);
  const parameters = operation?.parameters as { name: string; in: string; style?: string; explode?: boolean }[];
  assert.deepEqual(
    parameters.map(({ name, in: location }) => ({ name, in: location })),
    [
      { name: "id", in: "path" },
      { name: "tags", in: "query" },
      { name: "dryRun", in: "query" },
    ],
  );
  assert.equal(parameters[1]?.style, "form");
  assert.equal(parameters[1]?.explode, true);
  const requestBody = operation?.requestBody as {
    content: { "application/json": { schema: Record<string, unknown> } };
  };
  assert.deepEqual(requestBody.content["application/json"].schema.required, ["format"]);
  assert.deepEqual(document.tags, [{ name: "projects" }]);
  assert.equal(JSON.stringify(document).includes("/api-rpc"), false);
  assert.equal(JSON.stringify(document).includes("/tools/"), false);
});

test("generateOpenApi overload consumes the same catalog object as dispatch", () => {
  const catalog = openApiCatalog();
  assert.deepEqual(
    generateOpenApi(catalog, { title: "Reports", version: "1.0.0" }),
    generateHttpCatalogOpenApi(catalog, { title: "Reports", version: "1.0.0" }),
  );
});

test("OpenAPI preserves native response metadata and ordinary output defaults", () => {
  const native = createHttpCatalog([
    route()({
      id: "download",
      method: "GET",
      path: "/download",
      description: "Download.",
      responses: [{ status: 206, description: "Partial content", contentType: "application/octet-stream" }],
      handler: () => new Response(new Uint8Array([1]), { status: 206 }),
    }),
  ]);
  const document = generateHttpCatalogOpenApi(native, { title: "Files", version: "1" }) as {
    paths: Record<string, { get: { responses: Record<string, Record<string, unknown>> } }>;
  };
  const responses = document.paths["/api/download"]?.get.responses;
  assert.ok(responses?.["206"]);
  assert.ok(responses?.["400"]);
  assert.ok(responses?.["500"]);
});

test("dispatch performs one parse, one guard plan, and one handler for a mixed request", async () => {
  let parses = 0;
  let guards = 0;
  let handlers = 0;
  const catalog = createHttpCatalog(
    [
      route<{ requestId: string }>()({
        id: "invoke",
        method: "POST",
        path: "/projects/:id/reports",
        description: "Invoke.",
        pathParams: z.strictObject({
          id: z.string().refine(() => {
            parses += 1;
            return true;
          }),
        }),
        queryParams: z.strictObject({ dryRun: z.boolean() }),
        body: z.strictObject({ format: z.string().transform((text) => text.toUpperCase()) }),
        outputSchema: z.strictObject({ format: z.string(), requestId: z.string(), caller: z.string() }),
        guard: (ctx) => {
          guards += 1;
          return allow({ caller: ctx.inputs.id });
        },
        handler: (ctx) => {
          handlers += 1;
          assert.equal(ctx.inputs.format, "PDF");
          return { format: ctx.inputs.format, requestId: ctx.locals.requestId, caller: ctx.locals.caller };
        },
      }),
    ],
    {
      guard: () => true,
    },
  );
  const response = await dispatchHttpRequest(
    catalog,
    new Request("http://example.test/api/projects/alpha/reports?dryRun=true", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"format":"pdf"}',
    }),
    { locals: { requestId: "request" } },
  );
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { format: "PDF", requestId: "request", caller: "alpha" });
  assert.equal(parses, 1);
  assert.equal(guards, 1);
  assert.equal(handlers, 1);
});

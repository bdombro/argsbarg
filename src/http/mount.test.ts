/*
Focused acceptance tests for the fixed REST HTTP mount.
They use in-process Web requests and synthetic streams only.
*/

import assert from "node:assert/strict";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { deny } from "../core/invocation.ts";
import type { HttpWireContext } from "../core/types.ts";
import { createHttpMount, type HttpMountAccess } from "./mount.ts";
import { createHttpCatalog, route } from "./routes.ts";

/** Builds one catalog and captures the exact request signal seen by a handler. */
function fixture() {
  const observed: {
    invocations: number;
    signals: AbortSignal[];
    locals: object[];
    sources: { source: string; header: string | undefined; hasEnv: boolean }[];
    hooks: string[];
    responses: HttpMountAccess[];
    failureCount: number;
  } = {
    invocations: 0,
    signals: [],
    locals: [],
    sources: [],
    hooks: [],
    responses: [],
    failureCount: 0,
  };
  const catalog = createHttpCatalog([
    route<{ requestId: string }>()({
      id: "stream-report",
      method: "POST",
      path: "/reports/:id",
      description: "Stream a report.",
      pathParams: z.strictObject({ id: z.string() }),
      queryParams: z.strictObject({ format: z.enum(["text", "json"]).optional() }),
      body: z.strictObject({ label: z.string() }),
      responses: [
        { status: 207, description: "Streamed report", contentType: "text/plain; charset=utf-8" },
        { status: 500, description: "Failed report" },
      ],
      handler: (context) => {
        observed.invocations += 1;
        observed.signals.push(context.signal);
        observed.locals.push(context.locals);
        observed.sources.push({
          source: context.source,
          header: context.headers?.get("X-Api-Test"),
          hasEnv: "env" in context,
        });
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("first-"));
              queueMicrotask(() => {
                controller.enqueue(new TextEncoder().encode("second"));
                controller.close();
              });
            },
          }),
          {
            status: 207,
            headers: {
              "content-type": "text/plain; charset=utf-8",
              "set-cookie": "session=value",
            },
          },
        );
      },
    }),
    route<{ requestId: string }>()({
      id: "hidden",
      method: "GET",
      path: "/hidden",
      description: "Hidden but callable.",
      hidden: true,
      outputSchema: z.strictObject({ ok: z.literal(true) }),
      handler: () => ({ ok: true as const }),
    }),
    route<{ requestId: string }>()({
      id: "denied",
      method: "GET",
      path: "/denied",
      description: "Deny a report.",
      outputSchema: z.strictObject({ ok: z.literal(true) }),
      guard: () =>
        deny({
          code: "SCOPE_REQUIRED",
          message: "Report access required",
          http: { status: 401 },
          challenge: { scheme: "bearer", error: "insufficient_scope", scopes: ["reports.read"] },
        }),
      handler: () => {
        throw new Error("Denied handler must not run");
      },
    }),
    route<{ requestId: string }>()({
      id: "broken",
      method: "GET",
      path: "/broken",
      description: "Throw unexpectedly.",
      outputSchema: z.strictObject({ ok: z.literal(true) }),
      handler: () => {
        throw new Error("private handler failure");
      },
    }),
  ]);
  const mount = createHttpMount({
    catalog,
    identity: { title: "Fixture API", version: "1.2.3", description: "Fixture REST." },
    trustProxy: true,
    hooks: {
      onRequest: (wire: HttpWireContext) => {
        observed.hooks.push(`request:${wire.path}`);
      },
      onResponse: ({ status }) => {
        observed.hooks.push(`response:${status}`);
      },
      onError: ({ failureKind }) => {
        observed.failureCount += 1;
        observed.hooks.push(`error:${failureKind}`);
      },
    },
    observeAccess: (access) => {
      observed.responses.push(access);
    },
  });
  return { catalog, mount, observed };
}

/** Calls a mount exactly as the accepted listener contract does. */
async function call(mount: ReturnType<typeof createHttpMount>, request: Request): Promise<Response> {
  return mount.handle(request, { signal: request.signal });
}

test("mount claims only the fixed /api prefix and preserves request context and streaming", async () => {
  const { mount, observed } = fixture();
  assert.deepEqual(mount.claims, [{ kind: "prefix", path: "/api" }]);
  const controller = new AbortController();
  const request = new Request("http://fixture.test/api/reports/alpha?format=text", {
    method: "POST",
    headers: {
      accept: "application/yaml",
      "content-type": "application/json",
      "x-api-test": "header-only",
      "x-forwarded-for": "203.0.113.2, 10.0.0.1",
    },
    body: '{"label":"report"}',
    signal: controller.signal,
  });
  const response = await call(mount, request);
  assert.equal(observed.signals[0], request.signal);
  assert.deepEqual(observed.sources[0], {
    source: "http",
    header: "header-only",
    hasEnv: false,
  });
  assert.equal(response.status, 207);
  assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.equal(response.headers.get("set-cookie"), "session=value");
  assert.equal(observed.responses[0]?.clientIp, "203.0.113.2");
  assert.equal(observed.locals.length, 1);
  assert.match((observed.locals[0] as { requestId: string }).requestId, /^[0-9a-f-]{36}$/i);
  assert.deepEqual(observed.hooks, ["request:/api/reports/alpha", "response:207"]);
  const reader = response.body?.getReader();
  assert.ok(reader);
  const first = await reader.read();
  assert.equal(new TextDecoder().decode(first.value), "first-");
  assert.equal(first.done, false);
  const second = await reader.read();
  assert.equal(new TextDecoder().decode(second.value), "second");
  assert.equal(second.done, false);
  assert.equal((await reader.read()).done, true);
  assert.equal(observed.invocations, 1);

  const again = await call(
    mount,
    new Request("http://fixture.test/api/reports/other", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"label":"again"}',
    }),
  );
  await again.text();
  assert.equal(observed.invocations, 2);
  assert.notEqual(observed.locals[0], observed.locals[1]);
});

test("REST negotiates YAML independently for input and output and preserves structured errors", async () => {
  const schema = z.strictObject({ label: z.string() });
  let invoked = 0;
  const mount = createHttpMount({
    catalog: createHttpCatalog([
      route()({
        id: "echo",
        method: "POST",
        path: "/echo",
        description: "Echo.",
        body: schema,
        outputSchema: schema,
        response: { headers: { vary: "Origin" } },
        handler: ({ inputs }) => {
          invoked += 1;
          return inputs;
        },
      }),
    ]),
    identity: { title: "Test", version: "1" },
  });
  const send = (body: string, type: string, accept?: string) =>
    call(mount, new Request("http://fixture.test/api/echo", {
      method: "POST",
      headers: { "content-type": type, ...(accept === undefined ? {} : { accept }) },
      body,
    }));

  const json = await send("label: report", "application/yaml; charset=UTF-8");
  assert.equal(json.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(json.headers.get("vary"), "Origin, Accept");
  assert.deepEqual(await json.json(), { label: "report" });

  const yaml = await send('{"label":"report"}', "application/json", "application/json;q=0.2, application/yaml");
  assert.equal(yaml.status, 201);
  assert.equal(yaml.headers.get("content-type"), "application/yaml; charset=utf-8");
  assert.equal(yaml.headers.get("vary"), "Origin, Accept");
  assert.deepEqual(parseYaml(await yaml.text()), { label: "report" });

  const preferJson = await send("label: report", "application/yaml", "application/yaml;q=0, */*");
  assert.equal(preferJson.headers.get("content-type"), "application/json; charset=utf-8");

  for (const body of ["label: one\nlabel: two", "label: &label one\ncopy: *label", "label: !custom report", "label: one\n---\nlabel: two"]) {
    const invalid = await send(body, "application/yaml", "application/yaml");
    assert.equal(invalid.status, 400);
    assert.equal(invalid.headers.get("content-type"), "application/yaml; charset=utf-8");
    assert.equal(parseYaml(await invalid.text()).error.code, "INVALID_YAML");
  }
  const invalidInput = await send("label: 42", "application/yaml", "application/yaml");
  assert.equal(invalidInput.status, 400);
  assert.equal(parseYaml(await invalidInput.text()).error.code, "INVALID_INPUT");
  assert.equal(invoked, 3);
});

test("discovery and docs use the one catalog and exact /api locations", async () => {
  const { mount } = fixture();
  const openApi = await call(mount, new Request("http://fixture.test/api/openapi.json"));
  assert.equal(openApi.status, 200);
  assert.equal(openApi.headers.get("access-control-allow-origin"), "*");
  const document = (await openApi.json()) as {
    info: { title: string; version: string };
    paths: Record<string, unknown>;
  };
  assert.deepEqual(document.info, {
    title: "Fixture API",
    version: "1.2.3",
    description: "Fixture REST.",
  });
  assert.ok(document.paths["/api/reports/{id}"]);
  assert.equal(document.paths["/api/hidden"], undefined);

  const docs = await call(mount, new Request("http://fixture.test/api/docs"));
  assert.equal(docs.status, 200);
  assert.match(await docs.text(), /url: "\/api\/openapi\.json"/);

  for (const path of ["/openapi.json", "/swagger", "/api-rpc", "/rpc", "/tools/list", "/health/liveness"]) {
    const response = await call(mount, new Request(`http://fixture.test${path}`));
    assert.equal(response.status, 404, path);
  }
});

test("preflight, trace, CORS, validation, and hidden route calls finish exactly once", async () => {
  const { mount, observed } = fixture();
  const preflight = await call(mount, new Request("http://fixture.test/api/reports/alpha", { method: "OPTIONS" }));
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get("access-control-allow-methods") ?? "", /OPTIONS/);
  assert.equal(observed.signals.length, 0);

  const traceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
  const traced = await call(mount, new Request("http://fixture.test/api/hidden", { headers: { traceparent } }));
  assert.equal(traced.status, 200);
  assert.match(traced.headers.get("traceparent") ?? "", /^00-0af7651916cd43dd8448eb211c80319c-[\da-f]{16}-01$/);

  const invalid = await call(
    mount,
    new Request("http://fixture.test/api/reports/alpha", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
  );
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), {
    error: {
      code: "INVALID_INPUT",
      message: "Input validation failed",
      details: {
        issues: [
          {
            path: ["label"],
            code: "invalid_type",
            message: "Invalid input: expected string, received undefined",
          },
        ],
        issueCount: 1,
      },
    },
  });
  assert.equal(observed.failureCount, 0);
});

test("hook and adapter failures become one safe CORS response", async () => {
  const hooks: string[] = [];
  const catalog = createHttpCatalog([
    route()({
      id: "ok",
      method: "GET",
      path: "/ok",
      description: "Return ok.",
      outputSchema: z.strictObject({ ok: z.literal(true) }),
      handler: () => ({ ok: true as const }),
    }),
  ]);
  const mount = createHttpMount({
    catalog,
    identity: { title: "Failure", version: "1.0.0" },
    hooks: {
      onRequest: () => {
        hooks.push("request");
        throw new Error("private request failure");
      },
      onError: () => {
        hooks.push("error");
      },
    },
  });
  const response = await call(mount, new Request("http://fixture.test/api/ok"));
  assert.equal(response.status, 500);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.deepEqual(await response.json(), {
    error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred" },
  });
  assert.deepEqual(hooks, ["request", "error"]);

  const mismatched = await mount.handle(new Request("http://fixture.test/api/ok"), {
    signal: new AbortController().signal,
  });
  assert.equal(mismatched.status, 500);
  assert.equal(mismatched.headers.get("access-control-allow-origin"), "*");
  assert.deepEqual(await mismatched.json(), {
    error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred" },
  });
});

test("denials and terminal invocation outcomes retain wire semantics and finish once", async () => {
  const { mount, observed } = fixture();
  const denied = await call(mount, new Request("http://fixture.test/api/denied"));
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.get("www-authenticate"), 'Bearer error="insufficient_scope", scope="reports.read"');
  assert.deepEqual(await denied.json(), {
    error: { code: "SCOPE_REQUIRED", message: "Report access required" },
  });
  assert.equal(observed.failureCount, 0);

  const failed = await call(mount, new Request("http://fixture.test/api/broken"));
  assert.equal(failed.status, 500);
  assert.deepEqual(await failed.json(), {
    error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred" },
  });
  assert.equal(observed.failureCount, 1);
  assert.equal(observed.hooks.filter((hook) => hook === "error:unexpected").length, 1);
});

test("throwing access observation cannot replace a successful response", async () => {
  const catalog = createHttpCatalog([
    route()({
      id: "observed",
      method: "GET",
      path: "/observed",
      description: "Return an observed result.",
      outputSchema: z.strictObject({ ok: z.literal(true) }),
      handler: () => ({ ok: true as const }),
    }),
  ]);
  let calls = 0;
  const mount = createHttpMount({
    catalog,
    identity: { title: "Observation", version: "1.0.0" },
    hooks: {
      onResponse: () => {
        calls += 1;
      },
      onError: () => {
        throw new Error("onError must not run");
      },
    },
    observeAccess: () => {
      throw new Error("observation failed");
    },
  });
  const response = await call(mount, new Request("http://fixture.test/api/observed"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(calls, 1);
});

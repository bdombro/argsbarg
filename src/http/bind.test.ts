/*
Focused tests for native REST path, query, body, header, and cancellation binding.
*/

import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { bindHttpCall, bindHttpRequest } from "./bind.ts";
import { createHttpCatalog, route } from "./routes.ts";

/** Shared mixed-source route used by binding acceptance tests. */
function mixedCatalog() {
  return createHttpCatalog([
    route()({
      id: "create-report",
      method: "POST",
      path: "/projects/:id/reports",
      description: "Create a report.",
      pathParams: z.strictObject({ id: z.string() }),
      queryParams: z.strictObject({
        dryRun: z.boolean().optional(),
        tag: z.array(z.string()).optional(),
        count: z.number().optional(),
        filter: z.strictObject({ active: z.boolean() }).optional(),
        state: z.strictObject({ ok: z.boolean() }).optional(),
        mode: z.enum(["short", "long"]).optional(),
      }),
      body: z.strictObject({ format: z.string().optional() }),
      outputSchema: z.strictObject({ ok: z.literal(true) }),
      handler: () => ({ ok: true as const }),
    }),
  ]);
}

/** Returns a concise binder failure assertion for table-driven wire cases. */
function failure(bound: Awaited<ReturnType<typeof bindHttpRequest>>) {
  assert.equal(bound.ok, false);
  if (bound.ok) throw new Error("Expected binding failure");
  return bound;
}

test("binder creates one flat raw object with exact HTTP source, signal, and fresh locals", async () => {
  const controller = new AbortController();
  const request = new Request(
    "http://example.test/api/projects/alpha%20one/reports?dryRun=true&tag=short&tag=pdf&count=3.5&filter=%7B%22active%22%3Atrue%7D&mode=short",
    {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8", "x-test": "present" },
      body: '{"format":"pdf"}',
      signal: controller.signal,
    },
  );
  const seed = { requestId: "request" };
  const first = await bindHttpRequest(mixedCatalog(), request, { locals: seed });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.deepEqual(first.rawInputs, {
    id: "alpha one",
    dryRun: true,
    tag: ["short", "pdf"],
    count: 3.5,
    filter: { active: true },
    mode: "short",
    format: "pdf",
  });
  assert.equal(first.base.source, "http");
  assert.equal(first.base.surface, "http");
  assert.equal(first.base.signal, request.signal);
  assert.equal(first.base.headers.get("X-Test"), "present");
  assert.equal(first.base.headers.get("missing"), undefined);
  assert.equal("env" in first.base, false);
  assert.notEqual(first.base.locals, seed);
});

test("generated call binding matches native path, query, and body semantics without a Request", async () => {
  const catalog = mixedCatalog();
  const generated = bindHttpCall(catalog, {
    method: "post",
    fullPath: "/api/projects/alpha%20one/reports?dryRun=true&tag=short&filter=%7B%22active%22%3Atrue%7D",
    body: { format: "pdf" },
  });
  const native = await bindHttpRequest(
    catalog,
    new Request(
      "http://example.test/api/projects/alpha%20one/reports?dryRun=true&tag=short&filter=%7B%22active%22%3Atrue%7D",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"format":"pdf"}',
      },
    ),
  );
  assert.equal(generated.ok, true);
  assert.equal(native.ok, true);
  if (!generated.ok || !native.ok) return;
  assert.equal(generated.route, native.route);
  assert.deepEqual(generated.rawInputs, native.rawInputs);
  assert.deepEqual(generated.rawInputs, {
    id: "alpha one",
    dryRun: true,
    tag: ["short"],
    filter: { active: true },
    format: "pdf",
  });

  const noBodyRoute = bindHttpCall(catalog, { method: "POST", fullPath: "/api/projects/id/reports" });
  assert.equal(noBodyRoute.ok, true);
  if (noBodyRoute.ok) assert.deepEqual(noBodyRoute.rawInputs, { id: "id" });
});

test("query binding preserves empty strings and leaves invalid scalars for the sole Zod parse", async () => {
  const bound = await bindHttpRequest(
    mixedCatalog(),
    new Request("http://example.test/api/projects/id/reports?dryRun=&tag=&count=01", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
  );
  assert.equal(bound.ok, true);
  if (!bound.ok) return;
  assert.deepEqual(bound.rawInputs, {
    id: "id",
    dryRun: "",
    tag: [""],
    count: "01",
  });
});

test("query object data may contain true or false ok fields without becoming binder failures", async () => {
  for (const state of [{ ok: true }, { ok: false }]) {
    const bound = await bindHttpRequest(
      mixedCatalog(),
      new Request(`http://example.test/api/projects/id/reports?state=${encodeURIComponent(JSON.stringify(state))}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    assert.equal(bound.ok, true);
    if (!bound.ok) continue;
    assert.deepEqual(bound.rawInputs, { id: "id", state });
  }
});

test("binder rejects unknown, repeated scalar, malformed object query, and invalid path encoding", async () => {
  const cases = [
    ["http://example.test/api/projects/id/reports?unknown=x", "UNKNOWN_QUERY"],
    ["http://example.test/api/projects/id/reports?toString=x", "UNKNOWN_QUERY"],
    ["http://example.test/api/projects/id/reports?dryRun=true&dryRun=false", "REPEATED_QUERY"],
    ["http://example.test/api/projects/id/reports?filter=%7Bbad", "INVALID_QUERY_JSON"],
    ["http://example.test/api/projects/%ZZ/reports", "INVALID_PATH"],
  ] as const;
  for (const [url, code] of cases) {
    const bound = failure(
      await bindHttpRequest(
        mixedCatalog(),
        new Request(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
      ),
    );
    assert.equal(bound.status, 400);
    assert.equal(bound.code, code);
  }
});

test("body framing accepts empty text and rejects wrong media, JSON roots, and undeclared bodies", async () => {
  const empty = await bindHttpRequest(
    mixedCatalog(),
    new Request("http://example.test/api/projects/id/reports", { method: "POST", body: "   " }),
  );
  assert.equal(empty.ok, true);
  if (empty.ok) assert.deepEqual(empty.rawInputs, { id: "id" });

  const wrongMedia = failure(
    await bindHttpRequest(
      mixedCatalog(),
      new Request("http://example.test/api/projects/id/reports", {
        method: "POST",
        headers: { "content-type": "text/json" },
        body: '{"format":"pdf"}',
      }),
    ),
  );
  assert.equal(wrongMedia.status, 415);
  assert.equal(wrongMedia.code, "UNSUPPORTED_MEDIA_TYPE");

  const wrongCharset = failure(
    await bindHttpRequest(
      mixedCatalog(),
      new Request("http://example.test/api/projects/id/reports", {
        method: "POST",
        headers: { "content-type": 'application/json; charset="utf-8' },
        body: '{"format":"pdf"}',
      }),
    ),
  );
  assert.equal(wrongCharset.code, "UNSUPPORTED_MEDIA_TYPE");

  for (const body of ['{"format":', "null", "[]", '"pdf"']) {
    const result = failure(
      await bindHttpRequest(
        mixedCatalog(),
        new Request("http://example.test/api/projects/id/reports", {
          method: "POST",
          headers: { "content-type": "application/vnd.argsbarg+json" },
          body,
        }),
      ),
    );
    assert.equal(result.status, 400);
    assert.ok(result.code === "INVALID_JSON" || result.code === "INVALID_BODY");
  }

  const noBody = createHttpCatalog([
    route()({
      id: "no-body",
      method: "POST",
      path: "/items",
      description: "Create item.",
      outputSchema: z.string(),
      handler: () => "item",
    }),
  ]);
  const undeclared = failure(
    await bindHttpRequest(
      noBody,
      new Request("http://example.test/api/items", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    ),
  );
  assert.equal(undeclared.code, "BODY_NOT_DECLARED");
});

test("binder rejects unknown mount paths and route misses as 404", async () => {
  const bound = failure(
    await bindHttpRequest(mixedCatalog(), new Request("http://example.test/other/projects/id/reports")),
  );
  assert.equal(bound.status, 404);
  assert.equal(bound.code, "NOT_FOUND");
});

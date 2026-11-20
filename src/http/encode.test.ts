/*
Focused tests for deterministic REST outcomes and native Web Response preservation.
*/

import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { AppError } from "../core/errors.ts";
import type { InvocationOutcome } from "../core/invocation.ts";
import { encodeHttpOutcome, finishHttpResponse, httpErrorResponse } from "./encode.ts";
import { createHttpCatalog, route } from "./routes.ts";

/** Creates the registered route needed for response metadata assertions. */
function registered(method: "GET" | "POST" = "POST") {
  return createHttpCatalog([
    route()({
      id: "result",
      method,
      path: "/result",
      description: "Return a result.",
      outputSchema: z.strictObject({ ok: z.boolean() }),
      response: { status: 202, headers: { "x-route": "present" } },
      handler: () => ({ ok: true }),
    }),
  ]).routes[0];
}

/** Builds a successful shared outcome with no captured process output. */
function ok(result: unknown): InvocationOutcome<unknown> {
  return { kind: "ok", result, stdout: "", stderr: "" };
}

test("encoder preserves native Response identity and leaves its stream unread", async () => {
  let pulls = 0;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("first"));
      controller.enqueue(new TextEncoder().encode("second"));
      controller.close();
    },
    pull() {
      pulls += 1;
    },
  });
  const native = new Response(stream, { status: 207, headers: { "content-type": "application/octet-stream" } });
  const encoded = encodeHttpOutcome(ok(native), registered());
  assert.equal(encoded, native);
  assert.equal(pulls, 0);
  assert.equal(await encoded.text(), "firstsecond");
});

test("ordinary values use declared JSON metadata while undefined and serialization failures are stable errors", async () => {
  const encoded = encodeHttpOutcome(ok({ ok: true }), registered());
  assert.equal(encoded.status, 202);
  assert.equal(encoded.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(encoded.headers.get("x-route"), "present");
  assert.deepEqual(await encoded.json(), { ok: true });

  const absent = encodeHttpOutcome(ok(undefined), registered());
  assert.equal(absent.status, 500);
  assert.deepEqual(await absent.json(), { error: { code: "NO_RESULT", message: "Handler returned no result" } });

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const serialization = encodeHttpOutcome(ok(cyclic), registered());
  assert.equal(serialization.status, 500);
  assert.deepEqual(await serialization.json(), {
    error: { code: "INTERNAL_ERROR", message: "Handler result is not JSON serializable" },
  });
});

test("encoder applies method defaults when no route status is declared", async () => {
  const catalog = createHttpCatalog([
    route()({
      id: "get",
      method: "GET",
      path: "/get",
      description: "Get.",
      outputSchema: z.string(),
      handler: () => "get",
    }),
    route()({
      id: "post",
      method: "POST",
      path: "/post",
      description: "Post.",
      outputSchema: z.string(),
      handler: () => "post",
    }),
  ]);
  assert.equal(encodeHttpOutcome(ok("get"), catalog.routes[0] as NonNullable<(typeof catalog.routes)[0]>).status, 200);
  assert.equal(encodeHttpOutcome(ok("post"), catalog.routes[1] as NonNullable<(typeof catalog.routes)[1]>).status, 201);
});

test("invalid outcomes expose at most ten projected issues and the total count", async () => {
  const schema = z.strictObject(
    Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`field${index}`, z.string()])),
  );
  const parsed = schema.safeParse({});
  assert.equal(parsed.success, false);
  if (parsed.success) return;
  const outcome: InvocationOutcome<unknown> = {
    kind: "invalid",
    error: parsed.error,
    stdout: "secret",
    stderr: "secret",
  };
  const response = encodeHttpOutcome(outcome, registered());
  const body = (await response.json()) as {
    error: { code: string; details: { issues: unknown[]; issueCount: number } };
  };
  assert.equal(response.status, 400);
  assert.equal(body.error.code, "INVALID_INPUT");
  assert.equal(body.error.details.issues.length, 10);
  assert.equal(body.error.details.issueCount, 12);
  assert.equal(JSON.stringify(body).includes("secret"), false);
});

test("denials preserve HTTP metadata and emit a quoted bearer challenge", async () => {
  const outcome: InvocationOutcome<unknown> = {
    kind: "denied",
    denial: {
      code: "SCOPE_REQUIRED",
      message: "Permission required",
      http: { status: 401, headers: { "x-denial": "present" } },
      challenge: { scheme: "bearer", error: "insufficient_scope", scopes: ["reports.read", "reports.write"] },
    },
    stdout: "",
    stderr: "",
  };
  const response = encodeHttpOutcome(outcome, registered());
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("x-denial"), "present");
  assert.equal(
    response.headers.get("www-authenticate"),
    'Bearer error="insufficient_scope", scope="reports.read reports.write"',
  );
  assert.deepEqual(await response.json(), {
    error: { code: "SCOPE_REQUIRED", message: "Permission required" },
  });
});

test("AppError keeps stable metadata, while unknown values remain generic and bad details are omitted", async () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const app = encodeHttpOutcome(
    {
      kind: "error",
      error: new AppError("Conflict", { code: "CONFLICT", httpStatus: 409, details: circular }),
      stdout: "",
      stderr: "",
    },
    registered(),
  );
  assert.equal(app.status, 409);
  assert.deepEqual(await app.json(), { error: { code: "CONFLICT", message: "Conflict" } });

  const unexpected = encodeHttpOutcome(
    { kind: "error", error: new Error("credential detail"), stdout: "", stderr: "" },
    registered(),
  );
  assert.equal(unexpected.status, 500);
  assert.deepEqual(await unexpected.json(), {
    error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred" },
  });
});

test("post-encoding CORS and trace finishing preserves status, stream, and handler headers", async () => {
  const native = new Response("body", {
    status: 206,
    headers: { "set-cookie": "session=value", "content-range": "bytes 0-3/4" },
  });
  const finished = finishHttpResponse(native, {
    cors: { "access-control-allow-origin": "*" },
    trace: { "x-trace-id": "trace" },
  });
  assert.notEqual(finished, native);
  assert.equal(finished.status, 206);
  assert.equal(finished.headers.get("set-cookie"), "session=value");
  assert.equal(finished.headers.get("content-range"), "bytes 0-3/4");
  assert.equal(finished.headers.get("access-control-allow-origin"), "*");
  assert.equal(finished.headers.get("x-trace-id"), "trace");
  assert.equal(await finished.text(), "body");
});

test("wire error helper uses the stable envelope", async () => {
  const response = httpErrorResponse(415, "UNSUPPORTED_MEDIA_TYPE", "JSON required", { field: "body" });
  assert.deepEqual(await response.json(), {
    error: { code: "UNSUPPORTED_MEDIA_TYPE", message: "JSON required", details: { field: "body" } },
  });
});

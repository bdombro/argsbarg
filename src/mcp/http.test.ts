/*
Focused tests for the exact MCP HTTP mount boundary.
They cover admission, header routing, status framing, protocol JSON, first-progress SSE, and disconnect isolation.
*/

import assert from "node:assert/strict";
import { test } from "node:test";
import { deny, type InvocationBase } from "../core/invocation.ts";
import { z } from "zod";
import type { HttpMountContext } from "../server/listener.ts";
import type { McpDispatchResponse } from "./dispatcher.ts";
import { createMcpHttpMount, type McpHttpMiddlewareContext } from "./http.ts";
import { createMcpRegistry, MCP_HANDLER_STARTED, type McpToolRegistration, tool as declareTool } from "./registry.ts";

/** Stable server identity used by all MCP HTTP fixtures. */
const SERVER_INFO = { name: "fixture-app", version: "1.0.0" } as const;

/** Canonical 2026 request metadata used by every successful fixture. */
const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
} as const;

/** Seed locals available to fixture tools and the adapter's progress callback. */
interface Seed {
  /** Verified caller identity supplied only by admission. */
  readonly caller?: string;
  /** Optional transport-owned progress reporter visible through seed locals. */
  readonly reportProgress?: (progress: number, total?: number, message?: string) => void;
}

/** Manually settled fixture promise for deterministic overlap tests. */
interface Resolvable<T = void> {
  /** Promise released by `resolve`. */
  readonly promise: Promise<T>;
  /** Releases the promise exactly once. */
  resolve(value: T): void;
}

/** Creates a deterministic one-shot promise for test coordination. */
function resolvable<T = void>(): Resolvable<T> {
  let resolveValue: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolveValue = resolve;
  });
  return {
    promise,
    resolve: (value) => {
      resolveValue?.(value);
      resolveValue = undefined;
    },
  };
}

/** Creates a protocol request body with optional progress metadata. */
function requestBody(
  method: string,
  params: Record<string, unknown> = {},
  id: string | number | null = 1,
): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    ...(id === null ? {} : { id }),
    method,
    params: { ...params, _meta: META },
  };
}

/** Creates a POST Request with fixture routing headers. */
function post(body: unknown, method: string, name?: string): Request {
  const headers = new Headers({
    "content-type": "application/json",
    "Mcp-Method": method,
    "MCP-Protocol-Version": "2026-07-28",
    ...(name === undefined ? {} : { "Mcp-Name": name }),
  });
  return new Request("http://fixture.test/mcp", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** Returns one active request context tied to the caller-supplied controller. */
function mountContext(controller = new AbortController()): HttpMountContext {
  return { signal: controller.signal };
}

/** Creates a wire-only fixture tool whose invocation closure observes the exact adapter base. */
function tool(
  name: string,
  invoke: (base: InvocationBase<Seed>) => Promise<
    | { readonly kind: "ok"; readonly result: unknown; readonly stdout: ""; readonly stderr: "" }
    | {
        readonly kind: "denied";
        readonly denial: {
          readonly code: string;
          readonly message: string;
          readonly http?: { readonly status?: number; readonly headers?: Readonly<Record<string, string>> };
        };
        readonly stdout: "";
        readonly stderr: "";
      }
    | { readonly kind: "error"; readonly error: unknown; readonly stdout: ""; readonly stderr: "" }
  >,
): McpToolRegistration<Seed> {
  return {
    name,
    description: `Run ${name}.`,
    inputSchema: { type: "object", additionalProperties: true },
    invoke: (_rawInputs, base) => {
      const reportProgress = base.locals.reportProgress;
      const arm =
        typeof reportProgress === "function"
          ? (reportProgress as unknown as Record<PropertyKey, unknown>)[MCP_HANDLER_STARTED]
          : undefined;
      if (typeof arm === "function") arm();
      return invoke(base);
    },
  };
}

/** Builds the focused mount with a fixture admission callback. */
function fixtureMount(
  entries: readonly McpToolRegistration<Seed>[] = [],
  middleware: (
    request: Request,
    context: McpHttpMiddlewareContext,
  ) =>
    | { readonly kind: "next"; readonly locals: Seed }
    | { readonly kind: "respond"; readonly response: Response }
    | Promise<
        | { readonly kind: "next"; readonly locals: Seed }
        | { readonly kind: "respond"; readonly response: Response }
      > = () => ({ kind: "next", locals: { caller: "ada" } }),
) {
  return createMcpHttpMount({
    registry: createMcpRegistry(entries),
    serverInfo: SERVER_INFO,
    instructions: "Fixture instructions.",
    middleware,
  });
}

test("claims exact /mcp and rejects unsupported methods before admission", async () => {
  let admissionCalls = 0;
  const mount = fixtureMount([], () => {
    admissionCalls += 1;
    return { kind: "next", locals: {} };
  });
  assert.deepEqual(mount.claims, [{ kind: "exact", path: "/mcp" }]);

  const response = await mount.handle(new Request("http://fixture.test/mcp"), mountContext());
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "POST");
  assert.equal(await response.text(), "");
  assert.equal(admissionCalls, 0);
});

test("requires routing headers before admission and preserves native admission responses", async () => {
  let admissionCalls = 0;
  const mount = fixtureMount([], () => {
    admissionCalls += 1;
    return {
      kind: "respond",
      response: new Response("challenge", {
        status: 401,
        headers: { "www-authenticate": 'Bearer error="invalid_token"' },
      }),
    };
  });
  const missing = new Request("http://fixture.test/mcp", {
    method: "POST",
    body: JSON.stringify(requestBody("server/discover")),
  });
  const missingResponse = await mount.handle(missing, mountContext());
  assert.equal(missingResponse.status, 400);
  assert.match(await missingResponse.text(), /Mcp-Method/);
  assert.equal(admissionCalls, 0);

  const challenge = await mount.handle(post(requestBody("server/discover"), "server/discover"), mountContext());
  assert.equal(challenge.status, 401);
  assert.equal(challenge.headers.get("www-authenticate"), 'Bearer error="invalid_token"');
  assert.equal(await challenge.text(), "challenge");
  assert.equal(admissionCalls, 1);
});

test("admits before body parsing and returns 4xx for malformed JSON or header/body mismatches", async () => {
  let admissionCalls = 0;
  const mount = fixtureMount([], () => {
    admissionCalls += 1;
    return { kind: "next", locals: {} };
  });

  const malformed = await mount.handle(post("{", "tools/list"), mountContext());
  assert.equal(malformed.status, 400);
  assert.equal(admissionCalls, 1);

  const mismatch = await mount.handle(
    post(requestBody("tools/call", { name: "echo", arguments: {} }), "tools/list", "echo"),
    mountContext(),
  );
  assert.equal(mismatch.status, 400);
  assert.match(await mismatch.text(), /Mcp-Method/);

  const missingName = await mount.handle(
    post(requestBody("tools/call", { name: "echo", arguments: {} }), "tools/call"),
    mountContext(),
  );
  assert.equal(missingName.status, 400);
  assert.match(await missingName.text(), /Mcp-Name/);

  const conflict = await mount.handle(post(requestBody("tools/list"), "tools/list", "unexpected"), mountContext());
  assert.equal(conflict.status, 400);
  assert.match(await conflict.text(), /Mcp-Name/);
});

test("uses appropriate HTTP statuses for protocol failures and accepted notifications", async () => {
  const mount = fixtureMount();
  const invalidMeta = requestBody("tools/list");
  (invalidMeta.params as Record<string, unknown>)._meta = {};
  const protocol = await mount.handle(post(invalidMeta, "tools/list"), mountContext());
  assert.equal(protocol.status, 400);
  assert.equal(protocol.headers.get("content-type"), "application/json");
  assert.equal((await protocol.json()).error.code, -32_020);
  const unknown = await mount.handle(post(requestBody("unimplemented"), "unimplemented"), mountContext());
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error.code, -32_601);

  const notification = await mount.handle(post(requestBody("tools/list", {}, null), "tools/list"), mountContext());
  assert.equal(notification.status, 202);
  assert.equal(await notification.text(), "");
});

test("passes only HTTP header source and admission locals to tool dispatch without scraping denials", async () => {
  let calls = 0;
  let seenHeaders: InvocationBase<Seed>["headers"] | undefined;
  let seenLocals: Seed | undefined;
  const mount = fixtureMount(
    [
      tool("denied", async (base) => {
        calls += 1;
        seenHeaders = base.headers;
        seenLocals = base.locals;
        return {
          kind: "denied",
          denial: {
            code: "FORBIDDEN",
            message: "No access",
            http: { status: 403, headers: { "x-internal": "never-http" } },
          },
          stdout: "",
          stderr: "",
        };
      }),
    ],
    (request, context) => {
      assert.equal(context.headers.get("x-caller"), "authenticated");
      assert.equal(context.method, "tools/call");
      assert.equal(context.name, "denied");
      assert.ok(request instanceof Request);
      return { kind: "next", locals: { caller: context.headers.get("x-caller") } };
    },
  );
  const request = post(requestBody("tools/call", { name: "denied", arguments: {} }), "tools/call", "denied");
  request.headers.set("X-Caller", "authenticated");
  const response = await mount.handle(request, mountContext());

  assert.equal(response.status, 403);
  assert.equal(calls, 1);
  assert.equal(seenHeaders?.get("x-CALLER"), "authenticated");
  assert.equal("env" in (seenLocals as unknown as object), false);
  assert.equal(seenLocals?.caller, "authenticated");
  assert.equal(response.headers.get("x-internal"), "never-http");
  const body = (await response.json()) as { error: { code: string; message: string } };
  assert.deepEqual(body.error, { code: "FORBIDDEN", message: "No access" });
});

test("returns HTTP/challenge denials before SSE even when a guard reports progress", async () => {
  let handlerCalls = 0;
  const registry = createMcpRegistry(
    [
      declareTool<Seed>()({
        name: "protected",
        description: "Protected.",
        inputSchema: z.strictObject({}),
        handler: () => {
          handlerCalls += 1;
          return { ok: true };
        },
      }),
    ],
    {
      guard: ({ locals }) => {
        locals.reportProgress?.(1, 1, "must not open SSE");
        return deny({
          code: "AUTH_REQUIRED",
          message: "Authentication is required.",
          http: { status: 401, headers: { "x-auth": "required" } },
          challenge: { scheme: "bearer", error: "invalid_token", scopes: ["reports.read"] },
        });
      },
    },
  );
  const mount = createMcpHttpMount({
    registry,
    serverInfo: SERVER_INFO,
    middleware: (_request, context) => ({
      kind: "next",
      locals: { caller: context.headers.get("x-caller") },
    }),
  });
  const body = requestBody("tools/call", { name: "protected", arguments: {} });
  (body.params as Record<string, unknown>)._meta = { ...META, progressToken: "auth" };
  const response = await mount.handle(post(body, "tools/call", "protected"), mountContext());

  assert.equal(response.status, 401);
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.equal(response.headers.get("x-auth"), "required");
  assert.equal(
    response.headers.get("www-authenticate"),
    'Bearer error="invalid_token", scope="reports.read"',
  );
  assert.deepEqual(await response.json(), {
    error: { code: "AUTH_REQUIRED", message: "Authentication is required." },
  });
  assert.equal(handlerCalls, 0);
});

test("rejects bare middleware seeds and non-Response respond branches", async () => {
  const bare = createMcpHttpMount({
    registry: createMcpRegistry<Seed>([]),
    serverInfo: SERVER_INFO,
    middleware: (() => ({ caller: "bare" })) as never,
  });
  const invalidRespond = createMcpHttpMount({
    registry: createMcpRegistry<Seed>([]),
    serverInfo: SERVER_INFO,
    middleware: (() => ({ kind: "respond", response: { status: 401 } })) as never,
  });
  assert.equal(
    (await bare.handle(post(requestBody("tools/list"), "tools/list"), mountContext())).status,
    500,
  );
  assert.equal(
    (await invalidRespond.handle(post(requestBody("tools/list"), "tools/list"), mountContext())).status,
    500,
  );
});

test("returns ordinary JSON when dispatch completes before optional first progress", async () => {
  const mount = fixtureMount([
    tool("echo", async (base) => ({
      kind: "ok",
      result: { caller: base.locals.caller },
      stdout: "",
      stderr: "",
    })),
  ]);
  const response = await mount.handle(
    post(requestBody("tools/call", { name: "echo", arguments: {} }), "tools/call", "echo"),
    mountContext(),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.equal((await response.json()).result.structuredContent.caller, "ada");
});

test("upgrades to SSE on first progress and emits subsequent progress plus one terminal result", async () => {
  const release = resolvable();
  const mount = fixtureMount([
    tool("slow", async (base) => {
      base.locals.reportProgress?.(1, 2, "started");
      base.locals.reportProgress?.(2, 2, "finished");
      await release.promise;
      return { kind: "ok", result: { done: true }, stdout: "", stderr: "" };
    }),
  ]);
  const body = requestBody("tools/call", { name: "slow", arguments: {} });
  (body.params as Record<string, unknown>)._meta = { ...META, progressToken: 7 };
  const response = await mount.handle(post(body, "tools/call", "slow"), mountContext());

  assert.equal(response.headers.get("content-type"), "text/event-stream");
  release.resolve();
  const text = await response.text();
  const events = text
    .trim()
    .split("\n\n")
    .map((event) => JSON.parse(event.slice("data: ".length)) as Record<string, unknown>);
  assert.equal(events.length, 3);
  assert.equal((events[0].params as { progress: number }).progress, 1);
  assert.equal((events[1].params as { progress: number }).progress, 2);
  assert.equal((events[2].result as { resultType: string }).resultType, "complete");
});

test("cancelling a progress stream aborts only that request controller", async () => {
  const started = resolvable();
  const aborted = resolvable();
  const transport = new AbortController();
  const mount = fixtureMount([
    tool("stream", async (base) => {
      base.locals.reportProgress?.(1);
      started.resolve();
      await new Promise<void>((resolve) => base.signal.addEventListener("abort", () => resolve(), { once: true }));
      aborted.resolve();
      return { kind: "ok", result: "cancelled", stdout: "", stderr: "" };
    }),
  ]);
  const body = requestBody("tools/call", { name: "stream", arguments: {} });
  (body.params as Record<string, unknown>)._meta = { ...META, progressToken: "stream-token" };
  const response = await mount.handle(post(body, "tools/call", "stream"), mountContext(transport));
  await started.promise;
  assert.equal(response.headers.get("content-type"), "text/event-stream");

  await response.body?.cancel("client disconnected");
  await aborted.promise;
  assert.equal(transport.signal.aborted, false);
});

test("links only the exact listener signal and isolated duplicate HTTP request ids", async () => {
  const startedA = resolvable();
  const startedB = resolvable();
  const abortedA = resolvable();
  let calls = 0;
  const signals: AbortSignal[] = [];
  const mount = fixtureMount([
    tool("wait", async (base) => {
      calls += 1;
      signals.push(base.signal);
      if (calls === 1) {
        startedA.resolve();
        await new Promise<void>((resolve) => base.signal.addEventListener("abort", () => resolve(), { once: true }));
        abortedA.resolve();
      } else {
        startedB.resolve();
      }
      return { kind: "ok", result: { call: calls }, stdout: "", stderr: "" };
    }),
  ]);
  const controllerA = new AbortController();
  const responseA = mount.handle(
    post(requestBody("tools/call", { name: "wait", arguments: {} }, "same"), "tools/call", "wait"),
    mountContext(controllerA),
  );
  const responseB = mount.handle(
    post(requestBody("tools/call", { name: "wait", arguments: {} }, "same"), "tools/call", "wait"),
    mountContext(),
  );

  await Promise.all([startedA.promise, startedB.promise]);
  controllerA.abort(new Error("disconnected"));
  await abortedA.promise;
  const [settledA, settledB] = await Promise.all([responseA, responseB]);
  assert.equal(signals[0]?.aborted, true);
  assert.equal(signals[1]?.aborted, false);
  assert.equal(settledA.status, 200);
  assert.equal(settledB.status, 200);
  assert.equal(calls, 2);
});

test("sanitizes unexpected admission and dispatch failures", async () => {
  const admissionFailure = fixtureMount([], () => {
    throw new Error("secret admission");
  });
  const denied = await admissionFailure.handle(post(requestBody("server/discover"), "server/discover"), mountContext());
  assert.equal(denied.status, 500);
  assert.equal(await denied.text(), '{"error":"Internal server error"}');

  const dispatchFailure = fixtureMount([
    tool("throw", async () => {
      throw new Error("secret dispatch");
    }),
  ]);
  const failed = await dispatchFailure.handle(
    post(requestBody("tools/call", { name: "throw", arguments: {} }), "tools/call", "throw"),
    mountContext(),
  );
  assert.equal(failed.status, 500);
  assert.doesNotMatch(await failed.text(), /secret/);
});

/** Compile-time evidence that protocol dispatcher responses remain the adapter's sole terminal union. */
const responseTypeCheck: McpDispatchResponse | undefined = undefined;
void responseTypeCheck;

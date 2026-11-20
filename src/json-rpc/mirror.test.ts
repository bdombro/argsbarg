/*
Focused tests for direct and relayed JSON-RPC CLI mirror calls.
They use injected sources, signals, and fetch functions without a listener or external service.
*/

import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { AppError } from "../core/errors.ts";
import { allow, deny } from "../core/invocation.ts";
import { createJsonRpcCatalog } from "./catalog.ts";
import { method } from "./declaration.ts";
import { createJsonRpcMirror, invokeJsonRpcLocal, invokeJsonRpcRelay } from "./mirror.ts";

/** Reads one request header through a case-sensitive test helper without exposing the fixture source. */
function header(request: Request, name: string): string | null {
  return request.headers.get(name);
}

test("local mirror invokes the exact catalog declaration once and retains captured output", async () => {
  const controller = new AbortController();
  const seen: unknown[] = [];
  const catalog = createJsonRpcCatalog<{ caller: string }>({
    guard: (context) => {
      seen.push({
        env: context.source === "local" ? context.env.get("TOKEN") : undefined,
        inputs: context.inputs,
        signal: context.signal,
        source: context.source,
        surface: context.surface,
        hasHeaders: "headers" in context,
      });
      return allow({ authenticated: true });
    },
    methods: [
      method<{ caller: string; authenticated: boolean }>()({
        name: "Reports.Get",
        description: "Get a report.",
        inputSchema: z.strictObject({ id: z.string() }),
        handler: ({ inputs, locals, signal }) => {
          seen.push({ id: inputs.id, locals, signal });
          console.log("local stdout");
          console.error("local stderr");
          return { id: inputs.id };
        },
      }),
    ],
  });
  const seed = { caller: "fresh" };
  const env = { get: (name: string) => (name === "TOKEN" ? "secret" : undefined) };

  const result = await invokeJsonRpcLocal(
    catalog,
    { method: "Reports.Get", params: { id: "r1" } },
    {
      mode: "local",
      signal: controller.signal,
      locals: seed,
      env,
    },
  );

  assert.deepEqual(result, {
    kind: "native",
    value: { kind: "ok", result: { id: "r1" } },
    stdout: "local stdout\n",
    stderr: "local stderr\n",
  });
  assert.deepEqual(seen[0], {
    env: "secret",
    inputs: { id: "r1" },
    signal: controller.signal,
    source: "local",
    surface: "jsonRpc",
    hasHeaders: false,
  });
  assert.deepEqual((seen[1] as { id: string; signal: AbortSignal }).id, "r1");
  assert.notEqual((seen[1] as { locals: object }).locals, seed);
  assert.equal((seen[1] as { signal: AbortSignal }).signal, controller.signal);
});

test("local mirror preserves native outcomes and turns caller abort into CALL_ABORTED", async () => {
  const catalog = createJsonRpcCatalog({
    methods: [
      method()({
        name: "deny",
        description: "Deny.",
        inputSchema: z.strictObject({}),
        guard: () => deny({ code: "NO", message: "No access" }),
        handler: () => null,
      }),
      method()({
        name: "fail",
        description: "Fail.",
        inputSchema: z.strictObject({}),
        handler: () => {
          throw new AppError("Failed", { code: "APP" });
        },
      }),
      method()({
        name: "abort",
        description: "Abort.",
        inputSchema: z.strictObject({}),
        handler: ({ signal }) => {
          console.log("before abort");
          signal.throwIfAborted();
          abort.abort();
          return true;
        },
      }),
    ],
  });
  const context = {
    mode: "local" as const,
    signal: new AbortController().signal,
    locals: {},
    env: { get: () => undefined },
  };

  const denied = await invokeJsonRpcLocal(catalog, { method: "deny", params: {} }, context);
  assert.deepEqual(denied, {
    kind: "native",
    value: {
      kind: "error",
      category: "denied",
      error: { code: -32_001, message: "No access", data: { kind: "denial", code: "NO" } },
    },
    stdout: "",
    stderr: "",
  });
  const failed = await invokeJsonRpcLocal(catalog, { method: "fail", params: {} }, context);
  assert.equal(failed.kind, "native");
  assert.deepEqual(failed.value, {
    kind: "error",
    category: "application-error",
    error: { code: -32_000, message: "Failed", data: { kind: "application", code: "APP" } },
  });

  const abort = new AbortController();
  const aborted = await invokeJsonRpcLocal(
    catalog,
    { method: "abort", params: {} },
    { ...context, signal: abort.signal },
  );
  assert.deepEqual(aborted, {
    kind: "failure",
    category: "transport",
    code: "CALL_ABORTED",
    message: "JSON-RPC call aborted",
    stdout: "before abort\n",
    stderr: "",
  });
});

test("mirror factory registers independent local and one-fetch relay entries", async () => {
  let localCalls = 0;
  let fetchCalls = 0;
  const endpoint = new URL("https://example.test/exact/rpc?view=one");
  const controller = new AbortController();
  const catalog = createJsonRpcCatalog({
    methods: [
      method()({
        name: "local.only",
        description: "Local work.",
        inputSchema: z.strictObject({ value: z.number() }),
        handler: ({ inputs }) => {
          localCalls++;
          return inputs.value;
        },
      }),
    ],
  });
  const entries = createJsonRpcMirror(catalog);
  const fetchImpl: typeof fetch = async (url, init) => {
    fetchCalls++;
    assert.equal(url, endpoint);
    assert.equal(init?.method, "POST");
    assert.equal(init?.signal, controller.signal);
    assert.equal(init?.redirect, "manual");
    const request = new Request(endpoint, init);
    assert.equal(header(request, "content-type"), "application/json");
    assert.equal(header(request, "x-trace"), "trace-value");
    assert.equal(header(request, "authorization"), "Bearer explicit");
    assert.deepEqual(await request.json(), {
      jsonrpc: "2.0",
      id: 1,
      method: "remote.only",
      params: ["a", 2],
    });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { remote: true } }), {
      headers: { "content-type": "application/json" },
    });
  };

  const relayed = await entries.relay.invoke(
    { method: "remote.only", params: ["a", 2] },
    {
      mode: "relay",
      signal: controller.signal,
      url: endpoint,
      headers: [
        ["x-trace", "trace-value"],
        ["authorization", "Bearer explicit"],
      ],
      fetch: fetchImpl,
    },
  );

  assert.equal(localCalls, 0);
  assert.equal(fetchCalls, 1);
  assert.deepEqual(relayed, {
    kind: "native",
    value: { kind: "ok", result: { remote: true } },
    stdout: "",
    stderr: "",
  });
});

test("relay omits params when absent and normalizes accepted remote error codes", async () => {
  const cases = [
    [-32_601, "method-not-found"],
    [-32_602, "invalid-params"],
    [-32_001, "denied"],
    [-32_000, "application-error"],
    [-32_603, "internal-error"],
  ] as const;
  for (const [code, category] of cases) {
    let requestBody: unknown;
    const result = await invokeJsonRpcRelay(
      { method: "missing" },
      {
        mode: "relay",
        signal: new AbortController().signal,
        url: new URL("https://example.test/rpc"),
        headers: [],
        fetch: async (_url, init) => {
          requestBody = JSON.parse(String(init?.body));
          return Response.json({
            jsonrpc: "2.0",
            id: 1,
            error: { code, message: "Safe remote error", data: { scope: "remote" } },
          });
        },
      },
    );
    assert.deepEqual(requestBody, { jsonrpc: "2.0", id: 1, method: "missing" });
    assert.deepEqual(result, {
      kind: "native",
      value: {
        kind: "error",
        category,
        error: { code, message: "Safe remote error", data: { scope: "remote" } },
      },
      stdout: "",
      stderr: "",
    });
  }
});

test("relay rejects protocol errors and HTTP failures without local fallback", async () => {
  let localCalls = 0;
  const catalog = createJsonRpcCatalog({
    methods: [
      method()({
        name: "would-succeed",
        description: "Must not run.",
        inputSchema: z.strictObject({}),
        handler: () => {
          localCalls++;
          return true;
        },
      }),
    ],
  });
  const endpoint = new URL("https://example.test/rpc");
  const invalidResponses = [
    new Response("{"),
    new Response(null, { status: 302, headers: { location: "https://example.test/redirected" } }),
    Response.json({ jsonrpc: "1.0", id: 1, result: true }),
    Response.json({ jsonrpc: "2.0", id: 2, result: true }),
    Response.json({ jsonrpc: "2.0", id: 1, result: true, error: { code: -1, message: "bad" } }),
    Response.json({ jsonrpc: "2.0", id: 1, result: true, extra: true }),
    Response.json({ jsonrpc: "2.0", id: 1 }),
    new Response("secret remote body", { status: 503 }),
  ];

  for (const response of invalidResponses) {
    let calls = 0;
    const result = await invokeJsonRpcRelay(
      { method: "would-succeed", params: {} },
      {
        mode: "relay",
        signal: new AbortController().signal,
        url: endpoint,
        headers: [],
        fetch: async () => {
          calls++;
          return response;
        },
      },
    );
    assert.equal(calls, 1);
    assert.equal(result.kind, "failure");
    assert.equal(result.category, "transport");
    assert.equal((result as { status?: number }).status, [302, 503].includes(response.status) ? response.status : undefined);
  }
  assert.equal(localCalls, 0);
  assert.equal(catalog.get("would-succeed")?.method.name, "would-succeed");
});

test("relay abort and network failures stay sanitized and never consult environment", async () => {
  const endpoint = new URL("https://credential.example/rpc");
  const prior = process.env.ARGSBARG_MIRROR_SECRET;
  process.env.ARGSBARG_MIRROR_SECRET = "must-not-forward";
  try {
    let networkCalls = 0;
    const network = await invokeJsonRpcRelay(
      { method: "work", params: {} },
      {
        mode: "relay",
        signal: new AbortController().signal,
        url: endpoint,
        headers: [],
        fetch: async (_url, init) => {
          networkCalls++;
          const request = new Request(endpoint, init);
          assert.equal(request.headers.get("authorization"), null);
          assert.equal(request.headers.has("argsbarg-mirror-secret"), false);
          throw new Error("https://user:password@example.test/private headers=secret");
        },
      },
    );
    assert.equal(networkCalls, 1);
    assert.deepEqual(network, {
      kind: "failure",
      category: "transport",
      code: "CALL_TRANSPORT_ERROR",
      message: "JSON-RPC relay request failed",
      stdout: "",
      stderr: "",
    });

    const controller = new AbortController();
    const aborted = await invokeJsonRpcRelay(
      { method: "work" },
      {
        mode: "relay",
        signal: controller.signal,
        url: endpoint,
        headers: [],
        fetch: async () => {
          controller.abort();
          throw new DOMException("aborted", "AbortError");
        },
      },
    );
    assert.deepEqual(aborted, {
      kind: "failure",
      category: "transport",
      code: "CALL_ABORTED",
      message: "JSON-RPC call aborted",
      stdout: "",
      stderr: "",
    });
  } finally {
    if (prior === undefined) delete process.env.ARGSBARG_MIRROR_SECRET;
    else process.env.ARGSBARG_MIRROR_SECRET = prior;
  }
});

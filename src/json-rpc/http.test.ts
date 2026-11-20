/*
In-process coverage for the standalone JSON-RPC HTTP mount, status selection and request isolation.
No listener, local mirror, relay, socket or external service is started by these focused tests.
*/

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { z } from "zod";
import { AppError } from "../core/errors.ts";
import { deny } from "../core/invocation.ts";
import { createJsonRpcCatalog } from "./catalog.ts";
import { method } from "./declaration.ts";
import { createJsonRpcHttpMount } from "./http.ts";

/** Application identity retained by the HTTP fixture's OpenRPC mount. */
const APP_INFO = { title: "reports", version: "1.0.0", description: "Report RPC." };

/** Calls one package-internal mount exactly as the accepted listener does. */
async function handle(
  /** Mount under test. */
  mount: ReturnType<typeof createJsonRpcHttpMount>,
  /** Native request sent to the claimed path. */
  request: Request,
): Promise<Response> {
  return mount.handle(request, { signal: request.signal });
}

/** Parses one asserted JSON response body without weakening the response type boundary. */
async function responseJson(response: Response): Promise<Record<string, unknown> | Record<string, unknown>[]> {
  return (await response.json()) as Record<string, unknown> | Record<string, unknown>[];
}

/** Returns the error member from one decoded response with a strict test-only narrowing. */
function rpcError(value: unknown): { code: number; message: string; data?: unknown } {
  assert.ok(typeof value === "object" && value !== null);
  const error = (value as { error?: unknown }).error;
  assert.ok(typeof error === "object" && error !== null);
  return error as { code: number; message: string; data?: unknown };
}

describe("JSON-RPC HTTP status and discovery", () => {
  test("returns native JSON-RPC responses for all request-bearing terminal outcomes", async () => {
    const catalog = createJsonRpcCatalog({
      methods: [
        method()({
          name: "outcome",
          description: "Exercise outcomes.",
          inputSchema: z.strictObject({ kind: z.enum(["ok", "deny", "app", "unknown"]) }),
          guard: ({ inputs }) => (inputs.kind === "deny" ? deny({ code: "NO", message: "No" }) : true),
          handler: ({ inputs }) => {
            if (inputs.kind === "app") throw new AppError("App failed", { code: "APP", details: { retry: false } });
            if (inputs.kind === "unknown") throw new Error("private");
            return { ok: true };
          },
        }),
      ],
    });
    const mount = createJsonRpcHttpMount({ catalog, appInfo: APP_INFO, createLocals: () => ({}) });

    const cases = [
      [{ jsonrpc: "2.0", id: 1, method: "outcome", params: { kind: "ok" } }, 1, undefined],
      [{ jsonrpc: "2.0", id: 2, method: "outcome", params: { kind: "deny" } }, 2, -32001],
      [{ jsonrpc: "2.0", id: 3, method: "outcome", params: { kind: "app" } }, 3, -32000],
      [{ jsonrpc: "2.0", id: 4, method: "outcome", params: { kind: "unknown" } }, 4, -32603],
      [{ jsonrpc: "2.0", id: 5, method: "outcome", params: { kind: 9 } }, 5, -32602],
      [{ jsonrpc: "2.0", id: 6, method: "missing" }, 6, -32601],
      [{ jsonrpc: "1.0", id: 7, method: "outcome", params: { kind: "ok" } }, 7, -32600],
    ] as const;
    for (const [payload, id, code] of cases) {
      const response = await handle(
        mount,
        new Request("http://example.test/rpc", { method: "POST", body: JSON.stringify(payload) }),
      );
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
      const decoded = await responseJson(response);
      assert.equal((decoded as { id: unknown }).id, id);
      if (code === undefined) assert.deepEqual((decoded as { result: unknown }).result, { ok: true });
      else assert.equal(rpcError(decoded).code, code);
    }

    const parse = await handle(mount, new Request("http://example.test/rpc", { method: "POST", body: "not-json" }));
    assert.equal(parse.status, 200);
    assert.equal(rpcError(await responseJson(parse)).code, -32700);
  });

  test("selects 204 only for valid notification-only dispatch and never leaks notifications", async () => {
    let calls = 0;
    const observed: string[] = [];
    const catalog = createJsonRpcCatalog({
      methods: [
        method()({
          name: "note",
          description: "Run notification.",
          inputSchema: z.strictObject({ fail: z.boolean().default(false) }),
          handler: ({ inputs }) => {
            calls++;
            if (inputs.fail) throw new AppError("No", { code: "NOTE" });
            return true;
          },
        }),
      ],
    });
    const mount = createJsonRpcHttpMount({
      catalog,
      appInfo: APP_INFO,
      createLocals: () => ({}),
      observeNotification: (event) => {
        observed.push(`${event.method}:${event.outcome}`);
      },
    });

    for (const payload of [
      { jsonrpc: "2.0", method: "note", params: {} },
      [
        { jsonrpc: "2.0", method: "note", params: {} },
        { jsonrpc: "2.0", method: "note", params: { fail: true } },
      ],
    ]) {
      const response = await handle(
        mount,
        new Request("http://example.test/rpc", { method: "POST", body: JSON.stringify(payload) }),
      );
      assert.equal(response.status, 204);
      assert.equal(await response.text(), "");
    }

    const malformed = await handle(
      mount,
      new Request("http://example.test/rpc", {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "1.0", method: "note", params: {} }),
      }),
    );
    assert.equal(malformed.status, 200);
    assert.equal(rpcError(await responseJson(malformed)).code, -32600);

    const mixed = await handle(
      mount,
      new Request("http://example.test/rpc", {
        method: "POST",
        body: JSON.stringify([
          { jsonrpc: "2.0", method: "note", params: {} },
          { jsonrpc: "2.0", id: 2, method: "note", params: {} },
        ]),
      }),
    );
    assert.equal(mixed.status, 200);
    assert.deepEqual(await responseJson(mixed), [{ jsonrpc: "2.0", id: 2, result: true }]);
    assert.equal(calls, 5);
    assert.deepEqual(observed.sort(), ["note:application-error", "note:ok", "note:ok", "note:ok"]);
  });

  test("serves cached catalog-only OpenRPC and exact wrong-method claims", async () => {
    const catalog = createJsonRpcCatalog({
      methods: [
        method()({
          name: "zeta",
          description: "zeta",
          inputSchema: z.strictObject({ count: z.number().min(1) }),
          outputSchema: z.strictObject({ ok: z.boolean() }),
          handler: () => ({ ok: true }),
        }),
        method()({
          name: "alpha",
          description: "alpha",
          inputSchema: z.strictObject({}),
          handler: () => null,
        }),
      ],
    });
    const mount = createJsonRpcHttpMount({ catalog, appInfo: APP_INFO, createLocals: () => ({}) });
    const response = await handle(mount, new Request("http://example.test/rpc/openrpc.json"));
    assert.equal(response.status, 200);
    const document = (await responseJson(response)) as {
      openrpc: string;
      info: unknown;
      methods: { name: string; params: unknown[]; result: unknown }[];
    };
    assert.equal(document.openrpc, "1.3.2");
    assert.deepEqual(document.info, APP_INFO);
    assert.deepEqual(
      document.methods.map(({ name }) => name),
      ["zeta", "alpha"],
    );
    const firstMethod = document.methods[0];
    assert.ok(firstMethod);
    assert.equal(firstMethod.params.length, 1);
    assert.deepEqual((firstMethod.result as { schema: unknown }).schema, {
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
      additionalProperties: false,
    });
    assert.deepEqual(mount.claims, [
      { kind: "exact", path: "/rpc" },
      { kind: "exact", path: "/rpc/openrpc.json" },
    ]);

    for (const [path, methodName, allow] of [
      ["/rpc", "GET", "POST"],
      ["/rpc/openrpc.json", "POST", "GET"],
    ] as const) {
      const wrong = await handle(mount, new Request(`http://example.test${path}`, { method: methodName }));
      assert.equal(wrong.status, 405);
      assert.equal(wrong.headers.get("allow"), allow);
      assert.deepEqual(await responseJson(wrong), { error: "Method not allowed" });
    }
    await assert.rejects(handle(mount, new Request("http://example.test/rpc/other")), /unclaimed path/);
  });
});

describe("JSON-RPC HTTP invocation isolation", () => {
  test("creates a base per batch member with header-only source and fresh locals", async () => {
    let nextMember = 0;
    const seedObjects: object[] = [];
    const seen: unknown[] = [];
    const catalog = createJsonRpcCatalog<{ member: number }>({
      methods: [
        method<{ member: number }>()({
          name: "member",
          description: "Read isolated member state.",
          inputSchema: z.strictObject({ value: z.string() }),
          guard: (context) => {
            seen.push({
              source: context.source,
              surface: context.surface,
              hasEnv: "env" in context,
              auth: context.source === "http" ? context.headers.get("X-Token") : undefined,
              unknown: context.source === "http" ? context.headers.get("missing") : undefined,
            });
            return true;
          },
          handler: ({ inputs, locals }) => ({ member: locals.member, value: inputs.value }),
        }),
      ],
    });
    const mount = createJsonRpcHttpMount({
      catalog,
      appInfo: APP_INFO,
      createLocals: () => {
        const seed = { member: ++nextMember };
        seedObjects.push(seed);
        return seed;
      },
    });
    const prior = process.env.ARGSBARG_RPC_SENTINEL;
    process.env.ARGSBARG_RPC_SENTINEL = "local-secret";
    try {
      const response = await handle(
        mount,
        new Request("http://example.test/rpc", {
          method: "POST",
          headers: { "X-ToKeN": "http-secret" },
          body: JSON.stringify([
            { jsonrpc: "2.0", id: 1, method: "member", params: { value: "one" } },
            { jsonrpc: "2.0", id: 2, method: "member", params: { value: "two" } },
          ]),
        }),
      );
      assert.deepEqual(await responseJson(response), [
        { jsonrpc: "2.0", id: 1, result: { member: 1, value: "one" } },
        { jsonrpc: "2.0", id: 2, result: { member: 2, value: "two" } },
      ]);
      assert.equal(new Set(seedObjects).size, 2);
      assert.deepEqual(seen, [
        { source: "http", surface: "jsonRpc", hasEnv: false, auth: "http-secret", unknown: undefined },
        { source: "http", surface: "jsonRpc", hasEnv: false, auth: "http-secret", unknown: undefined },
      ]);
    } finally {
      if (prior === undefined) delete process.env.ARGSBARG_RPC_SENTINEL;
      else process.env.ARGSBARG_RPC_SENTINEL = prior;
    }
  });

  test("keeps a blocked member independent and relays only its request abort", async () => {
    let entered = 0;
    let signalChecks = 0;
    const catalog = createJsonRpcCatalog({
      methods: [
        method()({
          name: "wait",
          description: "Wait for cancellation.",
          inputSchema: z.strictObject({ request: z.string(), blocked: z.boolean() }),
          handler: async ({ inputs, signal }) =>
            new Promise((resolve) => {
              entered++;
              const finish = (): void => {
                signalChecks++;
                resolve({ request: inputs.request, aborted: signal.aborted });
              };
              if (inputs.blocked) signal.addEventListener("abort", finish, { once: true });
              else finish();
            }),
        }),
      ],
    });
    const mount = createJsonRpcHttpMount({ catalog, appInfo: APP_INFO, createLocals: () => ({}) });
    const controller = new AbortController();
    const pending = handle(
      mount,
      new Request("http://example.test/rpc", {
        method: "POST",
        signal: controller.signal,
        body: JSON.stringify([
          { jsonrpc: "2.0", id: 1, method: "wait", params: { request: "one", blocked: true } },
          { jsonrpc: "2.0", id: 2, method: "wait", params: { request: "one", blocked: false } },
          { jsonrpc: "2.0", id: 3, method: "wait", params: { request: "one", blocked: true } },
        ]),
      }),
    );
    while (entered < 3) await Promise.resolve();
    assert.equal(signalChecks, 1);
    const otherController = new AbortController();
    const otherSignals: AbortSignal[] = [];
    const otherCatalog = createJsonRpcCatalog({
      methods: [
        method()({
          name: "observe",
          description: "Observe a separate request.",
          inputSchema: z.strictObject({}),
          handler: ({ signal }) => {
            otherSignals.push(signal);
            return signal.aborted;
          },
        }),
      ],
    });
    const otherMount = createJsonRpcHttpMount({
      catalog: otherCatalog,
      appInfo: APP_INFO,
      createLocals: () => ({}),
    });
    controller.abort("gone");
    const first = await pending;
    assert.equal(first.status, 200);
    assert.deepEqual(await responseJson(first), [
      { jsonrpc: "2.0", id: 1, result: { request: "one", aborted: true } },
      { jsonrpc: "2.0", id: 2, result: { request: "one", aborted: false } },
      { jsonrpc: "2.0", id: 3, result: { request: "one", aborted: true } },
    ]);
    assert.equal(signalChecks, 3);
    assert.equal(otherController.signal.aborted, false);
    const other = await handle(
      otherMount,
      new Request("http://example.test/rpc", {
        method: "POST",
        signal: otherController.signal,
        body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "observe", params: {} }),
      }),
    );
    assert.deepEqual(await responseJson(other), { jsonrpc: "2.0", id: 3, result: false });
    assert.equal(otherSignals[0]?.aborted, false);
  });

  test("sanitizes live body-read failures and preserves aborted reads", async () => {
    const catalog = createJsonRpcCatalog({ methods: [] });
    const mount = createJsonRpcHttpMount({ catalog, appInfo: APP_INFO, createLocals: () => ({}) });
    const liveFailure = new Request("http://example.test/rpc", { method: "POST" });
    Object.defineProperty(liveFailure, "text", { value: async () => Promise.reject(new Error("sensitive")) });
    const response = await mount.handle(liveFailure, { signal: liveFailure.signal });
    assert.equal(response.status, 500);
    assert.deepEqual(await responseJson(response), { error: "Internal Server Error" });

    const controller = new AbortController();
    const abortedFailure = new Request("http://example.test/rpc", {
      method: "POST",
      signal: controller.signal,
    });
    Object.defineProperty(abortedFailure, "text", { value: async () => Promise.reject(new Error("disconnect")) });
    controller.abort("disconnect");
    await assert.rejects(
      Promise.resolve(mount.handle(abortedFailure, { signal: abortedFailure.signal })),
      /disconnect/,
    );
  });
});

/*
Focused tests for the standalone JSON-RPC declaration, catalog, dispatch, and OpenRPC leaf.
No listener, public factory, process bridge, CLI parser, or MCP adapter is exercised here.
*/

import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { AppError } from "../core/errors.ts";
import { allow, deny, type InvocationBase } from "../core/invocation.ts";
import { createJsonRpcCatalog } from "./catalog.ts";
import { method } from "./declaration.ts";
import { dispatchJsonRpc, invokeJsonRpcMethod } from "./dispatch.ts";
import { generateOpenRpc } from "./openrpc.ts";

/** Stable request base used by focused codec tests. */
function localBase<Seed extends object>(seed: Seed = {} as Seed): InvocationBase<Seed> {
  return {
    source: "local",
    env: { get: () => undefined },
    locals: seed,
    signal: new AbortController().signal,
    surface: "jsonRpc",
  };
}

/** Extracts response errors without weakening test assertions to broad records. */
function responseError(value: unknown): { code: number; message: string; data?: unknown } {
  assert.ok(typeof value === "object" && value !== null);
  const errorValue = (value as { error?: unknown }).error;
  assert.ok(typeof errorValue === "object" && errorValue !== null);
  return errorValue as { code: number; message: string; data?: unknown };
}

test("method preserves extracted input, result, and locals inference", () => {
  type Locals = { caller: { id: string } };
  const declaration = method<Locals>()({
    name: "reports.get",
    description: "Get one report.",
    inputSchema: z.strictObject({ id: z.string() }),
    outputSchema: z.strictObject({ id: z.string(), total: z.number() }),
    handler: ({ inputs, locals }) => ({ id: inputs.id, total: locals.caller.id.length }),
  });
  assert.equal(declaration.name, "reports.get");

  method()({
    name: "negative-result",
    description: "Compile-only result check.",
    inputSchema: z.strictObject({}),
    outputSchema: z.strictObject({ total: z.number() }),
    // @ts-expect-error output schema constrains the handler result
    handler: () => ({ total: "many" }),
  });

  method()({
    name: "negative-input",
    description: "Compile-only input check.",
    inputSchema: z.strictObject({ known: z.string() }),
    handler: ({ inputs }) => {
      // @ts-expect-error undeclared input property is not inferred
      return inputs.unknown;
    },
  });
});

test("catalog fixes exact order and rejects names, duplicates, and unrepresentable input", () => {
  const one = method()({ name: "One", description: "one", inputSchema: z.strictObject({}), handler: () => null });
  const two = method()({ name: "one", description: "two", inputSchema: z.strictObject({}), handler: () => null });
  const catalog = createJsonRpcCatalog({ methods: [two, one] });
  assert.deepEqual(
    catalog.methods.map((entry) => entry.method.name),
    ["one", "One"],
  );
  assert.equal(catalog.get("ONE"), undefined);
  assert.throws(() => createJsonRpcCatalog({ methods: [one, one] }), /Duplicate/);
  assert.throws(
    () =>
      createJsonRpcCatalog({
        methods: [
          method()({ name: "rpc.hidden", description: "bad", inputSchema: z.strictObject({}), handler: () => 1 }),
        ],
      }),
    /Invalid JSON-RPC method name/,
  );
  assert.throws(
    () =>
      createJsonRpcCatalog({
        methods: [
          method()({ name: "bad\u0085name", description: "bad", inputSchema: z.strictObject({}), handler: () => 1 }),
        ],
      }),
    /Invalid JSON-RPC method name/,
  );
  assert.throws(
    () =>
      createJsonRpcCatalog({
        methods: [method()({ name: "loose", description: "bad", inputSchema: z.object({}), handler: () => 1 })],
      }),
    /additionalProperties/,
  );
  assert.throws(
    () =>
      createJsonRpcCatalog({
        methods: [method()({ name: "array", description: "bad", inputSchema: z.array(z.string()), handler: () => 1 })],
      }),
    /strict object or fixed tuple/,
  );
});

test("single dispatch preserves params, IDs, D2 validation, and direct results", async () => {
  const observed: unknown[] = [];
  const catalog = createJsonRpcCatalog({
    methods: [
      method()({
        name: "echo",
        description: "Echo parsed input.",
        inputSchema: z.tuple([z.string(), z.number().optional()]),
        paramNames: ["value", "count"],
        handler: ({ inputs }) => {
          observed.push(inputs);
          return inputs;
        },
      }),
    ],
  });
  for (const id of ["", 0, 1.5, null]) {
    const result = await dispatchJsonRpc(
      catalog,
      JSON.stringify({ jsonrpc: "2.0", id, method: "echo", params: ["x"] }),
      { createBase: localBase },
    );
    assert.deepEqual(result, { jsonrpc: "2.0", id, result: ["x"] });
  }
  assert.deepEqual(observed, [["x"], ["x"], ["x"], ["x"]]);
  const invalid = await dispatchJsonRpc(
    catalog,
    { jsonrpc: "2.0", id: 2, method: "echo", params: 42 },
    { createBase: localBase },
  );
  assert.equal(responseError(invalid).code, -32602);
  assert.equal(observed.length, 4);
});

test("notifications execute but never emit, including lookup and application failures", async () => {
  let calls = 0;
  const observed: unknown[] = [];
  const catalog = createJsonRpcCatalog({
    methods: [
      method()({
        name: "refresh",
        description: "Refresh.",
        inputSchema: z.strictObject({ fail: z.boolean().default(false) }),
        handler: ({ inputs }) => {
          calls++;
          if (inputs.fail) throw new AppError("Refresh failed", { code: "REFRESH", details: 123 });
          return true;
        },
      }),
    ],
  });
  const result = await dispatchJsonRpc(
    catalog,
    [
      { jsonrpc: "2.0", method: "refresh", params: {} },
      { jsonrpc: "2.0", method: "refresh", params: { fail: true } },
      { jsonrpc: "2.0", method: "missing", params: {} },
    ],
    {
      createBase: localBase,
      observeNotification: (event) => {
        observed.push(event);
      },
    },
  );
  assert.equal(result, undefined);
  assert.equal(calls, 2);
  assert.deepEqual(
    observed.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    [
      { method: "missing", outcome: "method-not-found" },
      { method: "refresh", outcome: "application-error", code: "REFRESH" },
      { method: "refresh", outcome: "ok" },
    ],
  );
});

test("envelopes, parse errors, extra members, IDs, and duplicate IDs are strict", async () => {
  const catalog = createJsonRpcCatalog({
    methods: [method()({ name: "ok", description: "ok", inputSchema: z.strictObject({}), handler: () => true })],
  });
  const parse = await dispatchJsonRpc(catalog, "not-json", { createBase: localBase });
  assert.deepEqual(parse, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  const overflow = await dispatchJsonRpc(catalog, '{"jsonrpc":"2.0","id":1e400,"method":"ok"}', {
    createBase: localBase,
  });
  assert.equal((overflow as { id: unknown }).id, null);
  assert.equal(responseError(overflow).code, -32600);
  const extra = await dispatchJsonRpc(
    catalog,
    { jsonrpc: "2.0", id: 2, method: "ok", extra: true },
    {
      createBase: localBase,
    },
  );
  assert.equal(responseError(extra).code, -32600);
  const duplicate = await dispatchJsonRpc(
    catalog,
    [
      { jsonrpc: "2.0", id: 7, method: "ok" },
      { jsonrpc: "2.0", id: 7, method: "missing" },
      { jsonrpc: "2.0", id: 8, method: "ok", params: {} },
    ],
    { createBase: localBase },
  );
  assert.deepEqual(
    (duplicate as readonly { id: unknown; error?: unknown; result?: unknown }[]).map(
      ({ id, error: rpcError, result }) => ({
        id,
        code: (rpcError as { code?: number } | undefined)?.code,
        result,
      }),
    ),
    [
      { id: 7, code: -32600, result: undefined },
      { id: 7, code: -32600, result: undefined },
      { id: 8, code: undefined, result: true },
    ],
  );
});

test("D2 errors are encoded safely and member work remains isolated", async () => {
  let releaseFirst: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const catalog = createJsonRpcCatalog<{ member: number }>({
    guard: ({ inputs }) => (typeof inputs === "object" ? allow({ authenticated: true }) : allow()),
    methods: [
      method<{ member: number; authenticated: boolean }>()({
        name: "work",
        description: "work",
        inputSchema: z.strictObject({ kind: z.enum(["wait", "release", "deny", "app", "unsafe", "unknown"]) }),
        guard: ({ inputs }) => (inputs.kind === "deny" ? deny({ code: "NO", message: "No" }) : allow()),
        handler: async ({ inputs, locals }) => {
          if (inputs.kind === "wait") await firstGate;
          if (inputs.kind === "release") releaseFirst?.();
          if (inputs.kind === "app") throw new AppError("App failure", { code: "APP", details: { secret: BigInt(1) } });
          if (inputs.kind === "unsafe") return { recursive: undefined };
          if (inputs.kind === "unknown") throw new Error("private");
          assert.equal(locals.authenticated, true);
          return { member: locals.member };
        },
      }),
    ],
  });
  let nextMember = 0;
  const createBase = (): InvocationBase<{ member: number }> => localBase({ member: ++nextMember });
  const waiting = dispatchJsonRpc(
    catalog,
    [
      { jsonrpc: "2.0", id: 1, method: "work", params: { kind: "wait" } },
      { jsonrpc: "2.0", id: 2, method: "work", params: { kind: "release" } },
    ],
    { createBase },
  );
  assert.deepEqual(await waiting, [
    { jsonrpc: "2.0", id: 1, result: { member: 1 } },
    { jsonrpc: "2.0", id: 2, result: { member: 2 } },
  ]);
  const errors = await Promise.all(
    ["deny", "app", "unsafe", "unknown"].map((kind) =>
      dispatchJsonRpc(catalog, { jsonrpc: "2.0", id: kind, method: "work", params: { kind } }, { createBase }),
    ),
  );
  assert.deepEqual(errors.map(responseError), [
    { code: -32001, message: "No", data: { kind: "denial", code: "NO" } },
    { code: -32000, message: "App failure", data: { kind: "application", code: "APP" } },
    { code: -32603, message: "Internal error" },
    { code: -32603, message: "Internal error" },
  ]);
});

test("JSON-safe projection rejects array accessors and preserves own prototype-named keys", async () => {
  let accessorReads = 0;
  const catalog = createJsonRpcCatalog({
    methods: [
      method()({
        name: "unsafe-array",
        description: "Return an accessor array.",
        inputSchema: z.strictObject({}),
        handler: () => {
          const result: number[] = [];
          Object.defineProperty(result, "0", {
            enumerable: true,
            get: () => {
              accessorReads++;
              return 1;
            },
          });
          return result;
        },
      }),
      method()({
        name: "prototype-key",
        description: "Return an own prototype-named key.",
        inputSchema: z.strictObject({}),
        handler: () =>
          Object.defineProperty({}, "__proto__", {
            configurable: true,
            enumerable: true,
            value: "own-value",
          }),
      }),
    ],
  });

  const unsafe = await dispatchJsonRpc(
    catalog,
    { jsonrpc: "2.0", id: 1, method: "unsafe-array", params: {} },
    { createBase: localBase },
  );
  assert.equal(responseError(unsafe).code, -32603);
  assert.equal(accessorReads, 0);

  const safe = await dispatchJsonRpc(
    catalog,
    { jsonrpc: "2.0", id: 2, method: "prototype-key", params: {} },
    { createBase: localBase },
  );
  const result = (safe as { result: object }).result;
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.equal(Object.hasOwn(result, "__proto__"), true);
  assert.equal(Reflect.get(result, "__proto__"), "own-value");
});

test("direct method invocation is reusable without a fabricated envelope", async () => {
  const catalog = createJsonRpcCatalog({
    methods: [
      method()({
        name: "direct",
        description: "Direct.",
        inputSchema: z.strictObject({ value: z.string() }),
        handler: ({ inputs }) => inputs.value,
      }),
    ],
  });
  assert.deepEqual(await invokeJsonRpcMethod(catalog, "direct", { value: "yes" }, localBase()), {
    kind: "ok",
    result: "yes",
  });
});

test("OpenRPC preserves catalog order and dereferences direct native schemas", () => {
  const catalog = createJsonRpcCatalog({
    methods: [
      method()({
        name: "reports.get",
        description: "Read one report.",
        summary: "Get report",
        inputSchema: z.strictObject({ id: z.string().min(1) }),
        outputSchema: z.strictObject({ id: z.string(), total: z.number() }),
        handler: ({ inputs }) => ({ id: inputs.id, total: 1 }),
      }),
    ],
  });
  const document = generateOpenRpc(catalog, {
    title: "reports",
    version: "1.0.0",
    description: "Report API.",
  });
  assert.equal(document.openrpc, "1.3.2");
  assert.deepEqual(document.info, { title: "reports", version: "1.0.0", description: "Report API." });
  assert.deepEqual(
    (document.methods as { name: string }[]).map(({ name }) => name),
    ["reports.get"],
  );
  const rpcMethod = (document.methods as Record<string, unknown>[])[0];
  assert.equal(rpcMethod.paramStructure, "by-name");
  assert.deepEqual(
    (rpcMethod.errors as { code: number; message: string }[]).map(({ code, message }) => ({ code, message })),
    [
      { code: -32700, message: "Parse error" },
      { code: -32600, message: "Invalid Request" },
      { code: -32601, message: "Method not found" },
      { code: -32602, message: "Invalid params" },
      { code: -32603, message: "Internal error" },
      { code: -32001, message: "Access denied" },
      { code: -32000, message: "Application error" },
    ],
  );
});

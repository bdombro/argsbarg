/*
Focused MCP dispatcher tests against the D2 invocation core.
They cover method routing, exact-once lookup/invocation, native outcomes, wrappers, and overlap isolation.
*/

import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { AppError } from "../core/errors.ts";
import { allow, type BoundDeclaration, deny, type InvocationBase } from "../core/invocation.ts";
import { compileGuardPlan } from "../runtime/invoke.ts";
import { dispatchMcpRequest, type McpDispatchResponse } from "./dispatcher.ts";
import { decodeMcpRequest } from "./protocol.ts";
import { createMcpRegistry, type McpToolRegistration, registerMcpTool } from "./registry.ts";

/** Stable server identity for every dispatcher fixture. */
const SERVER_INFO = { name: "fixture-app", version: "1.0.0" } as const;

/** Standard 2026 request metadata. */
const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
} as const;

/** Local invocation base used unless a test supplies a distinct source. */
const LOCAL_BASE: InvocationBase<Record<never, never>> = {
  locals: {},
  signal: new AbortController().signal,
  surface: "mcp",
  source: "local",
  env: { get: () => undefined },
};

/** Makes a decoded request with canonical metadata. */
function request(method: string, params: Record<string, unknown> = {}, id: string | number = 1) {
  const decoded = decodeMcpRequest({ jsonrpc: "2.0", id, method, params: { ...params, _meta: META } });
  assert.equal(decoded.kind, "request");
  if (decoded.kind !== "request") throw new Error("fixture decode failed");
  return decoded.request;
}

/** Creates one object-input declaration with counters and a caller-controlled handler. */
function declaration<Result>(
  handler: (context: {
    readonly inputs: { readonly value: string };
    readonly locals: { readonly caller?: string };
    readonly source: "local" | "http";
    readonly signal: AbortSignal;
    readonly env?: { get(name: string): string | undefined };
    readonly headers?: { get(name: string): string | undefined };
  }) => Result | Promise<Result>,
): BoundDeclaration<z.ZodObject<{ value: z.ZodString }>, Result, { caller?: string }, { caller?: string }> {
  const inputSchema = z.strictObject({ value: z.string() });
  type Input = z.output<typeof inputSchema>;
  type Locals = { caller?: string };
  return {
    inputSchema,
    guardPlan: compileGuardPlan<Input, Locals>()({}) as BoundDeclaration<
      typeof inputSchema,
      Result,
      Locals,
      Locals
    >["guardPlan"],
    handler,
  };
}

/** Builds a registered wire entry from one native declaration. */
function tool(
  name: string,
  bound: object,
  options: { inputWrapped?: boolean; outputWrapped?: boolean } = {},
): McpToolRegistration<{ caller?: string }> {
  return registerMcpTool({
    name,
    description: `Run ${name}.`,
    inputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
    outputSchema: { type: "object" },
    ...options,
    declaration: bound,
  } as Parameters<typeof registerMcpTool>[0]);
}

test("dispatcher serves registry parity and rejects methods, cursors, tool shape, and unknown names before invocation", async () => {
  let calls = 0;
  const registry = createMcpRegistry([
    tool(
      "zeta",
      declaration(({ inputs }) => ({ value: ++calls && inputs.value })),
    ),
    tool(
      "alpha",
      declaration(({ inputs }) => ({ value: ++calls && inputs.value })),
    ),
  ]);
  const discovered = await dispatchMcpRequest({
    request: request("server/discover"),
    registry,
    base: LOCAL_BASE,
    serverInfo: SERVER_INFO,
    instructions: "Fixture instructions.",
  });
  const listed = await dispatchMcpRequest({
    request: request("tools/list", {}, 8),
    registry,
    base: LOCAL_BASE,
    serverInfo: SERVER_INFO,
  });
  assert.deepEqual(
    (listed as { result: { tools: { name: string }[] } }).result.tools.map((entry) => entry.name),
    ["alpha", "zeta"],
  );
  assert.deepEqual((discovered as { result: Record<string, unknown> }).result.capabilities, { tools: {} });
  assert.equal((listed as { result: Record<string, unknown> }).result.ttlMs, 3_600_000);
  assert.equal((listed as { result: Record<string, unknown> }).result.cacheScope, "public");

  for (const [method, params, code] of [
    ["ping", {}, -32_601],
    ["tools/list", { cursor: "unissued" }, -32_602],
    ["tools/call", { name: 7 }, -32_602],
    ["tools/call", { name: "missing", arguments: {} }, -32_602],
    ["tools/call", { name: "alpha", arguments: null }, -32_602],
    ["tools/call", { name: "alpha", arguments: [] }, -32_602],
  ] as const) {
    const response: McpDispatchResponse = await dispatchMcpRequest({
      request: request(method, params),
      registry,
      base: LOCAL_BASE,
      serverInfo: SERVER_INFO,
    });
    assert.equal((response as { error: { code: number } }).error.code, code);
  }
  assert.equal(calls, 0);

  const initialize = decodeMcpRequest({ jsonrpc: "2.0", id: "init", method: "initialize" });
  assert.equal(initialize.kind, "request");
  if (initialize.kind === "request") {
    const response = await dispatchMcpRequest({
      request: initialize.request,
      registry,
      base: LOCAL_BASE,
      serverInfo: SERVER_INFO,
    });
    assert.deepEqual(response, {
      jsonrpc: "2.0",
      id: "init",
      error: {
        code: -32_022,
        message: "Unsupported protocol version: initialize is not supported",
        data: { supported: ["2026-07-28"] },
      },
    });
  }
});

test("dispatcher invokes D2 once, unwraps declared inputs, and preserves validation, denial, domain, and thrown outcomes", async () => {
  let validations = 0;
  let handlerCalls = 0;
  const wrappedValues: unknown[] = [];
  const wrappedArray = ["alpha", 2];
  const inputSchema = z.strictObject({ value: z.string() }).transform((value) => {
    validations += 1;
    return value;
  });
  type Locals = { readonly caller: string; readonly allowed?: boolean };
  const guarded = {
    inputSchema,
    guardPlan: compileGuardPlan<{ value: string }, { readonly caller: string }>()({
      operation: () => allow({ allowed: true } as const),
    }),
    handler: ({ inputs }: { readonly inputs: { value: string }; readonly locals: Locals }) => {
      handlerCalls += 1;
      return { value: inputs.value };
    },
  } as unknown as BoundDeclaration<typeof inputSchema, { value: string }, Locals, { caller: string }>;
  const registry = createMcpRegistry([
    tool("wrapped", guarded, { inputWrapped: true }),
    tool(
      "wrapped-scalar",
      {
        inputSchema: z.string(),
        guardPlan: compileGuardPlan<string, object>()({}),
        handler: ({ inputs }: { readonly inputs: string }) => {
          wrappedValues.push(inputs);
          return inputs;
        },
      },
      { inputWrapped: true, outputWrapped: true },
    ),
    tool(
      "wrapped-array",
      {
        inputSchema: z.custom<unknown[]>((value) => Array.isArray(value)),
        guardPlan: compileGuardPlan<unknown[], object>()({}),
        handler: ({ inputs }: { readonly inputs: unknown[] }) => {
          wrappedValues.push(inputs);
          return inputs;
        },
      },
      { inputWrapped: true, outputWrapped: true },
    ),
    tool(
      "denied",
      declarationWithGuard({
        operation: () => deny({ code: "FORBIDDEN", message: "No access", http: { status: 403 } }),
      }),
    ),
    tool(
      "domain",
      declaration(() => Promise.reject(new AppError("Bad state", { code: "STATE" }))),
    ),
    tool(
      "thrown",
      declaration(() => Promise.reject(new Error("secret stack"))),
    ),
  ]);

  const call = await dispatchMcpRequest({
    request: request("tools/call", { name: "wrapped", arguments: { input: { value: "hello" } } }),
    registry,
    base: { ...LOCAL_BASE, locals: { caller: "ada" } },
    serverInfo: SERVER_INFO,
  });
  assert.deepEqual((call as { result: Record<string, unknown> }).result.structuredContent, { value: "hello" });
  assert.equal(validations, 1);
  assert.equal(handlerCalls, 1);

  for (const [name, input] of [
    ["wrapped-scalar", "bare"],
    ["wrapped-array", wrappedArray],
  ] as const) {
    const wrapped: McpDispatchResponse = await dispatchMcpRequest({
      request: request("tools/call", { name, arguments: { input } }),
      registry,
      base: LOCAL_BASE,
      serverInfo: SERVER_INFO,
    });
    assert.equal((wrapped as { result: { isError: boolean } }).result.isError, false);
  }
  assert.equal(wrappedValues[0], "bare");
  assert.equal(wrappedValues[1], wrappedArray);

  const invalid = await dispatchMcpRequest({
    request: request("tools/call", { name: "wrapped", arguments: { input: { value: 7 } } }),
    registry,
    base: { ...LOCAL_BASE, locals: { caller: "ada" } },
    serverInfo: SERVER_INFO,
  });
  assert.equal((invalid as { result: { isError: boolean } }).result.isError, true);
  assert.equal(handlerCalls, 1);
  const malformedWrapper = await dispatchMcpRequest({
    request: request("tools/call", { name: "wrapped", arguments: { value: "hello" } }),
    registry,
    base: { ...LOCAL_BASE, locals: { caller: "ada" } },
    serverInfo: SERVER_INFO,
  });
  assert.equal((malformedWrapper as { error: { code: number } }).error.code, -32_602);
  assert.equal(validations, 1);
  const extraWrapperKey = await dispatchMcpRequest({
    request: request("tools/call", {
      name: "wrapped",
      arguments: { input: { value: "hello" }, extra: true },
    }),
    registry,
    base: LOCAL_BASE,
    serverInfo: SERVER_INFO,
  });
  assert.equal((extraWrapperKey as { error: { code: number } }).error.code, -32_602);
  assert.equal(validations, 1);

  for (const [name, code, secret] of [
    ["denied", "FORBIDDEN", "No access"],
    ["domain", "STATE", "Bad state"],
    ["thrown", "INTERNAL_ERROR", "secret stack"],
  ] as const) {
    const response: McpDispatchResponse = await dispatchMcpRequest({
      request: request("tools/call", { name, arguments: { value: "hello" } }),
      registry,
      base: { ...LOCAL_BASE, locals: { caller: "ada" } },
      serverInfo: SERVER_INFO,
    });
    const result: {
      readonly isError: boolean;
      readonly structuredContent: { readonly error: Record<string, unknown> };
    } = (
      response as {
        result: {
          isError: boolean;
          structuredContent: { error: Record<string, unknown> };
        };
      }
    ).result;
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, code);
    assert.equal(JSON.stringify(result).includes(secret), name !== "thrown");
  }
});

/** Creates a declaration whose guard operation has the supplied runtime behavior. */
function declarationWithGuard(
  guards: Parameters<ReturnType<typeof compileGuardPlan<{ value: string }, { caller: string }>>>[0],
): BoundDeclaration<z.ZodObject<{ value: z.ZodString }>, { value: string }, { caller: string }, { caller: string }> {
  const inputSchema = z.strictObject({ value: z.string() });
  return {
    inputSchema,
    guardPlan: compileGuardPlan<{ value: string }, { caller: string }>()(guards),
    handler: ({ inputs }: { readonly inputs: { readonly value: string } }) => inputs,
  } as unknown as BoundDeclaration<
    z.ZodObject<{ value: z.ZodString }>,
    { value: string },
    { caller: string },
    { caller: string }
  >;
}

test("dispatcher overlaps calls with exclusive sources, fresh caller locals, signals, and captured output", async () => {
  const releases: (() => void)[] = [];
  const contexts: {
    readonly caller: string | undefined;
    readonly source: "local" | "http";
    readonly signal: AbortSignal;
    readonly localToken: string | undefined;
    readonly httpToken: string | undefined;
    readonly hasEnv: boolean;
    readonly hasHeaders: boolean;
  }[] = [];
  const registry = createMcpRegistry([
    tool(
      "echo",
      declaration(async ({ inputs, locals, source, signal, env, headers }) => {
        contexts.push({
          caller: locals.caller,
          source,
          signal,
          localToken: env?.get("TOKEN"),
          httpToken: headers?.get("authorization"),
          hasEnv: env !== undefined,
          hasHeaders: headers !== undefined,
        });
        assert.throws(() => process.chdir(process.cwd()), /process\.chdir isn't allowed/);
        console.log(`${locals.caller} stdout`);
        console.error(`${locals.caller} stderr`);
        await new Promise<void>((resolve) => releases.push(resolve));
        return { value: inputs.value };
      }),
    ),
  ]);
  const localController = new AbortController();
  const httpController = new AbortController();
  const first = dispatchMcpRequest({
    request: request("tools/call", { name: "echo", arguments: { value: "local" } }, "local"),
    registry,
    base: {
      locals: { caller: "local-caller" },
      signal: localController.signal,
      surface: "mcp",
      source: "local",
      env: { get: (name) => (name === "TOKEN" ? "[local]" : undefined) },
    },
    serverInfo: SERVER_INFO,
  });
  const second = dispatchMcpRequest({
    request: request("tools/call", { name: "echo", arguments: { value: "http" } }, "http"),
    registry,
    base: {
      locals: { caller: "http-caller" },
      signal: httpController.signal,
      surface: "mcp",
      source: "http",
      headers: { get: (name) => (name === "authorization" ? "[http]" : undefined) },
    },
    serverInfo: SERVER_INFO,
  });
  while (releases.length < 2) await new Promise((resolve) => setTimeout(resolve, 0));
  for (const release of releases) release();
  const [local, http] = await Promise.all([first, second]);
  assert.deepEqual(
    contexts.map(({ caller, source, localToken, httpToken, hasEnv, hasHeaders }) => ({
      caller,
      source,
      localToken,
      httpToken,
      hasEnv,
      hasHeaders,
    })),
    [
      {
        caller: "local-caller",
        source: "local",
        localToken: "[local]",
        httpToken: undefined,
        hasEnv: true,
        hasHeaders: false,
      },
      {
        caller: "http-caller",
        source: "http",
        localToken: undefined,
        httpToken: "[http]",
        hasEnv: false,
        hasHeaders: true,
      },
    ],
  );
  assert.equal(contexts[0]?.signal, localController.signal);
  assert.equal(contexts[1]?.signal, httpController.signal);
  assert.equal((local as { result: { isError: boolean } }).result.isError, false);
  assert.equal((http as { result: { isError: boolean } }).result.isError, false);
  assert.equal(JSON.stringify([local, http]).includes("stdout"), false);
  assert.equal(JSON.stringify([local, http]).includes("stderr"), false);

  let calls = 0;
  const notificationRegistry = createMcpRegistry([
    tool(
      "count",
      declaration(({ inputs }) => ({ value: `${inputs.value}-${++calls}` })),
    ),
  ]);
  const notification = decodeMcpRequest({
    jsonrpc: "2.0",
    method: "tools/call",
    params: { _meta: META, name: "count", arguments: { value: "ignored" } },
  });
  assert.equal(notification.kind, "request");
  if (notification.kind === "request") {
    assert.equal(
      await dispatchMcpRequest({
        request: notification.request,
        registry: notificationRegistry,
        base: LOCAL_BASE,
        serverInfo: SERVER_INFO,
      }),
      undefined,
    );
  }
  assert.equal(calls, 0);
});

test("dispatcher turns result serialization failures into complete tool failures", async () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const registry = createMcpRegistry([
    tool(
      "circular",
      declaration(() => circular),
    ),
  ]);
  const response = await dispatchMcpRequest({
    request: request("tools/call", { name: "circular", arguments: { value: "x" } }),
    registry,
    base: LOCAL_BASE,
    serverInfo: SERVER_INFO,
  });
  const result = (response as { result: { isError: boolean; structuredContent: { error: { code: string } } } }).result;
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, "SERIALIZATION_ERROR");
});

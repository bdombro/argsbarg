/*
Focused local mirror and relay fixtures for the MCP generated-call registrations.
They prove native parity, exact request construction, output capture, cancellation, and no fallback.
*/

import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { allow, deny, type BoundDeclaration } from "../core/invocation.ts";
import { compileGuardPlan } from "../runtime/invoke.ts";
import { dispatchMcpRequest } from "./dispatcher.ts";
import { createMcpCliCalls, type McpCliCallInput } from "./mirror.ts";
import { decodeMcpRequest, type McpServerInfo } from "./protocol.ts";
import { createMcpRegistry, type McpToolRegistration, registerMcpTool, tool as declareTool } from "./registry.ts";

/** Stable server identity used by local and direct-dispatch parity fixtures. */
const SERVER_INFO: McpServerInfo = { name: "fixture-app", version: "1.0.0" };

/** Canonical 2026 request metadata. */
const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
} as const;

/** Creates one typed echo registration with optional wrapper markers. */
function echoTool(options: { readonly wrapped?: boolean; readonly calls: string[] }): McpToolRegistration<object> {
  const inputSchema = z.strictObject({ value: z.string() });
  type Locals = { readonly caller: string };
  const declaration: BoundDeclaration<typeof inputSchema, { value: string }, Locals, object> = {
    inputSchema,
    guardPlan: compileGuardPlan<z.output<typeof inputSchema>, object>()({
      operation: () => allow({ caller: "local" }),
    }) as BoundDeclaration<typeof inputSchema, { value: string }, Locals, object>["guardPlan"],
    handler: ({ inputs, locals, source, signal, env, headers }) => {
      options.calls.push(inputs.value);
      assert.equal(source, "local");
      assert.equal(signal.aborted, false);
      assert.equal(env?.get("TOKEN"), "local-secret");
      assert.equal(headers, undefined);
      assert.equal(locals.caller, "local");
      console.log(`stdout:${inputs.value}`);
      console.error(`stderr:${inputs.value}`);
      return { value: inputs.value };
    },
  };
  return registerMcpTool({
    name: "echo",
    description: "Echo one value.",
    inputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
    outputSchema: { type: "object" },
    ...(options.wrapped === undefined ? {} : { inputWrapped: options.wrapped }),
    declaration,
  });
}

test("local MCP call uses the exact registry, source, signal, and captured native outcome once", async () => {
  const calls: string[] = [];
  const registry = createMcpRegistry([echoTool({ calls })]);
  const entries = createMcpCliCalls({ registry, serverInfo: SERVER_INFO });
  const controller = new AbortController();
  const locals = { caller: "seed" };
  const input: McpCliCallInput = { name: "echo", arguments: { value: "hello" } };
  const result = await entries.local.invoke(input, {
    mode: "local",
    locals,
    signal: controller.signal,
    env: { get: (name) => (name === "TOKEN" ? "local-secret" : undefined) },
  });

  assert.equal(result.kind, "native");
  assert.deepEqual(calls, ["hello"]);
  assert.equal(result.stdout, "stdout:hello\n");
  assert.equal(result.stderr, "stderr:hello\n");
  if (result.kind !== "native") return;
  assert.equal("result" in result.value, true);
  if (!("result" in result.value)) return;
  assert.deepEqual((result.value.result as Record<string, unknown>).structuredContent, { value: "hello" });

  const decoded = decodeMcpRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { _meta: META, ...input },
  });
  assert.equal(decoded.kind, "request");
  if (decoded.kind !== "request") return;
  const direct = await dispatchMcpRequest({
    request: decoded.request,
    registry,
    serverInfo: SERVER_INFO,
    base: {
      locals,
      signal: controller.signal,
      surface: "mcp",
      source: "local",
      env: { get: (name) => (name === "TOKEN" ? "local-secret" : undefined) },
    },
  });
  assert.deepEqual(result.value, direct);
  assert.deepEqual(calls, ["hello", "hello"]);
});

test("local MCP call rejects preselected input failures without invoking and retains abort transport failures", async () => {
  const calls: string[] = [];
  const entries = createMcpCliCalls({
    registry: createMcpRegistry([echoTool({ calls, wrapped: true })]),
    serverInfo: SERVER_INFO,
  });

  const context = {
    mode: "local" as const,
    locals: {},
    signal: new AbortController().signal,
    env: { get: () => undefined },
  };

  const unknown = await entries.local.invoke({ name: "missing", arguments: {} }, context);
  assert.deepEqual(unknown, {
    kind: "failure",
    category: "input",
    code: "MCP_TOOL_NOT_FOUND",
    message: "MCP tool is not registered",
    stdout: "",
    stderr: "",
  });
  const malformed = await entries.local.invoke({ name: "echo", arguments: { value: "bad" } }, context);
  assert.equal(malformed.kind, "native");
  if (malformed.kind === "native" && "error" in malformed.value) {
    assert.equal(malformed.value.error.code, -32_602);
  }
  assert.deepEqual(calls, []);

  const controller = new AbortController();
  controller.abort("stopped");
  const aborted = await entries.local.invoke(
    { name: "echo", arguments: { input: { value: "never" } } },
    { ...context, signal: controller.signal },
  );
  assert.deepEqual(aborted, {
    kind: "failure",
    category: "transport",
    code: "CALL_ABORTED",
    message: "MCP call was aborted",
    stdout: "",
    stderr: "",
  });
  assert.deepEqual(calls, []);

  const duringController = new AbortController();
  const inputSchema = z.strictObject({ value: z.string() });
  const abortingRegistry = createMcpRegistry([
    registerMcpTool({
      name: "aborting",
      description: "Abort after writing.",
      inputSchema: { type: "object", additionalProperties: false },
      declaration: {
        inputSchema,
        guardPlan: compileGuardPlan<z.output<typeof inputSchema>, object>()({}),
        handler: () => {
          console.log("before-abort");
          console.error("aborted-stderr");
          duringController.abort("stopped");
          return { ok: true };
        },
      },
    }),
  ]);
  const during = await createMcpCliCalls({
    registry: abortingRegistry,
    serverInfo: SERVER_INFO,
  }).local.invoke({ name: "aborting", arguments: { value: "go" } }, { ...context, signal: duringController.signal });
  assert.deepEqual(during, {
    kind: "failure",
    category: "transport",
    code: "CALL_ABORTED",
    message: "MCP call was aborted",
    stdout: "before-abort\n",
    stderr: "aborted-stderr\n",
  });
});

test("local MCP call derives credentials from env and retains the same native denial as stdio", async () => {
  const registration = declareTool<object>()({
    name: "protected",
    description: "Protected.",
    inputSchema: z.strictObject({}),
    handler: () => "unreachable",
  });
  const registry = createMcpRegistry([registration], {
    guard: ({ env, headers, source }) => {
      assert.equal(source, "local");
      assert.equal(env?.get("TOKEN"), "local-token");
      assert.equal(headers, undefined);
      return deny({
        code: "LOCAL_FORBIDDEN",
        message: "Local access denied.",
        http: { status: 403 },
      });
    },
  });
  const result = await createMcpCliCalls({ registry, serverInfo: SERVER_INFO }).local.invoke(
    { name: "protected", arguments: {} },
    {
      mode: "local",
      locals: {},
      signal: new AbortController().signal,
      env: { get: (name) => (name === "TOKEN" ? "local-token" : undefined) },
    },
  );
  assert.equal(result.kind, "native");
  if (result.kind !== "native" || !("result" in result.value)) return;
  const toolResult = result.value.result as {
    readonly isError: boolean;
    readonly structuredContent: unknown;
  };
  assert.equal(toolResult.isError, true);
  assert.deepEqual(toolResult.structuredContent, {
    error: {
      code: "LOCAL_FORBIDDEN",
      message: "Local access denied.",
      http: { status: 403 },
    },
  });
});

test("relay sends one exact-URL MCP request with only explicit and framework-owned headers", async () => {
  const localCalls: string[] = [];
  const entries = createMcpCliCalls({
    registry: createMcpRegistry([echoTool({ calls: localCalls })]),
    serverInfo: SERVER_INFO,
  });
  const endpoint = new URL("https://relay.example.test/custom/mcp?tenant=one");
  const controller = new AbortController();
  let requests = 0;
  let capturedUrl: RequestInfo | URL | undefined;
  let capturedInit: RequestInit | undefined;
  const fetch: typeof globalThis.fetch = async (url, init) => {
    requests += 1;
    capturedUrl = url;
    capturedInit = init;
    return Response.json({
      jsonrpc: "2.0",
      id: 1,
      result: {
        resultType: "complete",
        content: [{ type: "text", text: '{"value":"remote"}' }],
        structuredContent: { value: "remote" },
        isError: false,
        _meta: { "io.modelcontextprotocol/serverInfo": SERVER_INFO },
      },
    });
  };

  const result = await entries.relay.invoke(
    { name: "echo", arguments: { value: "hello" } },
    {
      mode: "relay",
      endpoint,
      headers: [
        ["x-token", "explicit"],
        ["accept", "application/json"],
      ],
      fetch,
      signal: controller.signal,
    },
  );

  assert.equal(requests, 1);
  assert.equal(capturedUrl, endpoint);
  assert.equal(capturedInit?.method, "POST");
  assert.equal(capturedInit?.signal, controller.signal);
  assert.equal(capturedInit?.redirect, "manual");
  assert.deepEqual(Object.fromEntries(new Headers(capturedInit?.headers)), {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "mcp-method": "tools/call",
    "mcp-name": "echo",
    "mcp-protocol-version": "2026-07-28",
    "x-token": "explicit",
  });
  assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "echo",
      arguments: { value: "hello" },
      _meta: META,
    },
  });
  assert.equal(result.kind, "native");
  if (result.kind === "native") {
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    assert.equal("result" in result.value, true);
  }
  assert.deepEqual(localCalls, []);
});

test("relay retains native MCP errors and sanitizes HTTP, decode, network, and abort failures", async () => {
  const entries = createMcpCliCalls({
    registry: createMcpRegistry([]),
    serverInfo: SERVER_INFO,
  });
  const endpoint = new URL("https://relay.example.test/exact");
  const input = { name: "remote", arguments: {} } as const;
  const call = (fetch: typeof globalThis.fetch, signal: AbortSignal = new AbortController().signal) =>
    entries.relay.invoke(input, { mode: "relay", endpoint, headers: [], fetch, signal });

  const nativeError = await call(async () =>
    Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32001, message: "Denied", data: { code: "FORBIDDEN" } } }),
  );
  assert.equal(nativeError.kind, "native");
  if (nativeError.kind === "native" && "error" in nativeError.value) {
    assert.equal(nativeError.value.error.code, -32001);
  }

  const cases = [
    {
      response: new Response(null, { status: 302, headers: { location: "https://redirect.example.test/next" } }),
      code: "MCP_RELAY_HTTP_ERROR",
      status: 302,
    },
    {
      response: new Response("secret", { status: 401 }),
      code: "MCP_RELAY_HTTP_ERROR",
      status: 401,
    },
    {
      response: new Response("{", { status: 200 }),
      code: "INVALID_MCP_RESPONSE",
    },
    {
      response: Response.json({ jsonrpc: "2.0", id: 2, result: {} }),
      code: "INVALID_MCP_RESPONSE",
    },
    {
      response: Response.json({ jsonrpc: "2.0", id: 1 }),
      code: "INVALID_MCP_RESPONSE",
    },
    {
      response: Response.json({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: "{}" }], isError: false },
      }),
      code: "INVALID_MCP_RESPONSE",
    },
    {
      response: Response.json({
        jsonrpc: "2.0",
        id: 1,
        result: {
          resultType: "complete",
          content: [{ type: "image", data: "missing-text" }],
          isError: false,
          _meta: { "io.modelcontextprotocol/serverInfo": SERVER_INFO },
        },
      }),
      code: "INVALID_MCP_RESPONSE",
    },
    {
      response: Response.json({
        jsonrpc: "2.0",
        id: 1,
        result: {
          resultType: "complete",
          content: [{ type: "text", text: "Denied" }],
          isError: true,
          structuredContent: {},
          _meta: { "io.modelcontextprotocol/serverInfo": SERVER_INFO },
        },
      }),
      code: "INVALID_MCP_RESPONSE",
    },
  ] as const;
  for (const fixture of cases) {
    const result = await call(async () => fixture.response);
    assert.equal(result.kind, "failure");
    if (result.kind === "failure") {
      assert.equal(result.code, fixture.code);
      assert.equal(result.status, "status" in fixture ? fixture.status : undefined);
      assert.equal(result.message.includes("secret"), false);
    }
  }

  const network = await call(async () => Promise.reject(new Error("https://secret.example")));
  assert.equal(network.kind, "failure");
  if (network.kind === "failure") {
    assert.equal(network.code, "MCP_RELAY_FAILED");
    assert.equal(JSON.stringify(network).includes("secret"), false);
  }

  const controller = new AbortController();
  const abort = await call(async (_url, init) => {
    assert.equal(init?.signal, controller.signal);
    controller.abort("done");
    throw new DOMException("aborted", "AbortError");
  }, controller.signal);
  assert.equal(abort.kind, "failure");
  if (abort.kind === "failure") assert.equal(abort.code, "CALL_ABORTED");

  const bodyController = new AbortController();
  const bodyAbort = await call(async () => {
    bodyController.abort("done");
    return new Response("unreadable", { status: 200 });
  }, bodyController.signal);
  assert.equal(bodyAbort.kind, "failure");
  if (bodyAbort.kind === "failure") assert.equal(bodyAbort.code, "CALL_ABORTED");

  const decodeController = new AbortController();
  const decodeAbort = await call(async () => {
    const response = new Response("{}", { status: 200 });
    response.json = async () => {
      decodeController.abort("done");
      throw new SyntaxError("broken");
    };
    return response;
  }, decodeController.signal);
  assert.equal(decodeAbort.kind, "failure");
  if (decodeAbort.kind === "failure") {
    assert.equal(decodeAbort.code, "CALL_ABORTED");
    assert.equal(decodeAbort.message, "MCP relay was aborted");
  }
});

test("relay classifies local-only unsupported argument serialization without calling fetch", async () => {
  const entries = createMcpCliCalls({
    registry: createMcpRegistry([]),
    serverInfo: SERVER_INFO,
  });
  let calls = 0;
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const result = await entries.relay.invoke(
    { name: "remote", arguments: circular },
    {
      mode: "relay",
      endpoint: new URL("https://relay.example.test"),
      headers: [],
      fetch: async () => {
        calls += 1;
        return new Response();
      },
      signal: new AbortController().signal,
    },
  );
  assert.equal(result.kind, "failure");
  if (result.kind === "failure") assert.equal(result.code, "INVALID_MCP_ARGUMENTS");
  assert.equal(calls, 0);
});

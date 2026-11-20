/*
Focused MCP stdio adapter tests using only injected in-memory streams.
They cover NDJSON framing, protocol parity, overlap, controls, output isolation, failure, and EOF drain.
*/

import assert from "node:assert/strict";
import { PassThrough, Readable, Writable } from "node:stream";
import { test } from "node:test";
import { z } from "zod";
import { deny, type BoundDeclaration, type InvocationContext } from "../core/invocation.ts";
import { invocationScopeState } from "../runtime/invocation-scope.ts";
import { compileGuardPlan } from "../runtime/invoke.ts";
import { createMcpRegistry, type McpToolRegistration, registerMcpTool, tool as declareTool } from "./registry.ts";
import { type McpProgressLocals, serveMcpStdio } from "./stdio.ts";

/** Stable MCP identity used by every stdio fixture. */
const SERVER_INFO = { name: "fixture-app", version: "1.0.0" } as const;

/** Canonical 2026 request metadata used by normal fixtures. */
const META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
} as const;

/** Seed fields supplied afresh before the adapter adds progress control. */
interface FixtureSeed {
  /** Fixture caller identity visible to guards and handlers. */
  readonly caller: string;
}

/** Complete locals type expected by registered fixture declarations. */
type FixtureLocals = FixtureSeed & McpProgressLocals;

/** Minimal tool handler context inferred from the fixture declaration. */
type FixtureContext = InvocationContext<{ value: string }, FixtureLocals>;

/** In-memory protocol capture retaining both parsed messages and the writable stream. */
interface CapturedOutput {
  /** Parsed newline-delimited JSON messages in arrival order. */
  readonly messages: object[];
  /** Stream passed into the adapter. */
  readonly stream: Writable;
}

/** Externally settled asynchronous fixture value. */
interface DeferredValue<T> {
  /** Promise resolved or rejected by the test. */
  readonly promise: Promise<T>;
  /** Rejects the controlled promise. */
  readonly reject: (reason?: unknown) => void;
  /** Resolves the controlled promise. */
  readonly resolve: (value: T | PromiseLike<T>) => void;
}

/** Builds one strongly typed native fixture declaration for heterogeneous registration. */
function declaration(
  handler: (context: FixtureContext) => unknown | Promise<unknown>,
): BoundDeclaration<z.ZodObject<{ value: z.ZodString }>, unknown, FixtureLocals> {
  const inputSchema = z.strictObject({ value: z.string() });
  type Input = z.output<typeof inputSchema>;
  return {
    inputSchema,
    guardPlan: compileGuardPlan<Input, FixtureLocals>()({}) as BoundDeclaration<
      typeof inputSchema,
      unknown,
      FixtureLocals
    >["guardPlan"],
    handler,
  };
}

/** Registers one exact MCP tool name and capture-friendly object schema. */
function tool(
  name: string,
  handler: (context: FixtureContext) => unknown | Promise<unknown>,
): McpToolRegistration<FixtureLocals> {
  return registerMcpTool({
    name,
    description: `Run ${name}.`,
    inputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
    declaration: declaration(handler),
  });
}

/** Encodes one request fixture with canonical metadata and an optional raw token. */
function request(
  id: string | number,
  method: string,
  params: Record<string, unknown> = {},
  progressToken?: string | number,
): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method,
    params: {
      ...params,
      _meta: {
        ...META,
        ...(progressToken === undefined ? {} : { progressToken }),
      },
    },
  };
}

/** Encodes one notification fixture with canonical metadata. */
function notification(method: string, params: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    method,
    params: { ...params, _meta: META },
  };
}

/** Creates an in-memory capture stream and its parsed protocol messages. */
function captureOutput(highWaterMark = 16_384): CapturedOutput {
  const messages: object[] = [];
  let buffered = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      buffered += chunk.toString();
      let newline = buffered.indexOf("\n");
      while (newline !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (line.length > 0) messages.push(JSON.parse(line) as object);
        newline = buffered.indexOf("\n");
      }
      if (highWaterMark === 1) setImmediate(callback);
      else callback();
    },
    highWaterMark,
  });
  return { messages, stream };
}

/** Creates an externally settled promise without relying on runtime-specific convenience APIs. */
function deferred<T>(): DeferredValue<T> {
  let rejectPromise: (reason?: unknown) => void = () => {};
  let resolvePromise: (value: T | PromiseLike<T>) => void = () => {};
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, reject: rejectPromise, resolve: resolvePromise };
}

/** Waits for the next turn so an active handler can reach its controlled checkpoint. */
async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Waits until a synchronous fixture predicate becomes true. */
async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await tick();
  }
  assert.fail("fixture condition did not become true");
}

/** Returns parsed messages in wire arrival order for one injected output. */
function messagesById(messages: readonly object[], id: string | number): Record<string, unknown>[] {
  return messages.filter(
    (message): message is Record<string, unknown> => "id" in message && (message as { id: unknown }).id === id,
  );
}

test("incrementally decodes chunked UTF-8 and trailing NDJSON while preserving MCP core parity", async () => {
  const registry = createMcpRegistry([tool("echo", ({ inputs }) => ({ value: inputs.value }))]);
  const output = captureOutput();
  const lines = [
    "",
    JSON.stringify(request("discover", "server/discover")),
    "   ",
    JSON.stringify(request(8, "tools/list")),
    JSON.stringify(request("call", "tools/call", { name: "echo", arguments: { value: "hello \u{1F642}" } })),
    "{not-json",
  ];
  const bytes = Buffer.from(lines.join("\n"));
  const chunks = [
    bytes.subarray(0, 7),
    bytes.subarray(7, 31),
    bytes.subarray(31, 94),
    bytes.subarray(94, bytes.length - 2),
    bytes.subarray(bytes.length - 2),
  ];
  const input = Readable.from(
    (async function* () {
      for (const chunk of chunks) yield chunk;
    })(),
  );

  await serveMcpStdio({
    registry,
    serverInfo: SERVER_INFO,
    instructions: "Fixture instructions.",
    stdin: input,
    stdout: output.stream,
    createSeedLocals: () => ({ caller: "fixture" }),
  });

  const discover = messagesById(output.messages, "discover")[0] as {
    result: { resultType: string; ttlMs: number; cacheScope: string; supportedVersions: string[] };
  };
  assert.deepEqual(discover.result.supportedVersions, ["2026-07-28"]);
  assert.equal(discover.result.resultType, "complete");
  assert.equal(discover.result.ttlMs, 3_600_000);
  assert.equal(discover.result.cacheScope, "public");
  const listed = messagesById(output.messages, 8)[0] as { result: { tools: { name: string }[] } };
  assert.deepEqual(
    listed.result.tools.map((entry) => entry.name),
    ["echo"],
  );
  assert.deepEqual(messagesById(output.messages, "call")[0], {
    jsonrpc: "2.0",
    id: "call",
    result: {
      resultType: "complete",
      content: [{ type: "text", text: '{"value":"hello 🙂"}' }],
      structuredContent: { value: "hello 🙂" },
      isError: false,
      _meta: {
        "io.modelcontextprotocol/serverInfo": SERVER_INFO,
      },
    },
  });
  assert.equal(
    (
      output.messages.find((message) => "error" in message && message.error) as {
        error: { code: number; message: string };
      }
    ).error.code,
    -32_700,
  );
});

test("overlaps calls, rejects duplicate active IDs, and isolates typed cancellation and terminal output", async () => {
  const releases = new Map<string, () => void>();
  const registry = createMcpRegistry([
    tool("wait", async ({ inputs, signal }) => {
      await new Promise<void>((resolve, reject) => {
        if (signal.aborted) return reject(signal.reason);
        const onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        releases.set(inputs.value, () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        });
      });
      return inputs.value;
    }),
  ]);
  const input = new PassThrough();
  const output = captureOutput();
  let seedCalls = 0;
  const serving = serveMcpStdio({
    registry,
    serverInfo: SERVER_INFO,
    stdin: input,
    stdout: output.stream,
    createSeedLocals: () => {
      seedCalls += 1;
      return { caller: "fixture" };
    },
  });

  input.write(`${JSON.stringify(request("one", "tools/call", { name: "wait", arguments: { value: "slow" } }))}\n`);
  input.write(`${JSON.stringify(request("one", "tools/call", { name: "wait", arguments: { value: "duplicate" } }))}\n`);
  input.write(`${JSON.stringify(request(2, "tools/call", { name: "wait", arguments: { value: "fast" } }))}\n`);
  await until(() => releases.has("slow") && releases.has("fast"));
  input.write(`${JSON.stringify(notification("notifications/cancelled", { requestId: "2" }))}\n`);
  await tick();
  assert.equal(releases.has("fast"), true);
  releases.get("fast")?.();
  await until(() => messagesById(output.messages, 2).length === 1);

  input.write(
    `${JSON.stringify(notification("notifications/cancelled", { requestId: "1", reason: "wrong id type" }))}\n`,
  );
  assert.equal(releases.has("slow"), true);
  input.write(`${JSON.stringify(notification("notifications/cancelled", { requestId: "one", reason: 7 }))}\n`);
  await tick();
  assert.equal(releases.has("slow"), true);
  input.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: "one", reason: "missing metadata" },
    })}\n`,
  );
  await tick();
  assert.equal(releases.has("slow"), true);
  input.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: "one", _meta: null },
    })}\n`,
  );
  await tick();
  assert.equal(releases.has("slow"), true);
  input.write(
    `${JSON.stringify(notification("notifications/cancelled", { requestId: "one", reason: "fixture cancel" }))}\n`,
  );
  input.write(`${JSON.stringify(notification("notifications/cancelled", { requestId: "unknown" }))}\n`);
  input.end();
  await serving;

  assert.equal(seedCalls, 2);
  const duplicates = messagesById(output.messages, "one").filter((message) => "error" in message) as {
    error: { code: number; message: string };
  }[];
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0]?.error.code, -32_600);
  assert.match(duplicates[0]?.error.message ?? "", /already in flight/);
  assert.equal((messagesById(output.messages, 2)[0] as { result: object }).result !== undefined, true);
  assert.equal(
    messagesById(output.messages, "one").some(
      (message) => "result" in message && (message.result as { isError?: boolean }).isError,
    ),
    false,
  );
  assert.equal(
    output.messages.some((message) => "error" in message && (message.error as { code?: number }).code === -32_602),
    false,
  );
});

test("emits opt-in progress strictly and suppresses progress after terminal or cancellation", async () => {
  const cancelled = deferred<void>();
  const registry = createMcpRegistry([
    tool("progress", async ({ inputs, locals, signal }) => {
      if (inputs.value === "cancel") {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            cancelled.resolve();
            reject(signal.reason);
          });
        });
        return "unreachable";
      }
      if (inputs.value === "no-token") return inputs.value;
      locals.reportProgress(0, 2, "started");
      assert.throws(() => locals.reportProgress(0, 2), RangeError);
      assert.throws(() => locals.reportProgress(-1, 2), RangeError);
      assert.throws(() => locals.reportProgress(Number.POSITIVE_INFINITY), RangeError);
      assert.throws(() => locals.reportProgress(3, 2), RangeError);
      locals.reportProgress(1, 2);
      locals.reportProgress(2, 2, "done");
      setImmediate(() => locals.reportProgress(3, 3, "late"));
      return inputs.value;
    }),
  ]);
  const input = new PassThrough();
  const output = captureOutput();
  const serving = serveMcpStdio({
    registry,
    serverInfo: SERVER_INFO,
    stdin: input,
    stdout: output.stream,
    createSeedLocals: () => ({ caller: "fixture" }),
  });

  input.write(
    `${JSON.stringify(
      request("progress", "tools/call", { name: "progress", arguments: { value: "no-token" } }, undefined),
    )}\n`,
  );
  input.write(
    `${JSON.stringify(
      request("token", "tools/call", { name: "progress", arguments: { value: "active" } }, "token-7"),
    )}\n`,
  );
  input.write(
    `${JSON.stringify(request("cancel", "tools/call", { name: "progress", arguments: { value: "cancel" } }, 9))}\n`,
  );
  await tick();
  input.write(`${JSON.stringify(notification("notifications/cancelled", { requestId: "cancel" }))}\n`);
  await cancelled.promise;
  input.end();
  await serving;

  const progress = output.messages.filter(
    (message) => "method" in message && message.method === "notifications/progress",
  ) as { params: { progress: number; progressToken: string | number; total?: number; message?: string } }[];
  assert.deepEqual(
    progress.map((message) => message.params),
    [
      { progress: 0, progressToken: "token-7", total: 2, message: "started" },
      { progress: 1, progressToken: "token-7", total: 2 },
      { progress: 2, progressToken: "token-7", total: 2, message: "done" },
    ],
  );
  assert.equal(messagesById(output.messages, "cancel").length, 0);
});

test("keeps local env read-only, captures handler output, and rejects cwd mutation during overlap", async () => {
  const previous = process.env.ARGS_BARG_STDIO_FIXTURE;
  process.env.ARGS_BARG_STDIO_FIXTURE = "launch";
  const originalCwd = process.cwd();
  const registry = createMcpRegistry([
    tool("context", (context) => {
      const { env, locals, source, surface } = context;
      console.log("captured stdout");
      console.error("captured stderr");
      process.stdout.write("captured raw write\n");
      let chdirError = "";
      try {
        process.chdir(originalCwd);
      } catch (error) {
        chdirError = error instanceof Error ? error.message : String(error);
      }
      return {
        caller: locals.caller,
        env: env?.get("ARGS_BARG_STDIO_FIXTURE"),
        constructorIsUndefined: env?.get("constructor") === undefined,
        toStringIsUndefined: env?.get("toString") === undefined,
        hasHeaders: "headers" in context,
        source,
        surface,
        chdirError,
      };
    }),
  ]);
  const output = captureOutput();
  const input = new PassThrough();
  const serving = serveMcpStdio({
    registry,
    serverInfo: SERVER_INFO,
    stdin: input,
    stdout: output.stream,
    createSeedLocals: () => {
      assert.equal(invocationScopeState().stdoutOutsideToStderr, true);
      return { caller: "fresh" };
    },
  });

  process.env.ARGS_BARG_STDIO_FIXTURE = "changed-after-launch";
  input.end(`${JSON.stringify(request("context", "tools/call", { name: "context", arguments: { value: "x" } }))}\n`);

  try {
    await serving;
    const response = messagesById(output.messages, "context")[0] as {
      result: { structuredContent: Record<string, unknown> };
    };
    assert.equal(response.result.structuredContent.env, "launch");
    assert.equal(response.result.structuredContent.constructorIsUndefined, true);
    assert.equal(response.result.structuredContent.toStringIsUndefined, true);
    assert.equal(response.result.structuredContent.source, "local");
    assert.equal(response.result.structuredContent.surface, "mcp");
    assert.equal(response.result.structuredContent.hasHeaders, false);
    assert.match(String(response.result.structuredContent.chdirError), /process\.chdir isn't allowed/);
    assert.equal(process.cwd(), originalCwd);
    assert.equal(
      output.messages.some((message) => JSON.stringify(message).includes("captured")),
      false,
    );
    assert.equal(invocationScopeState().stdoutOutsideToStderr, false);
  } finally {
    if (previous === undefined) delete process.env.ARGS_BARG_STDIO_FIXTURE;
    else process.env.ARGS_BARG_STDIO_FIXTURE = previous;
  }
});

test("stdio preserves MCP surface denials as native tool errors without HTTP transport metadata scraping", async () => {
  const registry = createMcpRegistry(
    [
      declareTool<FixtureLocals>()({
        name: "denied",
        description: "Denied.",
        inputSchema: z.strictObject({ value: z.string() }),
        handler: () => "unreachable",
      }),
    ],
    {
      guard: ({ env, source }) => {
        assert.equal(source, "local");
        assert.equal(env?.get("TOKEN"), "stdio-token");
        return deny({
          code: "AUTH_REQUIRED",
          message: "Authentication is required.",
          http: { status: 401 },
          challenge: { scheme: "bearer", error: "invalid_token" },
        });
      },
    },
  );
  const input = Readable.from([
    `${JSON.stringify(request("denied", "tools/call", { name: "denied", arguments: { value: "x" } }))}\n`,
  ]);
  const output = captureOutput();
  const previous = process.env.TOKEN;
  process.env.TOKEN = "stdio-token";
  try {
    await serveMcpStdio({
      registry,
      serverInfo: SERVER_INFO,
      stdin: input,
      stdout: output.stream,
      createSeedLocals: () => ({ caller: "fresh" }),
    });
  } finally {
    if (previous === undefined) delete process.env.TOKEN;
    else process.env.TOKEN = previous;
  }
  const response = messagesById(output.messages, "denied")[0] as {
    result: { isError: boolean; structuredContent: { error: Record<string, unknown> } };
  };
  assert.equal(response.result.isError, true);
  assert.deepEqual(response.result.structuredContent.error, {
    code: "AUTH_REQUIRED",
    message: "Authentication is required.",
    http: { status: 401 },
    challenge: { scheme: "bearer", error: "invalid_token" },
  });
});

test("rejects legacy discovery without cwd, roots, or initialization side effects", async () => {
  const registry = createMcpRegistry([tool("echo", ({ inputs }) => inputs.value)]);
  const output = captureOutput();
  const input = Readable.from([
    `${JSON.stringify({ jsonrpc: "2.0", id: "init", method: "initialize" })}\n`,
    `${JSON.stringify(request("roots", "roots/list"))}\n`,
    `${JSON.stringify(notification("notifications/initialized"))}\n`,
  ]);

  await serveMcpStdio({
    registry,
    serverInfo: SERVER_INFO,
    stdin: input,
    stdout: output.stream,
    createSeedLocals: () => ({ caller: "fixture" }),
  });

  assert.equal((messagesById(output.messages, "init")[0] as { error: { code: number } }).error.code, -32_022);
  assert.equal((messagesById(output.messages, "roots")[0] as { error: { code: number } }).error.code, -32_601);
  assert.equal(
    output.messages.some((message) => JSON.stringify(message).includes("roots/list")),
    false,
  );
});

test("waits for active calls on EOF and restores all temporary listeners and stdout policy", async () => {
  const release = deferred<void>();
  const registry = createMcpRegistry([
    tool("drain", async ({ inputs }) => {
      await release.promise;
      return inputs.value;
    }),
  ]);
  const input = new PassThrough();
  const output = captureOutput();
  const initialOutputErrors = output.stream.listenerCount("error");
  let settled = false;
  const serving = serveMcpStdio({
    registry,
    serverInfo: SERVER_INFO,
    stdin: input,
    stdout: output.stream,
    emitLifecycle: () => {},
    createSeedLocals: () => ({ caller: "fixture" }),
  }).finally(() => {
    settled = true;
  });

  input.end(`${JSON.stringify(request("drain", "tools/call", { name: "drain", arguments: { value: "done" } }))}\n`);
  await tick();
  assert.equal(settled, false);
  release.resolve();
  await serving;

  assert.equal(settled, true);
  assert.equal(messagesById(output.messages, "drain").length, 1);
  assert.equal(output.stream.listenerCount("error"), initialOutputErrors);
  assert.equal(invocationScopeState().stdoutOutsideToStderr, false);
});

test("serializes backpressure and aborts active work without a later frame after raw write failure", async () => {
  const slowOutput = captureOutput(1);
  const firstBackpressure = new Promise<void>((resolve) => {
    slowOutput.stream.once("drain", resolve);
  });
  const input = Readable.from([
    `${JSON.stringify(request("first", "server/discover"))}\n`,
    `${JSON.stringify(request("second", "server/discover"))}\n`,
  ]);
  const registry = createMcpRegistry([]);
  const serving = serveMcpStdio({
    registry,
    serverInfo: SERVER_INFO,
    stdin: input,
    stdout: slowOutput.stream,
    createSeedLocals: () => ({ caller: "fixture" }),
  });
  await serving;
  await firstBackpressure;
  assert.deepEqual(
    slowOutput.messages.filter((message) => "id" in message).map((message) => (message as { id: string }).id),
    ["first", "second"],
  );

  const aborted = deferred<void>();
  const failingRegistry = createMcpRegistry([
    tool("blocked", async ({ locals, signal }) => {
      locals.reportProgress(0, 1);
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          aborted.resolve();
          reject(signal.reason);
        });
      });
      return "unreachable";
    }),
  ]);
  const failure = new Error("EPIPE");
  let writes = 0;
  const failingOutput = new Writable({
    write(_chunk, _encoding, callback) {
      writes += 1;
      callback(failure);
    },
  });
  const failingInput = new PassThrough();
  const failedServing = serveMcpStdio({
    registry: failingRegistry,
    serverInfo: SERVER_INFO,
    stdin: failingInput,
    stdout: failingOutput,
    createSeedLocals: () => ({ caller: "fixture" }),
  });
  failingInput.write(
    `${JSON.stringify(
      request("write-failure", "tools/call", { name: "blocked", arguments: { value: "x" } }, "failing-progress"),
    )}\n`,
  );
  failingInput.end(`${JSON.stringify(request("later", "server/discover"))}\n`);
  await Promise.race([
    failedServing.catch((error) => {
      assert.equal(error, failure);
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("failed serve did not reject")), 1_000)),
  ]);
  await aborted.promise;
  assert.equal(writes, 1);
});

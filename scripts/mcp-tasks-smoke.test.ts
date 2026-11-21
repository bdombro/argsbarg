/*
Runs a synthetic MCP client against a separate built Argsbarg server process.
Checks the public stdio wire without a real host, network, or credentials.
*/

import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { test } from "node:test";

/** Fields read from newline-delimited replies and notifications. */
interface Frame {
  /** JSON-RPC envelope version. */
  jsonrpc: string;
  /** ID echoed on replies. */
  id?: number;
  /** Notification name. */
  method?: string;
  /** Error code when the request was rejected. */
  error?: { code: number };
  /** Payload on notifications. */
  params?: Record<string, unknown> & { _meta?: Record<string, unknown> };
  /** Payload on successful replies. */
  result?: Record<string, unknown> & { _meta?: Record<string, unknown> };
}

test("built stdio handles the no-Tasks fallback and pushes synthetic task progress and completion", { timeout: 8_000 }, async (t) => {
  const child = fork(new URL("./mcp-tasks-smoke-fixture.ts", import.meta.url), ["serve", "mcp", "--stdio"], {
    env: {},
    execArgv: [],
    silent: true,
  });
  const { stdin, stdout, stderr } = child;
  assert.ok(stdin && stdout && stderr);
  const closed = once(child, "close").catch((error: unknown) => [null, error]);
  const lines = createInterface({ input: stdout });
  const frames = lines[Symbol.asyncIterator]();
  let diagnostics = "";
  stderr.setEncoding("utf8").on("data", (chunk: string) => {
    diagnostics = (diagnostics + chunk).slice(-4096);
  });
  stdin.on("error", (error) => {
    diagnostics = (diagnostics + error.message).slice(-4096);
  });
  t.signal.addEventListener("abort", () => { child.kill("SIGKILL"); }, { once: true });

  /** Send a request with the pinned protocol revision, independent of server constants. */
  const send = (id: number, method: string, params: Record<string, unknown> = {}, tasks = true): void => {
    stdin.write(`${JSON.stringify({
      id,
      jsonrpc: "2.0",
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/clientCapabilities": tasks ? { extensions: { "io.modelcontextprotocol/tasks": {} } } : {},
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        },
      },
    })}\n`);
  };

  /** Read the next full wire frame, failing on a bad envelope or early exit. */
  async function read(): Promise<Frame> {
    const frame = await frames.next();
    assert.equal(frame.done, false, `Server closed stdout early: ${diagnostics}`);
    const parsed: Frame = JSON.parse(frame.value);
    assert.equal(parsed.jsonrpc, "2.0");
    return parsed;
  }

  /** Match ordinary replies by request ID before asserting their contents. */
  async function call(id: number, method: string, params?: Record<string, unknown>, tasks = true): Promise<Frame> {
    send(id, method, params, tasks);
    const reply = await read();
    assert.equal(reply.id, id);
    return reply;
  }

  /** Advance the app-owned job without relying on elapsed time. */
  async function advance(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      child.send("advance", (error) => error ? reject(error) : resolve());
    });
  }

  try {
    const taskId = "synthetic-mining-1";
    const subscriptionId = "io.modelcontextprotocol/subscriptionId";
    const toolCall = { arguments: {}, name: "start_synthetic_mining" };

    const discovery = await call(1, "server/discover");
    assert.deepEqual(discovery.result?.supportedVersions, ["2026-07-28"]);
    assert.deepEqual(discovery.result?.capabilities, { tools: {}, extensions: { "io.modelcontextprotocol/tasks": {} } });
    const listing = await call(2, "tools/list");
    assert.deepEqual((listing.result?.tools as { name: string }[]).map(({ name }) => name), [toolCall.name]);

    const fallback = await call(3, "tools/call", toolCall, false);
    assert.equal(fallback.result?.resultType, "complete");
    assert.deepEqual(fallback.result?.structuredContent, { tasksAvailable: false });
    assert.equal((await call(4, "tasks/get", { taskId })).error?.code, -32602);

    const handle = (await call(5, "tools/call", toolCall)).result;
    assert.equal(handle?.resultType, "task");
    assert.equal(handle.taskId, taskId);
    assert.equal(handle.status, "working");
    send(6, "subscriptions/listen", { notifications: { taskIds: [taskId] } });

    const ack = await read();
    assert.equal(ack.method, "notifications/subscriptions/acknowledged");
    assert.equal(ack.params?._meta?.[subscriptionId], 6);
    assert.deepEqual(ack.params?.notifications, { taskIds: [taskId] });

    await advance();
    const progress = await read();
    assert.equal(progress.method, "notifications/tasks");
    assert.equal(progress.params?._meta?.[subscriptionId], 6);
    assert.equal(progress.params?.taskId, taskId);
    assert.equal(progress.params?.status, "working");
    assert.equal(progress.params?.statusMessage, "Counted 2 of 3 rows");

    await advance();
    const completion = await read();
    assert.equal(completion.method, "notifications/tasks");
    assert.ok(completion.params);
    const { _meta, ...snapshot } = completion.params;
    assert.equal(_meta?.[subscriptionId], 6);
    assert.equal(snapshot.taskId, taskId);
    assert.equal(snapshot.status, "completed");
    assert.deepEqual(snapshot.result, {
      content: [{ type: "text", text: "Counted 3 synthetic rows" }],
      resultType: "complete",
      structuredContent: { rows: 3 },
    });

    // The fixture ends its watch after the completed snapshot. Drain that
    // subscription's closure frames before sending the independent readback.
    const ended = await read();
    assert.equal(ended.method, "notifications/cancelled");
    assert.equal(ended.params?.requestId, 6);
    assert.equal(ended.params?.reason, undefined);
    const subscriptionReply = await read();
    assert.equal(subscriptionReply.id, 6);
    assert.equal(subscriptionReply.result?.resultType, "complete");

    const readback = await call(7, "tasks/get", { taskId });
    assert.ok(readback.result);
    const { _meta: _readbackMeta, resultType, ...polled } = readback.result;
    assert.equal(resultType, "complete");
    assert.deepEqual(polled, snapshot);

    stdin.end();
    assert.deepEqual(await closed, [0, null], diagnostics);
  } finally {
    lines.close();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
  }
});

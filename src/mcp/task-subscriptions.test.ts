/*
Exercises a mining-style app-owned job over SSE and NDJSON, including
authorization, resume by readback, and transport-specific subscription teardown.
*/

import assert from "node:assert/strict";
import { EventEmitter, on, once } from "node:events";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { z } from "zod";
import { allow, deny } from "../core/invocation.ts";
import { createMcpHttpMount } from "./http.ts";
import { MCP_CLIENT_CAPABILITIES_KEY, MCP_PROTOCOL_VERSION, MCP_PROTOCOL_VERSION_KEY } from "./protocol.ts";
import { createMcpRegistry, tool } from "./registry.ts";
import { serveMcpStdio } from "./stdio.ts";
import { createMcpTaskRuntime, MCP_TASKS_EXTENSION, type McpTask, McpTaskNotFoundError } from "./tasks.ts";

/** Identifies the stream on a wire notification or completion. */
const SUBSCRIPTION_ID = "io.modelcontextprotocol/subscriptionId";

/** Exposes the parts of a wire frame needed by the tests. */
interface Frame {
  /** Request ID when this frame is a JSON-RPC response. */
  id?: number;
  /** Notification method. */
  method?: string;
  /** Notification payload. */
  params?: Record<string, unknown> & { _meta?: Record<string, unknown> };
  /** Polling or subscription completion payload. */
  result?: Record<string, unknown> & { _meta?: Record<string, unknown> };
  /** Protocol error if admission fails. */
  error?: { code: number };
}

for (const transport of ["http", "stdio"] as const) {
  test(`${transport} pushes mining progress and completion and reconnects without cancelling the job`, {
    timeout: 5_000,
  }, async () => {
    const changes = new EventEmitter();
    const watched = new EventEmitter();
    const initial: McpTask = {
      createdAt: "2026-11-21T09:00:00Z",
      lastUpdatedAt: "2026-11-21T09:00:00Z",
      status: "working",
      statusMessage: "Queued",
      taskId: "mine-1",
      ttlMs: null,
    };
    let task: McpTask | undefined;
    let jobCancellations = 0;
    let watchedCount = 0;
    const publicId = "mining__mine-1";
    const serverInfo = { name: "test-miner", version: "1.0.0" };
    const registry = createMcpRegistry([
      tool<{ caller: string }>()({
        name: "mining__start",
        description: "Start a mining job",
        inputSchema: z.strictObject({}),
        handler: ({ mcp }) => {
          task = initial;
          return mcp.tasks.reference(task);
        },
      }),
    ]);

    /** Checks access before opening a change stream. */
    const getTask = (taskId: string, caller: string): McpTask => {
      if (caller !== "owner" || task === undefined || task.taskId !== taskId) throw new McpTaskNotFoundError();
      return task;
    };
    const tasks = createMcpTaskRuntime<{ caller: string }>({
      childToolRoutes: new Map([["mining__start", "mining"]]),
      provider: {
        cancel: () => assert.fail("Subscription must not reach the parent provider"),
        get: () => assert.fail("Child polling must not reach the parent provider"),
        update: () => assert.fail("Subscription must not reach the parent provider"),
      },
      routes: [{
        prefix: "mining",
        guard: ({ locals }) =>
          locals.caller === "blocked"
            ? deny({ code: "BLOCKED", message: "Blocked" })
            : allow({ caller: locals.caller }),
        provider: {
          cancel: () => { jobCancellations++; },
          get: ({ taskId, locals }) => getTask(taskId, locals.caller),
          update: () => undefined,
          watch: ({ taskId, locals, signal }) => {
            getTask(taskId, locals.caller);
            watchedCount++;
            const updates = on(changes, "committed", { signal });
            signal.addEventListener("abort", () => watched.emit("stopped"), { once: true });
            return (async function* () {
              for await (const [snapshot] of updates as AsyncIterable<[McpTask]>) yield snapshot;
            })();
          },
        },
      }],
    });
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const lines = createInterface({ input: stdout });
    const stdioFrames = lines[Symbol.asyncIterator]();
    let localCaller = "owner";
    const subscriptionShutdown = new AbortController();
    const mount = createMcpHttpMount({
      middleware: (_request, { headers }) => ({ kind: "next", locals: { caller: headers.get("x-caller") ?? "" } }),
      registry,
      serverInfo,
      subscriptionShutdown: subscriptionShutdown.signal,
      tasks,
    });
    const serve = transport === "stdio" ? serveMcpStdio({
      createSeedLocals: () => ({ caller: localCaller }),
      registry,
      serverInfo,
      stdin,
      stdout,
      tasks,
    }) : undefined;

    /** Reads the next NDJSON frame from the simulated stdio connection. */
    const readStdio = async (): Promise<Frame> => {
      const { done, value } = await stdioFrames.next();
      assert.equal(done, false);
      return JSON.parse(value);
    };

    /** Sends one request using the transport's real wire envelope. */
    async function send(id: number, method: string, params: Record<string, unknown>, caller = "owner") {
      const body = JSON.stringify({
        id,
        jsonrpc: "2.0",
        method,
        params: {
          ...params,
          _meta: {
            [MCP_CLIENT_CAPABILITIES_KEY]: { extensions: { [MCP_TASKS_EXTENSION]: {} } },
            [MCP_PROTOCOL_VERSION_KEY]: MCP_PROTOCOL_VERSION,
            progressToken: "not-an-inline-call",
          },
        },
      });
      if (transport === "stdio") {
        localCaller = caller;
        stdin.write(`${body}\n`);
        return undefined;
      }
      const name = params.name ?? params.taskId;
      return mount.handle(new Request("http://localhost/mcp", {
        body,
        headers: {
          Accept: "application/json, text/event-stream",
          "Mcp-Method": method,
          ...(typeof name === "string" ? { "Mcp-Name": name } : {}),
          "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
          "x-caller": caller,
        },
        method: "POST",
      }), { signal: new AbortController().signal });
    }

    /** Reads one terminal JSON reply across either transport. */
    async function call(id: number, method: string, params: Record<string, unknown>): Promise<Frame> {
      const response = await send(id, method, params);
      return response === undefined ? readStdio() : response.json();
    }

    /** Opens the requested filter and exposes a pull-based wire reader and cancellation. */
    async function listen(id: number, taskIds: string[], caller?: string) {
      const response = await send(id, "subscriptions/listen", { notifications: { taskIds, toolsListChanged: true } }, caller);
      if (response !== undefined) assert.equal(response.headers.get("content-type"), "text/event-stream");
      const reader = response?.body?.getReader();
      return {
        /** Reads the next notification without waiting for the subscription to close. */
        read: async (): Promise<Frame> => {
          if (reader === undefined) return readStdio();
          const value = await reader.read();
          assert.equal(value.done, false);
          const text = new TextDecoder().decode(value.value);
          assert.match(text, /^data: .+\n\n$/);
          return JSON.parse(text.slice(6));
        },
        /** Cancels the subscription using the transport-specific signal. */
        cancel: async () => {
          if (reader !== undefined) await reader.cancel();
          else stdin.write(`${JSON.stringify({
            jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id },
          })}\n`);
        },
      };
    }

    /** Checks ack order, correlation and the accepted subset. */
    function checkAck(frame: Frame, id: number, taskIds: string[]) {
      assert.equal(frame.method, "notifications/subscriptions/acknowledged");
      assert.equal(frame.params?._meta?.[SUBSCRIPTION_ID], id);
      assert.deepEqual(frame.params?.notifications, taskIds.length === 0 ? {} : { taskIds });
    }

    /** Saves the app-owned snapshot before notifying its watchers. */
    function commit(snapshot: McpTask) {
      task = snapshot;
      changes.emit("committed", snapshot);
    }

    try {
      const handle = (await call(1, "tools/call", { name: "mining__start" })).result;
      assert.equal(handle?.resultType, "task");
      assert.equal(handle.taskId, publicId);
      const oversized = await call(9, "subscriptions/listen", {
        notifications: { taskIds: Array.from({ length: 33 }, (_, index) => `mining__${index}`) },
      });
      assert.equal(oversized.error?.code, -32_602);
      for (const [id, unauthorized] of [[2, "stranger"], [3, "blocked"]] as const) {
        const rejected = await listen(id, [publicId], unauthorized);
        checkAck(await rejected.read(), id, []);
        assert.equal((await rejected.read()).method, "notifications/cancelled");
        assert.equal((await rejected.read()).id, id);
      }
      assert.equal(watchedCount, 0);

      const live = await listen(4, [publicId, "mining__absent", publicId]);
      checkAck(await live.read(), 4, [publicId]);
      assert.equal(watchedCount, 1);
      const progress: McpTask = { ...initial, statusMessage: "Indexed 40%", lastUpdatedAt: "2026-11-21T09:01:00Z" };
      commit(progress);
      const update = await live.read();
      assert.equal(update.method, "notifications/tasks");
      assert.deepEqual(update.params, { ...progress, taskId: publicId, _meta: { [SUBSCRIPTION_ID]: 4 } });

      const stopped = once(watched, "stopped");
      await live.cancel();
      await stopped;
      assert.equal(jobCancellations, 0);
      commit({ ...progress, statusMessage: "Indexed 80%", lastUpdatedAt: "2026-11-21T09:02:00Z" });

      const reconnect = await listen(5, [publicId]);
      checkAck(await reconnect.read(), 5, [publicId]);
      assert.equal((await call(6, "tasks/get", { taskId: publicId })).result?.statusMessage, "Indexed 80%");
      const completed: McpTask = {
        ...progress,
        lastUpdatedAt: "2026-11-21T09:03:00Z",
        result: { content: [{ type: "text", text: "Indexed 100 records" }], resultType: "complete" },
        status: "completed",
        statusMessage: "Indexed 100%",
      };
      commit(completed);
      const terminal = await reconnect.read();
      assert.equal(terminal.method, "notifications/tasks");
      const { _meta, ...snapshot } = terminal.params ?? {};
      assert.equal(_meta?.[SUBSCRIPTION_ID], 5);
      const { _meta: _readbackMeta, resultType, ...readback } = (await call(7, "tasks/get", { taskId: publicId })).result ?? {};
      assert.equal(resultType, "complete");
      assert.deepEqual(snapshot, readback);

      const shutdown = once(watched, "stopped");
      if (transport === "http") subscriptionShutdown.abort();
      else stdin.end();
      assert.equal((await reconnect.read()).method, "notifications/cancelled");
      const end = await reconnect.read();
      assert.equal(end.id, 5);
      assert.equal(end.result?._meta?.[SUBSCRIPTION_ID], 5);
      await shutdown;
      assert.equal(jobCancellations, 0);
    } finally {
      subscriptionShutdown.abort();
      stdin.end();
      stdout.resume();
      lines.close();
      await serve;
    }
  });
}

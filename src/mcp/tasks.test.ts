/*
Focused tests for MCP Tasks capability negotiation, app-owned provider routing, and task references.
The fixtures own task state so Argsbarg can be checked as a wire and policy adapter only.
*/

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, test } from "node:test";
import { z } from "zod";
import type { InvocationBase } from "../core/invocation.ts";
import type { Locals } from "../core/types.ts";
import { argsbarg } from "../runtime/cli.ts";
import { dispatchMcpRequest } from "./dispatcher.ts";
import { createMcpHttpMount } from "./http.ts";
import { encodeMcpName, type McpRequest, type McpResultResponse, type McpServerInfo } from "./protocol.ts";
import { createMcpRegistry, type McpRegistry, tool } from "./registry.ts";
import { serveMcpStdio, type McpProgressLocals } from "./stdio.ts";
import { isMcpTaskInputResponse } from "./task-payloads.ts";
import {
  createMcpTaskRuntime,
  MCP_TASKS_EXTENSION,
  type McpTask,
  McpTaskNotFoundError,
  type McpTaskProvider,
  type McpTaskReference,
  McpTasksRequiredError,
} from "./tasks.ts";

/** Stable server identity used by protocol response assertions. */
const SERVER_INFO: McpServerInfo = { name: "tasks-demo", version: "1.0.0" };

/** Shared task request metadata with the Tasks extension enabled. */
const TASK_CAPABILITIES = {
  extensions: {
    [MCP_TASKS_EXTENSION]: {},
  },
} as const;

/** One valid app-owned working task. */
const WORKING_TASK: McpTask = {
  taskId: "job-7",
  status: "working",
  statusMessage: "Queued",
  createdAt: "2026-11-20T20:00:00.000Z",
  lastUpdatedAt: "2026-11-20T20:00:01.000Z",
  ttlMs: 60_000,
  pollIntervalMs: 1_000,
};

/** Sanitized provider call captured by the test fixture. */
interface TaskProviderCall {
  /** Operation selected by Argsbarg. */
  readonly operation: "get" | "update" | "cancel";
  /** Task ID supplied to the provider. */
  readonly taskId: string;
  /** Verified caller value supplied through operation locals. */
  readonly caller: string;
  /** Whether the exact request signal was already aborted. */
  readonly aborted: boolean;
  /** Input responses present for update operations. */
  readonly inputResponses?: Readonly<Record<string, unknown>>;
}

/** Package-internal App state read only by this wiring test. */
interface AppTaskInternals {
  /** Immutable MCP registry compiled from the app declaration. */
  readonly mcpRegistry?: McpRegistry<Locals>;
  /** Optional provider runtime compiled from `mcp.tasks`. */
  readonly mcpTasks?: import("./tasks.ts").McpTaskRuntime;
}

/** Builds one exact MCP request with optional extension capabilities. */
function request(
  id: string,
  method: string,
  params: Record<string, unknown>,
  clientCapabilities: Record<string, unknown> = TASK_CAPABILITIES,
): McpRequest {
  return {
    jsonrpc: "2.0",
    id,
    method,
    params,
    meta: {
      protocolVersion: "2026-07-28",
      clientCapabilities,
    },
  };
}

/** Builds one local MCP invocation base carrying a typed caller fixture. */
function base(
  caller = "user-1",
): InvocationBase<Locals & { readonly caller: string }> {
  return {
    env: { get: () => undefined },
    locals: { caller },
    signal: new AbortController().signal,
    source: "local",
    surface: "mcp",
  };
}

/** Builds one minimal app-owned provider that records operation inputs. */
function providerFixture(): {
  /** App-owned provider supplied to the runtime. */
  readonly provider: McpTaskProvider<Locals & { readonly caller: string }>;
  /** Operation calls captured for ownership and argument assertions. */
  readonly calls: TaskProviderCall[];
} {
  const calls: TaskProviderCall[] = [];
  let current = WORKING_TASK;
  return {
    calls,
    provider: {
      get: ({ taskId, locals, signal }) => {
        calls.push({ operation: "get", taskId, caller: locals.caller, aborted: signal.aborted });
        return current;
      },
      update: ({ taskId, inputResponses, locals, signal }) => {
        calls.push({ operation: "update", taskId, inputResponses, caller: locals.caller, aborted: signal.aborted });
        current = {
          ...WORKING_TASK,
          lastUpdatedAt: "2026-11-20T20:00:02.000Z",
        };
      },
      cancel: ({ taskId, locals, signal }) => {
        calls.push({ operation: "cancel", taskId, caller: locals.caller, aborted: signal.aborted });
        current = {
          ...WORKING_TASK,
          status: "cancelled",
          statusMessage: "Cancelled by app provider",
        };
      },
    },
  };
}

/** Narrows one complete MCP response result to its method-owned record. */
function resultRecord(response: McpResultResponse): Record<string, unknown> {
  assert.equal(typeof response.result, "object");
  assert.notEqual(response.result, null);
  assert.equal(Array.isArray(response.result), false);
  return response.result as Record<string, unknown>;
}

describe("MCP Tasks provider", () => {
  test("durable readback and input updates enforce caller binding after runtime restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "argsbarg-tasks-"));
    try {
      const file = join(directory, "task.json");
      const taskId = randomUUID();
      const approval = {
        method: "elicitation/create",
        params: {
          message: "Approve?",
          requestedSchema: { type: "object", properties: { approved: { type: "boolean" } } },
        },
      } as const;
      const output = z.strictObject({ approved: z.boolean() });
      /** Opens one fixture runtime whose authorized callbacks read the committed snapshot. */
      function open() {
        /** Authenticates the fixture caller against the task owner. */
        const read = (id: string, caller: string): McpTask => {
          const stored = JSON.parse(readFileSync(file, "utf8")) as { owner: string; task: McpTask };
          if (stored.owner !== caller || stored.task.taskId !== id) throw new McpTaskNotFoundError();
          return stored.task;
        };
        /** Commits one authorized snapshot to the fixture store. */
        const save = (owner: string, task: McpTask): McpTask => {
          writeFileSync(file, JSON.stringify({ owner, task }), { flush: true });
          return task;
        };
        const provider: McpTaskProvider<{ caller: string }> = {
          get: ({ taskId, locals, clientCapabilities, protocolVersion }) => {
            assert.equal(protocolVersion, "2026-07-28");
            assert.ok(Object.isFrozen(clientCapabilities.extensions));
            return read(taskId, locals.caller);
          },
          update: ({ taskId, locals, inputResponses }) => {
            const task = read(taskId, locals.caller);
            if (task.status !== "input_required" || !Object.hasOwn(inputResponses, "approval")) return;
            const response = inputResponses.approval;
            if (!isMcpTaskInputResponse(response, approval) || !("action" in response) || response.action !== "accept") {
              throw new TypeError("Invalid approval response");
            }
            const structuredContent = output.parse(response.content);
            const { inputRequests: _pending, ...settled } = task;
            save(locals.caller, {
              ...settled,
              status: "completed",
              result: { resultType: "complete", content: [], structuredContent },
            });
          },
          cancel: ({ taskId, locals }) => {
            const task = read(taskId, locals.caller);
            if (task.status === "working" || task.status === "input_required") {
              save(locals.caller, { ...WORKING_TASK, taskId, status: "cancelled" });
            }
          },
        };
        const tasks = createMcpTaskRuntime({ provider });
        const registry = createMcpRegistry([
          tool<{ caller: string }>()({
            name: "approval",
            description: "Starts an approval task",
            inputSchema: z.object({}),
            outputSchema: output,
            handler: ({ mcp, locals }) =>
              mcp.tasks.reference(save(locals.caller, {
                ...WORKING_TASK, taskId, status: "input_required", inputRequests: { approval },
              })),
          }),
        ]);
        return { tasks, registry };
      }
      const capabilities = { ...TASK_CAPABILITIES, elicitation: {} };
      const opened = open();
      const created = await dispatchMcpRequest({
        ...opened,
        request: request("create", "tools/call", { name: "approval" }, capabilities),
        base: base(),
        serverInfo: SERVER_INFO,
      });
      assert.ok(created && "result" in created);
      assert.equal(resultRecord(created).taskId, taskId);
      assert.equal(resultRecord(created).status, "input_required");
      assert.equal(Object.hasOwn(resultRecord(created), "inputRequests"), false);

      /** Polls the fixture with the specified current capabilities. */
      const poll = (runtime: ReturnType<typeof createMcpTaskRuntime>, caller = "user-1", declared = capabilities) =>
        runtime.dispatch(request("poll", "tasks/get", { taskId }, declared), base(caller), SERVER_INFO);
      assert.ok("result" in (await poll(opened.tasks)).response);
      const { tasks } = open();
      assert.ok("result" in (await poll(tasks)).response);
      const missing = await tasks.dispatch(request("poll", "tasks/get", { taskId }), base(), SERVER_INFO);
      assert.deepEqual("error" in missing.response && missing.response.error.data, {
        requiredCapabilities: { elicitation: { form: {} } },
      });
      const inputResponses = { approval: { action: "accept", content: { approved: true } } };
      for (const [method, params] of [
        ["tasks/get", { taskId }],
        ["tasks/update", { taskId, inputResponses }],
        ["tasks/cancel", { taskId }],
      ] as const) {
        const denied = await tasks.dispatch(request("denied", method, params), base("other"), SERVER_INFO);
        assert.equal("error" in denied.response && denied.response.error.code, -32_602);
      }
      const badUpdate = await tasks.dispatch(
        request("bad", "tasks/update", { taskId, inputResponses: { approval: { action: "accept", content: { approved: "yes" } } } }),
        base(),
        SERVER_INFO,
      );
      assert.equal("error" in badUpdate.response && badUpdate.response.error.code, -32_603);
      const pending = (await poll(tasks)).response;
      assert.ok("result" in pending);
      assert.equal(resultRecord(pending).status, "input_required");
      const update = await tasks.dispatch(request("update", "tasks/update", { taskId, inputResponses }), base(), SERVER_INFO);
      assert.ok("result" in update.response);
      const cancel = await tasks.dispatch(request("cancel", "tasks/cancel", { taskId }), base(), SERVER_INFO);
      assert.ok("result" in cancel.response);
      const completed = (await poll(tasks)).response;
      assert.ok("result" in completed);
      assert.equal(resultRecord(completed).status, "completed");
      assert.deepEqual(resultRecord(completed).result, {
        resultType: "complete", content: [], structuredContent: { approved: true },
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("dispatches get, update, and cancel with fresh caller locals", async () => {
    const fixture = providerFixture();
    const runtime = createMcpTaskRuntime({ provider: fixture.provider });

    const get = await runtime.dispatch(
      request("get-1", "tasks/get", { taskId: "job-7" }),
      base("user-7"),
      SERVER_INFO,
    );
    assert.ok("result" in get.response, JSON.stringify(get.response));
    assert.equal(resultRecord(get.response as McpResultResponse).resultType, "complete");
    assert.equal(resultRecord(get.response as McpResultResponse).taskId, "job-7");

    const update = await runtime.dispatch(
      request("update-1", "tasks/update", {
        taskId: "job-7",
        inputResponses: { approval: { action: "accept", content: { approved: true } } },
      }),
      base("user-7"),
      SERVER_INFO,
    );
    assert.deepEqual(resultRecord(update.response as McpResultResponse), {
      resultType: "complete",
      _meta: {
        "io.modelcontextprotocol/serverInfo": SERVER_INFO,
      },
    });

    const cancel = await runtime.dispatch(
      request("cancel-1", "tasks/cancel", { taskId: "job-7" }),
      base("user-7"),
      SERVER_INFO,
    );
    assert.equal(cancel.outcome.kind, "ok");
    assert.deepEqual(fixture.calls, [
      { operation: "get", taskId: "job-7", caller: "user-7", aborted: false },
      {
        operation: "update",
        taskId: "job-7",
        inputResponses: { approval: { action: "accept", content: { approved: true } } },
        caller: "user-7",
        aborted: false,
      },
      { operation: "cancel", taskId: "job-7", caller: "user-7", aborted: false },
    ]);
  });

  test("rejects task methods when the client did not opt in", async () => {
    const fixture = providerFixture();
    const runtime = createMcpTaskRuntime({ provider: fixture.provider });
    const response = await runtime.dispatch(
      request("get-2", "tasks/get", { taskId: "job-7" }, {}),
      base(),
      SERVER_INFO,
    );
    assert.equal("error" in response.response, true);
    if ("error" in response.response) {
      assert.equal(response.response.error.code, -32_021);
      assert.deepEqual(response.response.error.data, {
        requiredCapabilities: { extensions: { [MCP_TASKS_EXTENSION]: {} } },
      });
    }
    assert.equal(fixture.calls.length, 0);

    const malformed = await runtime.dispatch(
      request(
        "get-malformed",
        "tasks/get",
        { taskId: "job-7" },
        { extensions: { [MCP_TASKS_EXTENSION]: { unsupported: true } } },
      ),
      base(),
      SERVER_INFO,
    );
    assert.equal("error" in malformed.response, true);
    if ("error" in malformed.response) assert.equal(malformed.response.error.code, -32_021);
    assert.equal(fixture.calls.length, 0);
  });

  test("validates provider task snapshots before returning them", async () => {
    const provider: McpTaskProvider<Locals> = {
      get: () => ({ ...WORKING_TASK, ttlMs: -1 }),
      update: () => undefined,
      cancel: () => undefined,
    };
    const runtime = createMcpTaskRuntime({ provider });
    const response = await runtime.dispatch(
      request("invalid", "tasks/get", { taskId: "job-7" }),
      base(),
      SERVER_INFO,
    );
    assert.equal("error" in response.response, true);
    if ("error" in response.response) assert.equal(response.response.error.code, -32_603);
  });

  test("applies the MCP surface guard before provider dispatch", async () => {
    const fixture = providerFixture();
    const runtime = createMcpTaskRuntime({
      provider: fixture.provider,
      guard: () => false,
    });
    const response = await runtime.dispatch(
      request("denied", "tasks/get", { taskId: "job-7" }),
      base(),
      SERVER_INFO,
    );
    assert.equal(response.outcome.kind, "denied");
    assert.equal("error" in response.response, true);
    assert.equal(fixture.calls.length, 0);
  });

  test("validates completed tool results and task input responses", async () => {
    const invalidResultProvider: McpTaskProvider<Locals> = {
      get: () =>
        ({
          ...WORKING_TASK,
          status: "completed",
          result: { content: [{ type: "text", text: "missing resultType" }] },
        }) as unknown as McpTask,
      update: () => undefined,
      cancel: () => undefined,
    };
    const runtime = createMcpTaskRuntime({ provider: invalidResultProvider });
    const get = await runtime.dispatch(
      request("invalid-result", "tasks/get", { taskId: "job-7" }),
      base(),
      SERVER_INFO,
    );
    assert.equal("error" in get.response, true);
    if ("error" in get.response) assert.equal(get.response.error.code, -32_603);

    const update = await runtime.dispatch(
      request("invalid-input", "tasks/update", {
        taskId: "job-7",
        inputResponses: { approval: { action: 42 } },
      }),
      base(),
      SERVER_INFO,
    );
    assert.equal("error" in update.response, true);
    if ("error" in update.response) assert.equal(update.response.error.code, -32_602);
  });

  test("rejects malformed timestamps, content blocks, and task input payloads", async () => {
    const invalidTaskValues = [
      { ...WORKING_TASK, createdAt: "1" },
      {
        ...WORKING_TASK,
        status: "completed",
        result: {
          resultType: "complete",
          content: [{ type: "text", text: 42 }],
        },
      },
      {
        ...WORKING_TASK,
        status: "input_required",
        inputRequests: { approval: { method: "elicitation/create" } },
      },
    ] as const;
    for (const task of invalidTaskValues) {
      const provider = {
        get: () => task,
        update: () => undefined,
        cancel: () => undefined,
      } as unknown as McpTaskProvider<Locals>;
      const response = await createMcpTaskRuntime({ provider }).dispatch(
        request("invalid-task-payload", "tasks/get", { taskId: "job-7" }),
        base(),
        SERVER_INFO,
      );
      assert.equal("error" in response.response, true);
    }

    const fixture = providerFixture();
    const invalidSamplingResponses = [
      {
        role: "assistant",
        content: 42,
        model: "fixture-model",
      },
      {
        role: "assistant",
        content: { type: "text", text: "done" },
        model: "fixture-model",
        stopReason: 42,
      },
    ] as const;
    for (const sample of invalidSamplingResponses) {
      const update = await createMcpTaskRuntime({ provider: fixture.provider }).dispatch(
        request("invalid-sampling-response", "tasks/update", {
          taskId: "job-7",
          inputResponses: {
            sample,
          },
        }),
        base(),
        SERVER_INFO,
      );
      assert.equal("error" in update.response, true);
      if ("error" in update.response) assert.equal(update.response.error.code, -32_602);
    }
    assert.equal(fixture.calls.length, 0);
  });

  test("preserves valid input-required requests for provider updates", async () => {
    const inputTask: McpTask = {
      ...WORKING_TASK,
      status: "input_required",
      inputRequests: {
        approval: {
          method: "elicitation/create",
          params: {
            message: "Approve export?",
            requestedSchema: {
              type: "object",
              properties: { approved: { type: "boolean" } },
            },
          },
        },
      },
    };
    const provider: McpTaskProvider<Locals> = {
      get: () => inputTask,
      update: ({ inputResponses }) => {
        const approval = inputResponses.approval;
        assert.equal(
          approval !== undefined && "action" in approval ? approval.action : undefined,
          "accept",
        );
      },
      cancel: () => undefined,
    };
    const runtime = createMcpTaskRuntime({ provider });
    const get = await runtime.dispatch(
      request("input-get", "tasks/get", { taskId: "job-7" }, { ...TASK_CAPABILITIES, elicitation: {} }),
      base(),
      SERVER_INFO,
    );
    assert.equal("result" in get.response, true);
    if ("result" in get.response) {
      assert.equal(resultRecord(get.response).status, "input_required");
      assert.deepEqual(resultRecord(get.response).inputRequests, inputTask.inputRequests);
    }
    const update = await runtime.dispatch(
      request("input-update", "tasks/update", {
        taskId: "job-7",
        inputResponses: { approval: { action: "accept", content: { approved: true } } },
      }),
      base(),
      SERVER_INFO,
    );
    assert.equal(update.outcome.kind, "ok");
  });
});

describe("MCP Tasks tool references", () => {
  test("advertises missing capability for a task-only tool and never reuses a prior handle", async () => {
    const { provider } = providerFixture();
    const tasks = createMcpTaskRuntime({ provider });
    let saved: McpTaskReference | undefined;
    let starts = 0;
    const registry = createMcpRegistry([
      tool()({
        name: "task-only",
        description: "Needs task support",
        inputSchema: z.object({}),
        handler: ({ mcp }) => {
          if (!mcp.tasks.available) throw new McpTasksRequiredError();
          if (saved) return saved;
          starts += 1;
          saved = mcp.tasks.reference(WORKING_TASK);
          return saved;
        },
      }),
    ]);
    /** Calls the same tool with a fresh wire request. */
    const invoke = (capabilities: Record<string, unknown>) => dispatchMcpRequest({
      request: request("call", "tools/call", { name: "task-only" }, capabilities),
      base: base(),
      registry,
      tasks,
      serverInfo: SERVER_INFO,
    });
    assert.deepEqual(await invoke({}), {
      jsonrpc: "2.0", id: "call",
      error: { code: -32_021, message: "Missing required client capability", data: { requiredCapabilities: TASK_CAPABILITIES } },
    });
    assert.equal(starts, 0);
    const created = await invoke(TASK_CAPABILITIES);
    assert.ok(created && "result" in created);
    assert.equal(resultRecord(created).resultType, "task");
    const replayed = await invoke(TASK_CAPABILITIES);
    assert.ok(replayed && "result" in replayed);
    assert.equal(resultRecord(replayed).resultType, "complete");
    assert.equal(resultRecord(replayed).isError, true);
  });

  test("returns a task reference only for an opted-in client", async () => {
    const fixture = providerFixture();
    const tasks = createMcpTaskRuntime({ provider: fixture.provider });
    const registration = tool<Locals>()({
      name: "export",
      description: "Export work.",
      inputSchema: z.strictObject({ project: z.string() }),
      handler: ({ inputs, mcp }) =>
        mcp.tasks.available ? mcp.tasks.reference(WORKING_TASK) : { mode: "inline", project: inputs.project },
    });
    const registry = createMcpRegistry([registration]);
    const taskResponse = await dispatchMcpRequest({
      base: base(),
      registry,
      request: request("task-call", "tools/call", {
        name: "export",
        arguments: { project: "alpha" },
      }),
      serverInfo: SERVER_INFO,
      tasks,
    });
    assert.equal("result" in (taskResponse ?? {}), true);
    if (taskResponse !== undefined && "result" in taskResponse) {
      assert.equal(resultRecord(taskResponse).resultType, "task");
      assert.equal(resultRecord(taskResponse).taskId, "job-7");
    }

    const inlineResponse = await dispatchMcpRequest({
      base: base(),
      registry,
      request: request("inline-call", "tools/call", {
        name: "export",
        arguments: { project: "alpha" },
      }, {}),
      serverInfo: SERVER_INFO,
      tasks,
    });
    if (inlineResponse !== undefined && "result" in inlineResponse) {
      assert.equal(resultRecord(inlineResponse).resultType, "complete");
      assert.deepEqual(resultRecord(inlineResponse).structuredContent, { mode: "inline", project: "alpha" });
    }
  });

  test("advertises Tasks only with a configured provider", async () => {
    const fixture = providerFixture();
    const registry = createMcpRegistry([]);
    const discovered = await dispatchMcpRequest({
      base: base(),
      registry,
      request: request("discover", "server/discover", {}),
      serverInfo: SERVER_INFO,
      tasks: createMcpTaskRuntime({ provider: fixture.provider }),
    });
    if (discovered !== undefined && "result" in discovered) {
      const capabilities = resultRecord(discovered).capabilities as Record<string, unknown>;
      const extensions = capabilities.extensions as Record<string, unknown>;
      assert.deepEqual(extensions[MCP_TASKS_EXTENSION], {});
    }

    const withoutProvider = await dispatchMcpRequest({
      base: base(),
      registry,
      request: request("discover-none", "server/discover", {}),
      serverInfo: SERVER_INFO,
    });
    if (withoutProvider !== undefined && "result" in withoutProvider) {
      assert.equal(
        "extensions" in (resultRecord(withoutProvider).capabilities as Record<string, unknown>),
        false,
      );
    }
  });

  test("revalidates branded references after a handler copies and changes one", async () => {
    const fixture = providerFixture();
    const tasks = createMcpTaskRuntime({ provider: fixture.provider });
    const registry = createMcpRegistry([
      tool()({
        name: "mutated-task",
        description: "Mutate a task reference.",
        inputSchema: z.strictObject({}),
        handler: ({ mcp }) => ({
          ...mcp.tasks.reference(WORKING_TASK),
          createdAt: "not-a-timestamp",
        }),
      }),
    ]);
    const response = await dispatchMcpRequest({
      base: base(),
      registry,
      request: request("mutated-task", "tools/call", {
        name: "mutated-task",
        arguments: {},
      }),
      serverInfo: SERVER_INFO,
      tasks,
    });
    if (response !== undefined && "result" in response) {
      assert.equal(resultRecord(response).isError, true);
      assert.equal(
        ((resultRecord(response).structuredContent as Record<string, unknown>).error as Record<
          string,
          unknown
        >).code,
        "SERIALIZATION_ERROR",
      );
    } else {
      assert.fail("Expected an MCP tool validation error");
    }
  });

  test("the app factory forwards Tasks access through registered hook wiring", async () => {
    const fixture = providerFixture();
    let hookCalls = 0;
    const app = argsbarg({
      key: "task-app",
      description: "Task app.",
      version: "1.0.0",
      commands: [],
      hooks: {
        beforeInvoke: () => {
          hookCalls += 1;
        },
      },
      mcp: {
        tools: [
          tool<Locals>()({
            name: "export",
            description: "Export work.",
            inputSchema: z.strictObject({}),
            handler: ({ mcp }) =>
              mcp.tasks.available ? mcp.tasks.reference(WORKING_TASK) : { mode: "inline" },
          }),
        ],
        tasks: fixture.provider,
      },
    });
    const internals = app as unknown as AppTaskInternals;
    assert.notEqual(internals.mcpRegistry, undefined);
    assert.notEqual(internals.mcpTasks, undefined);
    if (internals.mcpRegistry === undefined || internals.mcpTasks === undefined) return;
    const response = await dispatchMcpRequest({
      base: base(),
      registry: internals.mcpRegistry,
      request: request("factory-task", "tools/call", { name: "export", arguments: {} }),
      serverInfo: SERVER_INFO,
      tasks: internals.mcpTasks,
    });
    if (response !== undefined && "result" in response) {
      assert.equal(resultRecord(response).resultType, "task");
      assert.equal(resultRecord(response).taskId, "job-7");
    } else {
      assert.fail("Expected a task result from the app factory registry");
    }
    const followUp = await internals.mcpTasks.dispatch(
      request("factory-get", "tasks/get", { taskId: "job-7" }),
      base(),
      SERVER_INFO,
    );
    assert.equal(followUp.outcome.kind, "ok");
    assert.equal(hookCalls, 2);
  });

  test("routes mounted child task references and follow-ups to the child provider", async () => {
    const parentFixture = providerFixture();
    const childFixture = providerFixture();
    const child = argsbarg({
      key: "child",
      description: "Task child.",
      version: "1.0.0",
      commands: [],
      mcp: {
        tools: [
          tool<Locals>()({
            name: "export",
            description: "Export child work.",
            inputSchema: z.strictObject({}),
            handler: ({ mcp }) =>
              mcp.tasks.available ? mcp.tasks.reference(WORKING_TASK) : { mode: "inline-child" },
          }),
        ],
        tasks: childFixture.provider,
      },
    });
    const parent = argsbarg({
      key: "parent",
      description: "Task parent.",
      version: "1.0.0",
      commands: [],
      children: { child: { app: child } },
      mcp: {
        tools: [],
        tasks: parentFixture.provider,
      },
    });
    const internals = parent as unknown as AppTaskInternals;
    assert.notEqual(internals.mcpRegistry, undefined);
    assert.notEqual(internals.mcpTasks, undefined);
    if (internals.mcpRegistry === undefined || internals.mcpTasks === undefined) return;
    const response = await dispatchMcpRequest({
      base: base(),
      registry: internals.mcpRegistry,
      request: request("child-task", "tools/call", {
        name: "child__export",
        arguments: {},
      }),
      serverInfo: SERVER_INFO,
      tasks: internals.mcpTasks,
    });
    if (response !== undefined && "result" in response) {
      assert.equal(resultRecord(response).resultType, "task");
      assert.equal(resultRecord(response).taskId, "child__job-7");
    } else {
      assert.fail("Expected a namespaced child task result");
    }
    const followUp = await internals.mcpTasks.dispatch(
      request("child-get", "tasks/get", { taskId: "child__job-7" }),
      base("child-user"),
      SERVER_INFO,
    );
    assert.ok("result" in followUp.response);
    if ("result" in followUp.response) {
      assert.equal(resultRecord(followUp.response as McpResultResponse).taskId, "child__job-7");
    }
    assert.deepEqual(childFixture.calls.map(({ operation, taskId, caller }) => ({ operation, taskId, caller })), [
      { operation: "get", taskId: "job-7", caller: "child-user" },
    ]);
    assert.equal(parentFixture.calls.length, 0);
  });

  test("does not fall back to a parent provider when a child has no Tasks provider", async () => {
    const parentFixture = providerFixture();
    const child = argsbarg({
      key: "child",
      description: "Inline child.",
      version: "1.0.0",
      commands: [],
      mcp: {
        tools: [
          tool<Locals>()({
            name: "export",
            description: "Export child work.",
            inputSchema: z.strictObject({}),
            handler: ({ mcp }) =>
              mcp.tasks.available ? mcp.tasks.reference(WORKING_TASK) : { mode: "inline-child" },
          }),
        ],
      },
    });
    const parent = argsbarg({
      key: "parent",
      description: "Task parent.",
      version: "1.0.0",
      commands: [],
      children: { child: { app: child } },
      mcp: { tools: [], tasks: parentFixture.provider },
    });
    const internals = parent as unknown as AppTaskInternals;
    if (internals.mcpRegistry === undefined || internals.mcpTasks === undefined) {
      assert.fail("Expected composed MCP runtime");
    }
    const response = await dispatchMcpRequest({
      base: base(),
      registry: internals.mcpRegistry,
      request: request("inline-child", "tools/call", {
        name: "child__export",
        arguments: {},
      }),
      serverInfo: SERVER_INFO,
      tasks: internals.mcpTasks,
    });
    if (response !== undefined && "result" in response) {
      assert.deepEqual(resultRecord(response).structuredContent, { mode: "inline-child" });
    } else {
      assert.fail("Expected an inline child result");
    }
    assert.equal(parentFixture.calls.length, 0);
  });
});

describe("MCP Tasks transports", () => {
  test("HTTP validates the encoded public task ID and keeps optional push unavailable", async () => {
    const fixture = providerFixture();
    const mount = createMcpHttpMount({
      registry: createMcpRegistry<{ caller: string }>([]),
      serverInfo: SERVER_INFO,
      allowedOrigins: ["https://browser.example"],
      tasks: createMcpTaskRuntime({ routes: [{ prefix: "outer__child", provider: fixture.provider }] }),
      middleware: () => ({ kind: "next", locals: { caller: "http-user" } }),
    });
    /** Makes a real Fetch request to the mount with configurable mirrored headers. */
    const send = (
      method: string, params: Record<string, unknown>, headers: Record<string, string>,
      capabilities: Record<string, unknown> = TASK_CAPABILITIES, version = "2026-07-28",
    ) => mount.handle(new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "Mcp-Method": method, "MCP-Protocol-Version": version, ...headers },
      body: JSON.stringify({
        jsonrpc: "2.0", id: "wire", method, params: {
          ...params,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": version,
            "io.modelcontextprotocol/clientCapabilities": capabilities,
          },
        },
      }),
    }), { signal: new AbortController().signal });
    const taskId = "outer__child__ job-7 📄";
    const matched = await send("tasks/cancel", { taskId }, {
      "Mcp-Name": encodeMcpName(taskId), Origin: "https://browser.example",
    });
    assert.equal(matched.status, 200);
    assert.equal(matched.headers.get("cache-control"), "no-store");
    assert.equal(fixture.calls[0]?.taskId, " job-7 📄");
    const mismatch = await send("tasks/cancel", { taskId }, { "Mcp-Name": "job-7" });
    assert.equal(mismatch.status, 400);
    assert.equal((await mismatch.json()).error.code, -32_020);
    const origin = await send("tasks/cancel", { taskId }, {
      Origin: "https://untrusted.example", "Mcp-Name": encodeMcpName(taskId),
    });
    assert.equal(origin.status, 403);
    assert.equal(fixture.calls.length, 1);
    const version = await send("tools/list", {}, {}, {}, "2025-11-25");
    assert.equal((await version.json()).error.code, -32_022);
    const selector = { notifications: { taskIds: [taskId] } };
    const noCapability = await send("subscriptions/listen", selector, {}, {});
    assert.equal(noCapability.status, 400);
    assert.equal((await noCapability.json()).error.code, -32_021);
    const noPush = await send("subscriptions/listen", selector, {});
    assert.equal(noPush.status, 404);
  });

  test("MCP HTTP rebuilds caller locals for task follow-ups", async () => {
    const fixture = providerFixture();
    const tasks = createMcpTaskRuntime({ provider: fixture.provider });
    const registry = createMcpRegistry<Locals & { readonly caller: string }>([]);
    const mount = createMcpHttpMount({
      registry,
      serverInfo: SERVER_INFO,
      tasks,
      middleware: (_request, context) => ({
        kind: "next",
        locals: { caller: context.headers.get("x-caller") ?? "missing" },
      }),
    });
    const body = {
      jsonrpc: "2.0",
      id: "http-task",
      method: "tasks/get",
      params: {
        taskId: "job-7",
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": TASK_CAPABILITIES,
        },
      },
    };
    const response = await mount.handle(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Mcp-Method": "tasks/get",
          "Mcp-Name": "job-7",
          "MCP-Protocol-Version": "2026-07-28",
          "x-caller": "http-user",
        },
        body: JSON.stringify(body),
      }),
      { signal: new AbortController().signal },
    );
    assert.equal(response.status, 200);
    const json = (await response.json()) as McpResultResponse;
    assert.ok("result" in json, JSON.stringify(json));
    assert.equal(resultRecord(json).resultType, "complete");
    assert.equal(fixture.calls[0]?.caller, "http-user");

    const missingCapability = await mount.handle(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Mcp-Method": "tasks/get",
          "Mcp-Name": "job-7",
          "MCP-Protocol-Version": "2026-07-28",
        },
        body: JSON.stringify({
          ...body,
          id: "http-no-tasks",
          params: {
            ...body.params,
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        }),
      }),
      { signal: new AbortController().signal },
    );
    const missingJson = (await missingCapability.json()) as { readonly error: { readonly code: number } };
    assert.equal(missingCapability.status, 400, JSON.stringify(missingJson));
    assert.equal(missingJson.error.code, -32_021);
  });

  test("MCP HTTP suppresses progress on task follow-ups", async () => {
    const provider: McpTaskProvider<Locals & McpProgressLocals & { readonly caller: string }> = {
      get: ({ locals }) => {
        locals.reportProgress(1, 1, "task-read");
        return WORKING_TASK;
      },
      update: () => undefined,
      cancel: () => undefined,
    };
    const registry = createMcpRegistry<Locals & McpProgressLocals & { readonly caller: string }>([]);
    const mount = createMcpHttpMount({
      registry,
      serverInfo: SERVER_INFO,
      tasks: createMcpTaskRuntime({ provider }),
    });
    const response = await mount.handle(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Mcp-Method": "tasks/get",
          "Mcp-Name": "job-7",
          "MCP-Protocol-Version": "2026-07-28",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "http-progress-task",
          method: "tasks/get",
          params: {
            taskId: "job-7",
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": TASK_CAPABILITIES,
              progressToken: "task-progress",
            },
          },
        }),
      }),
      { signal: new AbortController().signal },
    );
    assert.equal(response.headers.get("content-type"), "application/json");
    assert.equal((await response.json()).result.resultType, "complete");
  });

  for (const transport of ["http", "stdio"] as const) {
    test(`${transport} creates, polls, updates, and cancels a task over the wire`, { timeout: 5_000 }, async () => {
      const fixture = providerFixture();
      const registry = createMcpRegistry([
        tool<Locals & { caller: string }>()({
          name: "start_job",
          description: "Starts a test job.",
          inputSchema: z.strictObject({}),
          handler: ({ mcp }) => mcp.tasks.reference(WORKING_TASK),
        }),
      ]);
      const options = { registry, tasks: createMcpTaskRuntime({ provider: fixture.provider }), serverInfo: SERVER_INFO };
      const mount = createMcpHttpMount({
        ...options,
        middleware: () => ({ kind: "next", locals: { caller: "http-user" } }),
      });
      const input = new PassThrough();
      const output = new PassThrough();
      const serving = transport === "stdio"
        ? serveMcpStdio({ ...options, stdin: input, stdout: output, createSeedLocals: () => ({ caller: "stdio-user" }) })
        : undefined;
      let id = 0;

      /** Sends one request and waits for its matching wire reply before advancing the task. */
      async function send(method: string, name: string, params: Record<string, unknown>) {
        const body = JSON.stringify({
          jsonrpc: "2.0", id: ++id, method, params: {
            ...params,
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": TASK_CAPABILITIES,
              progressToken: id,
            },
          },
        });
        let reply: McpResultResponse;
        if (transport === "http") {
          const response = await mount.handle(new Request("http://localhost/mcp", {
            method: "POST",
            headers: {
              Accept: "application/json, text/event-stream",
              "Content-Type": "application/json",
              "Mcp-Method": method,
              "Mcp-Name": name,
              "MCP-Protocol-Version": "2026-07-28",
            },
            body,
          }), { signal: new AbortController().signal });
          assert.equal(response.status, 200);
          assert.equal(response.headers.get("cache-control"), "no-store");
          reply = await response.json() as McpResultResponse;
        } else {
          const frame = new Promise<Buffer>((resolve) => output.once("data", resolve));
          input.write(`${body}\n`);
          reply = JSON.parse((await frame).toString()) as McpResultResponse;
        }
        assert.ok("result" in reply, JSON.stringify(reply));
        assert.equal(reply.id, id);
        return resultRecord(reply);
      }

      try {
        const created = await send("tools/call", "start_job", { name: "start_job" });
        assert.equal(created.resultType, "task");
        assert.equal(created.taskId, "job-7");
        assert.equal(created.task, undefined);
        const taskId = created.taskId;
        const before = await send("tasks/get", taskId, { taskId });
        assert.equal(before.resultType, "complete");
        assert.equal(before.status, "working");
        assert.equal(before.taskId, taskId);
        assert.equal((await send("tasks/update", taskId, { taskId, inputResponses: {} })).resultType, "complete");
        const after = await send("tasks/get", taskId, { taskId });
        assert.notEqual(after.lastUpdatedAt, before.lastUpdatedAt);
        assert.equal((await send("tasks/cancel", taskId, { taskId })).resultType, "complete");
        const final = await send("tasks/get", taskId, { taskId });
        assert.equal(final.status, "cancelled");
        assert.deepEqual(fixture.calls.map(({ caller }) => caller), Array(5).fill(`${transport}-user`));
      } finally {
        input.end();
        await serving;
      }
    });
  }
});

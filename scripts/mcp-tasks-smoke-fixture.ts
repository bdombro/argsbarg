/*
Runs a synthetic mining job through the built Argsbarg stdio server.
A real host gets timed updates; the local probe advances the job over Node IPC.
*/

import type { McpTask } from "../src/index.ts";
import { EventEmitter, on } from "node:events";
import { z } from "zod";

/** Use the built public entry point without requiring dist during type checking. */
const { argsbarg, McpTaskNotFoundError, tool }: typeof import("../src/index.ts") =
  await import(new URL("../dist/index.js", import.meta.url).href);

/** Stable ID for the one synthetic job this process can start. */
const syntheticTaskId = "synthetic-mining-1";

/** Fan-out for changes after the app has committed them. */
const changes = new EventEmitter();

/** Most recent app-owned snapshot, if the tool has started a job. */
let task: McpTask | undefined;

/** Pending step for a standalone run without the test IPC channel. */
let timer: ReturnType<typeof setTimeout> | undefined;

/** Return the committed snapshot or reject an unknown ID. */
function getTask(id: string): McpTask {
  if (!task || id !== task.taskId) throw new McpTaskNotFoundError();
  return task;
}

/** Store first so polling and subscriptions see the same state. */
function commit(snapshot: McpTask): void {
  task = task === undefined
    ? snapshot
    : { ...snapshot, lastUpdatedAt: new Date(Math.max(Date.now(), Date.parse(task.lastUpdatedAt) + 1)).toISOString() };
  changes.emit("committed", task);
}

/** Move the working task forward by one stage. */
function advanceTask(): void {
  if (task?.status !== "working") return;
  if (task.statusMessage === "Queued") {
    commit({ ...task, statusMessage: "Counted 2 of 3 rows" });
    if (!process.send) timer = setTimeout(advanceTask, 5_000).unref();
  } else {
    commit({
      ...task,
      result: {
        content: [{ type: "text", text: "Counted 3 synthetic rows" }],
        resultType: "complete",
        structuredContent: { rows: 3 },
      },
      status: "completed",
      statusMessage: "Counted all rows",
    });
  }
}

if (process.send) {
  process.on("message", (message) => {
    if (message === "advance") advanceTask();
  });
  process.channel?.unref();
}

/** Expose one harmless tool with no filesystem or network access. */
const app = argsbarg({
  commands: [],
  description: "Synthetic mining fixture",
  key: "mining-smoke",
  mcp: {
    tasks: {
      cancel: ({ taskId }) => {
        const snapshot = getTask(taskId);
        if (snapshot.status !== "working") return;
        clearTimeout(timer);
        commit({ ...snapshot, status: "cancelled", statusMessage: "Cancelled" });
      },
      get: ({ taskId }) => getTask(taskId),
      update: ({ taskId }) => { getTask(taskId); },
      watch: ({ taskId, signal }) => {
        getTask(taskId);
        const updates = on(changes, "committed", { signal });
        return (async function* () {
          for await (const [snapshot] of updates as AsyncIterable<[McpTask]>) {
            yield snapshot;
            if (snapshot.status !== "working") return;
          }
        })();
      },
    },
    tools: [
      tool()({
        description: "Start a disposable job that counts three synthetic rows.",
        handler: ({ mcp }) => {
          if (!mcp.tasks.available) return { tasksAvailable: false };
          if (task) return { alreadyStarted: true };
          const createdAt = new Date().toISOString();
          const queued: McpTask = {
            createdAt,
            lastUpdatedAt: createdAt,
            status: "working",
            statusMessage: "Queued",
            taskId: syntheticTaskId,
            ttlMs: null,
          };
          commit(queued);
          if (!process.send) timer = setTimeout(advanceTask, 3_000).unref();
          return mcp.tasks.reference(queued);
        },
        inputSchema: z.strictObject({}),
        name: "start_synthetic_mining",
      }),
    ],
  },
  version: "1.0.0",
});

await app.run();

/*
Reference AppSpec — builtins on; command registration only.
The version is read from `package.json` at runtime, so the same code runs from
`src/` (`node src/index.ts`) and from the compiled `dist/` (`npx example-api`).
*/

import { readFileSync } from "node:fs";
import { allow, AppError, argsbarg, type Locals, type McpTask, method, route, tool } from "argsbarg";
import { z } from "zod";
import { echoCommand } from "./commands/echo/command.ts";
import { renderJsonCommand, RenderJsonInput } from "./commands/render-json/command.ts";
import { shapeAreaCommand, ShapeAreaInput } from "./commands/shape-area/command.ts";
import { statusCommand, StatusJsonOutput } from "./commands/status/command.ts";
import { WorkspaceNameInput, workspacesCommand } from "./commands/workspaces/command.ts";
import { createIdentity } from "./create-identity.ts";
import { AppDb } from "./db/index.ts";

/** Reads a file from the package root (one level above `src/` or `dist/`). */
function packageFile(
  /** Path relative to the package root. */
  rel: string,
): string {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

/** Package version from `package.json` (bumped by `npm run release`). */
const version = (JSON.parse(packageFile("package.json")) as { version: string }).version;
/** JSON input shared by the REST, RPC and MCP echo declarations. */
const EchoInput = z.strictObject({ message: z.string() });
/** JSON input for single-workspace lookup declarations. */
const WorkspaceIdInput = z.strictObject({ id: z.string() });
/** Generic workspace mutation result. */
const WorkspaceOutput = z.strictObject({ id: z.string(), name: z.string() });
/** Wrapped REST body for the non-object shape union. */
const ShapeBody = z.strictObject({ input: ShapeAreaInput });
/** App-owned in-memory database shared by explicit native declarations. */
const db = AppDb.openDb();
/** Next task identifier used by the app-owned in-memory task demonstration. */
let nextTaskId = 0;
/** App-owned task snapshots keyed by task ID and caller. */
const taskStore = new Map<string, { readonly owner: string; task: McpTask }>();

/** Returns an app-owned task after enforcing caller ownership. */
function requireTask(
  /** Task ID supplied by the MCP client. */
  taskId: string,
  /** Verified caller stored in MCP locals. */
  caller: string,
): { readonly owner: string; task: McpTask } {
  const record = taskStore.get(taskId);
  if (record === undefined || record.owner !== caller) {
    throw new AppError(`Task not found: ${taskId}`, { code: "TASK_NOT_FOUND", httpStatus: 404 });
  }
  return record;
}

/** Returns one workspace or throws the stable not-found domain error. */
function requireWorkspace<T>(
  /** Workspace value returned by the table lookup. */
  value: T | undefined,
  /** Requested workspace id included in a missing-resource error. */
  id: string,
): T {
  if (value !== undefined) return value;
  throw new AppError(`Workspace not found: ${id}`, { code: "WORKSPACE_NOT_FOUND", httpStatus: 404 });
}

/** Full example app with independently declared CLI, REST, JSON-RPC, and MCP surfaces. */
export const app = argsbarg({
  cli: {
    guard: ({ env, source }) =>
      allow({
        caller: source === "local" ? (env.get("EXAMPLE_API_CALLER") ?? "anonymous") : "anonymous",
      }),
  },
  commands: [echoCommand, renderJsonCommand, shapeAreaCommand, statusCommand, workspacesCommand],
  description: createIdentity.desc,
  hooks: {
    beforeInvoke: AppDb.attach,
  },
  http: {
    routes: [
      route()({
        body: EchoInput,
        description: "Echo a message.",
        handler: ({ inputs }) => inputs.message,
        id: "echo",
        method: "POST",
        outputSchema: z.string(),
        path: "/echo",
      }),
      route()({
        body: RenderJsonInput,
        description: "Echo a JSON message.",
        handler: ({ inputs }) => inputs,
        id: "renderJson",
        method: "POST",
        outputSchema: RenderJsonInput,
        path: "/render-json",
      }),
      route()({
        body: ShapeBody,
        description: "Compute a shape area.",
        handler: ({ inputs }) => ({
          area:
            inputs.input.kind === "circle"
              ? Math.PI * inputs.input.radius ** 2
              : inputs.input.width * inputs.input.height,
        }),
        id: "shapeArea",
        method: "POST",
        outputSchema: z.strictObject({ area: z.number() }),
        path: "/shape-area",
      }),
      route()({
        description: "Show app version.",
        handler: () => ({ version }),
        id: "status",
        method: "GET",
        outputSchema: StatusJsonOutput,
        path: "/status",
      }),
      route()({
        description: "List workspaces.",
        handler: () => ({ workspaces: db.workspaces.list() }),
        id: "listWorkspaces",
        method: "GET",
        outputSchema: z.strictObject({ workspaces: z.array(WorkspaceOutput) }),
        path: "/workspaces",
      }),
      route()({
        body: WorkspaceNameInput,
        description: "Create a workspace.",
        handler: ({ inputs }) => db.workspaces.create(inputs.name),
        id: "createWorkspace",
        method: "POST",
        outputSchema: WorkspaceOutput,
        path: "/workspaces",
      }),
      route()({
        description: "Get one workspace.",
        handler: ({ inputs }) => requireWorkspace(db.workspaces.get(inputs.id), inputs.id),
        id: "getWorkspace",
        method: "GET",
        outputSchema: WorkspaceOutput,
        path: "/workspaces/:id",
        pathParams: WorkspaceIdInput,
      }),
      route()({
        body: WorkspaceNameInput,
        description: "Replace a workspace.",
        handler: ({ inputs }) => requireWorkspace(db.workspaces.replace(inputs.id, inputs.name), inputs.id),
        id: "replaceWorkspace",
        method: "PUT",
        outputSchema: WorkspaceOutput,
        path: "/workspaces/:id",
        pathParams: WorkspaceIdInput,
      }),
      route()({
        body: WorkspaceNameInput,
        description: "Patch a workspace.",
        handler: ({ inputs }) => requireWorkspace(db.workspaces.patch(inputs.id, inputs.name), inputs.id),
        id: "patchWorkspace",
        method: "PATCH",
        outputSchema: WorkspaceOutput,
        path: "/workspaces/:id",
        pathParams: WorkspaceIdInput,
      }),
      route()({
        description: "Delete a workspace.",
        handler: ({ inputs }) => {
          if (!db.workspaces.delete(inputs.id)) requireWorkspace(undefined, inputs.id);
          return new Response(null, { status: 204 });
        },
        id: "deleteWorkspace",
        method: "DELETE",
        path: "/workspaces/:id",
        pathParams: WorkspaceIdInput,
        responses: [{ status: 204, description: "Workspace deleted." }],
      }),
    ],
  },
  jsonRpc: {
    methods: [
      method()({ name: "echo", description: "Echo a message.", inputSchema: EchoInput, handler: ({ inputs }) => inputs.message }),
      method()({
        name: "renderJson",
        description: "Echo a JSON message.",
        inputSchema: RenderJsonInput,
        handler: ({ inputs }) => inputs,
      }),
      method()({
        name: "shapeArea",
        description: "Compute a shape area.",
        inputSchema: ShapeBody,
        handler: ({ inputs }) => ({
          area:
            inputs.input.kind === "circle"
              ? Math.PI * inputs.input.radius ** 2
              : inputs.input.width * inputs.input.height,
        }),
      }),
      method()({
        name: "status",
        description: "Show app version.",
        inputSchema: z.strictObject({}),
        outputSchema: StatusJsonOutput,
        handler: () => ({ version }),
      }),
    ],
  },
  key: createIdentity.key,
  mcp: {
    guard: ({ env, locals, source }) =>
      allow({
        caller:
          locals.caller ??
          (source === "local" ? (env.get("EXAMPLE_API_CALLER") ?? "anonymous") : "anonymous"),
      }),
    http: {
      middleware: (_request, { headers }) => ({
        kind: "next",
        locals: {
          caller: headers.get("X-Example-Api-Caller") ?? "anonymous",
          db,
        },
      }),
    },
    tools: [
      tool<Locals>()({ name: "echo", description: "Echo a message.", inputSchema: EchoInput, handler: ({ inputs }) => inputs.message }),
      tool<Locals>()({ name: "renderJson", description: "Echo a JSON message.", inputSchema: RenderJsonInput, handler: ({ inputs }) => inputs }),
      tool<Locals>()({
        name: "shapeArea",
        description: "Compute a shape area.",
        inputSchema: ShapeAreaInput,
        handler: ({ inputs }) => ({
          area:
            inputs.kind === "circle" ? Math.PI * inputs.radius ** 2 : inputs.width * inputs.height,
        }),
      }),
      tool<Locals>()({
        name: "status",
        description: "Show app version.",
        inputSchema: z.strictObject({}),
        outputSchema: StatusJsonOutput,
        handler: () => ({ version }),
      }),
      tool<Locals>()({
        name: "workspaces",
        description: "List workspaces.",
        inputSchema: z.strictObject({}),
        handler: () => ({ workspaces: db.workspaces.list() }),
      }),
      tool<Locals>()({
        name: "taskProbe",
        description: "Demonstrate an app-owned MCP task.",
        inputSchema: z.strictObject({ label: z.string() }),
        handler: ({ inputs, locals, mcp }) => {
          if (!mcp.tasks.available) return { label: inputs.label, mode: "inline" };
          const taskId = `example-api-${++nextTaskId}`;
          const createdAt = new Date().toISOString();
          taskStore.set(taskId, {
            owner: locals.caller ?? "anonymous",
            task: {
              taskId,
              status: "working",
              statusMessage: "Queued by the example app",
              createdAt,
              lastUpdatedAt: createdAt,
              ttlMs: 60_000,
              pollIntervalMs: 100,
            },
          });
          const timer = setTimeout(() => {
            const record = taskStore.get(taskId);
            if (record === undefined || record.task.status !== "working") return;
            record.task = {
              ...record.task,
              status: "completed",
              statusMessage: "Completed by the example app",
              lastUpdatedAt: new Date().toISOString(),
              result: {
                resultType: "complete",
                content: [{ type: "text", text: `completed ${inputs.label}` }],
                isError: false,
                structuredContent: { label: inputs.label },
              },
            };
          }, 25);
          timer.unref();
          const task = taskStore.get(taskId)?.task;
          if (task === undefined) throw new Error("Task disappeared before publication");
          return mcp.tasks.reference(task);
        },
      }),
    ],
    tasks: {
      get: ({ taskId, locals }) => requireTask(taskId, locals.caller ?? "anonymous").task,
      update: ({ taskId, locals }) => {
        const task = requireTask(taskId, locals.caller ?? "anonymous").task;
        if (task.status !== "input_required") {
          throw new AppError("Task is not waiting for input", { code: "TASK_INPUT_NOT_REQUIRED" });
        }
      },
      cancel: ({ taskId, locals }) => {
        const record = requireTask(taskId, locals.caller ?? "anonymous");
        if (record.task.status === "working" || record.task.status === "input_required") {
          record.task = {
            ...record.task,
            status: "cancelled",
            statusMessage: "Cancelled by caller",
            lastUpdatedAt: new Date().toISOString(),
          };
        }
      },
    },
  },
  version,
});

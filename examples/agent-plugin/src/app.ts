/*
Reference AppSpec — builtins on; command registration only.
The version is read from `package.json` at runtime, so the same code runs from
`src/` (`node src/index.ts`) and from the committed bundle (`dist/example-agent-plugin.mjs`).
*/

import { readFileSync } from "node:fs";
import {
  AppError,
  allow,
  argsbarg,
  deny,
  type Locals,
  type McpHttpMiddleware,
  method,
  route,
  tool,
} from "argsbarg";
import { z } from "zod";
import { echoCommand } from "./commands/echo/command.ts";
import { renderJsonCommand, RenderJsonInput } from "./commands/render-json/command.ts";
import { statusCommand, StatusJsonOutput } from "./commands/status/command.ts";
import { WorkspaceNameInput, workspacesCommand } from "./commands/workspaces/command.ts";
import { createIdentity } from "./create-identity.ts";
import { AppDb } from "./db/index.ts";

/** Reads a file from the plugin root (one level above `src/` or `dist/`). */
function packageFile(
  /** Path relative to the plugin root. */
  rel: string,
): string {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

/** Plugin version from `package.json` (bumped with the manifests by `npm run release`). */
const version = (JSON.parse(packageFile("package.json")) as { version: string }).version;
/** Echo input shared by all native surfaces. */
const EchoInput = z.strictObject({ message: z.string() });
/** One workspace identifier for explicit declarations. */
const WorkspaceIdInput = z.strictObject({ id: z.string() });
/** Generic workspace mutation result. */
const WorkspaceOutput = z.strictObject({ id: z.string(), name: z.string() });
const db = AppDb.openDb();
/** Optional app-owned credential that protects every MCP entry point when configured. */
const mcpToken = process.env.EXAMPLE_AGENT_PLUGIN_TOKEN;

/** Returns a workspace or emits the stable domain error. */
function requireWorkspace<T>(value: T | undefined, id: string): T {
  if (value !== undefined) return value;
  throw new AppError(`Workspace not found: ${id}`, { code: "WORKSPACE_NOT_FOUND", httpStatus: 404 });
}

/** Establishes an HTTP caller before MCP discovery or tool dispatch. */
const mcpHttpMiddleware: McpHttpMiddleware<Locals> = (_request, { headers }) => {
  if (mcpToken === undefined) return { kind: "next", locals: { db } };
  if (headers.get("Authorization") !== `Bearer ${mcpToken}`) {
    return {
      kind: "respond",
      response: new Response(null, {
        status: 401,
        headers: { "WWW-Authenticate": "Bearer" },
      }),
    };
  }
  return { kind: "next", locals: { caller: "http", db } };
};

export const app = argsbarg({
  commands: [echoCommand, renderJsonCommand, statusCommand, workspacesCommand],
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
    guard: (ctx) => {
      if (mcpToken === undefined) return allow();
      if (ctx.source === "http") {
        return ctx.locals.caller === "http"
          ? allow()
          : deny({
              code: "AUTH_REQUIRED",
              message: "A valid MCP bearer token is required.",
              challenge: { scheme: "bearer" },
            });
      }
      return ctx.env.get("EXAMPLE_AGENT_PLUGIN_TOKEN") === mcpToken
        ? allow({ caller: "local" })
        : deny({ code: "AUTH_REQUIRED", message: "A valid MCP token is required." });
    },
    http: { middleware: mcpHttpMiddleware },
    mcpd: true,
    claudePlugin: true,
    cursorPlugin: true,
    tools: [
      tool<Locals>()({
        name: "echo",
        description: "Echo a message.",
        inputSchema: EchoInput,
        handler: ({ inputs }) => inputs.message,
      }),
      tool<Locals>()({
        name: "renderJson",
        description: "Echo a JSON message.",
        inputSchema: RenderJsonInput,
        handler: ({ inputs }) => inputs,
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
    ],
  },
  version,
});

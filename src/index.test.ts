/*
Compile-time coverage for accepted public D90 and D91 authoring types.
The package root must expose the exact declarations without requiring consumers to import internals.
*/

import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import * as publicApi from "./index.ts";
import {
  argsbarg,
  allow,
  type ChildAppMount,
  type ChildSurface,
  type CliAppConfig,
  command,
  type McpHttpConfig,
  type McpHttpMiddleware,
  type McpHttpMiddlewareContext,
  type McpHttpMiddlewareResult,
  type McpTask,
  type McpTaskProvider,
  type McpToolSpec,
  tool,
} from "./index.ts";

test("package root covers symbols imported by authoritative docs", () => {
  for (const symbol of [
    "argsbarg",
    "command",
    "method",
    "route",
    "tool",
    "allow",
    "deny",
    "createErrorReporter",
    "OptionKind",
  ]) {
    assert.notEqual(publicApi[symbol as keyof typeof publicApi], undefined, `${symbol} must be public`);
  }
});

test("package root exports D90 guard and middleware types", () => {
  const cli: CliAppConfig<{ readonly caller?: string }> = {
    guard: ({ locals }) => (locals.caller === undefined ? false : allow()),
  };
  const middleware: McpHttpMiddleware<{ readonly caller: string }> = (request, context) =>
    request.headers.has("authorization")
      ? { kind: "next", locals: { caller: context.headers.get("authorization") ?? "" } }
      : { kind: "respond", response: new Response(null, { status: 401 }) };
  const context: McpHttpMiddlewareContext = {
    method: "tools/call",
    name: "report",
    headers: { get: (name) => (name.toLowerCase() === "authorization" ? "Bearer token" : undefined) },
  };
  const result: McpHttpMiddlewareResult<{ readonly caller: string }> = {
    kind: "next",
    locals: { caller: "operator" },
  };
  const http: McpHttpConfig<{ readonly caller: string }> = { middleware };
  const inputSchema = z.strictObject({ value: z.string() });
  const spec: McpToolSpec<{ readonly caller: string }, typeof inputSchema, string> = {
    name: "report",
    description: "Report a value.",
    inputSchema,
    guard: () => allow(),
    handler: ({ inputs, locals }) => `${locals.caller}:${inputs.value}`,
  };

  assert.equal(typeof cli.guard, "function");
  assert.equal(http.middleware, middleware);
  assert.equal(context.name, "report");
  assert.equal(result.kind, "next");
  assert.equal(tool<{ readonly caller: string }>()(spec).name, "report");
});

test("package root exports MCP Tasks provider and handler types", () => {
  const task: McpTask = {
    taskId: "report-1",
    status: "working",
    createdAt: "2026-11-20T20:00:00.000Z",
    lastUpdatedAt: "2026-11-20T20:00:00.000Z",
    ttlMs: 60_000,
  };
  const provider: McpTaskProvider<{ readonly caller: string }> = {
    get: ({ taskId, locals }) =>
      locals.caller.length > 0 ? task : { ...task, taskId },
    update: () => undefined,
    cancel: () => undefined,
  };
  const inputSchema = z.strictObject({});
  const spec: McpToolSpec<{ readonly caller: string }, typeof inputSchema, string> = {
    name: "report_task",
    description: "Start a report task.",
    inputSchema,
    outputSchema: z.string(),
    handler: ({ locals, mcp }) => (mcp.tasks.available ? mcp.tasks.reference(task) : locals.caller),
  };

  assert.equal(typeof provider.get, "function");
  assert.equal(tool<{ readonly caller: string }>()(spec).name, "report_task");
});

test("package root exports D91 child composition types", () => {
  const child = argsbarg({
    key: "reports",
    description: "Reports.",
    version: "1.0.0",
    handler: () => "ok",
  });
  const surface: ChildSurface = "cli";
  const mount: ChildAppMount = { app: child, expose: [surface] };
  const parent = argsbarg({
    key: "suite",
    description: "Suite.",
    version: "1.0.0",
    commands: [command({ key: "status", description: "Status.", handler: () => "ok" })],
    children: { reports: mount },
  });

  assert.deepEqual(mount.expose, ["cli"]);
  assert.equal(typeof parent.invoke, "function");
});

test("package root excludes compiled declaration and registry internals", () => {
  for (const internal of [
    "compileGuardPlan",
    "createHttpCatalog",
    "generateOpenApi",
    "openApiJson",
    "isJsonRpcMethod",
    "generateOpenRpc",
    "createMcpRegistry",
    "registerMcpTool",
  ]) {
    assert.equal(internal in publicApi, false, `${internal} must remain package-internal`);
  }
});

type InternalPublicTypes = [
  // @ts-expect-error Bound declarations are compiled package internals.
  import("./index.ts")["BoundDeclaration"],
  // @ts-expect-error Compiled guard plans are package internals.
  import("./index.ts")["CompiledGuard"],
  // @ts-expect-error Invocation outcomes are adapter internals.
  import("./index.ts")["InvocationOutcome"],
  // @ts-expect-error REST catalogs are adapter internals.
  import("./index.ts")["HttpRouteCatalog"],
  // @ts-expect-error Registered REST routes are adapter internals.
  import("./index.ts")["RegisteredHttpRoute"],
  // @ts-expect-error JSON-RPC catalog metadata is package-internal.
  import("./index.ts")["JsonRpcMethodMetadata"],
  // @ts-expect-error MCP registries are package internals.
  import("./index.ts")["McpRegistry"],
  // @ts-expect-error Registered MCP tools are package internals.
  import("./index.ts")["McpRegisteredTool"],
  // @ts-expect-error MCP declaration entries are package internals.
  import("./index.ts")["McpToolEntry"],
  // @ts-expect-error MCP registrations expose internal invocation closures.
  import("./index.ts")["McpToolRegistration"],
];

void (undefined as unknown as InternalPublicTypes);

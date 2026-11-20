/*
Focused tests for immutable MCP catalog registration and lookup.
They verify discovery/list/dispatch share one caller-independent snapshot.
*/

import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { allow, type BoundDeclaration } from "../core/invocation.ts";
import { compileGuardPlan } from "../runtime/invoke.ts";
import { createMcpRegistry, registerMcpTool, tool } from "./registry.ts";

/** Creates one typed entry with a fixed native declaration. */
function entry(name: string) {
  const inputSchema = z.strictObject({ value: z.string() });
  type Input = z.output<typeof inputSchema>;
  type Locals = Record<never, never>;
  const declaration: BoundDeclaration<typeof inputSchema, { value: string }, Locals> = {
    inputSchema,
    guardPlan: compileGuardPlan<Input, Locals>()({}),
    handler: ({ inputs }) => ({ value: inputs.value }),
  };
  return registerMcpTool({
    name,
    description: `${name} description`,
    inputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    declaration,
  });
}

test("registry fixes exact names, immutable views, and deterministic list/lookup parity", () => {
  const mutableInput = entry("echo");
  const inputSchema = {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  };
  const annotations = { readOnlyHint: true };
  const echo = { ...mutableInput, inputSchema, annotations };
  const alpha = entry("alpha");
  const registry = createMcpRegistry([echo, alpha]);
  const oppositeOrder = createMcpRegistry([alpha, echo]);
  const initialJson = JSON.stringify(registry.list());

  (inputSchema.properties.value as { type: string }).type = "number";
  annotations.readOnlyHint = false;
  assert.equal(JSON.stringify(registry.list()), initialJson);
  assert.deepEqual(
    registry.list().map((tool) => tool.name),
    ["alpha", "echo"],
  );
  assert.equal(typeof registry.lookup("echo")?.invoke, "function");
  assert.equal(registry.lookup("Echo"), undefined);
  assert.equal(Object.isFrozen(registry.list()), true);
  assert.equal(Object.isFrozen(registry.lookup("echo")?.inputSchema), true);
  assert.deepEqual(Object.keys(registry.list()[1] ?? {}), ["name", "description", "inputSchema", "annotations"]);
  assert.equal(JSON.stringify(registry.list()).includes("caller"), false);
  assert.equal(JSON.stringify(oppositeOrder.list()), initialJson, "insertion order must not affect discovery bytes");
});

test("registry rejects duplicate and empty names before serving", () => {
  assert.throws(() => createMcpRegistry([entry("echo"), entry("echo")]), /Duplicate MCP tool name: echo/);
  assert.throws(() => createMcpRegistry([entry("")]), /must not be empty/);
  const plain = entry("plain");
  const { withSurfaceGuard: _withSurfaceGuard, ...withoutComposition } = plain;
  assert.throws(
    () => createMcpRegistry([withoutComposition], { guard: () => false }),
    /cannot compose the configured surface guard/,
  );
});

test("registry compiles MCP surface and operation guards in supplement, override, and public order", async () => {
  type Seed = { readonly requestId: string; readonly caller?: string };
  const events: string[] = [];
  const registrations = [
    tool<Seed>()({
      name: "supplement",
      description: "Supplement.",
      inputSchema: z.strictObject({ value: z.string() }),
      guard: ({ locals }) => {
        events.push(`operation:${String(locals.caller)}`);
        return allow({ scope: "write" as const });
      },
      handler: ({ locals }) => {
        events.push(`handler:${locals.scope}`);
        return { caller: locals.caller, scope: locals.scope };
      },
    }),
    tool<Seed>()({
      name: "override",
      description: "Override.",
      inputSchema: z.strictObject({ value: z.string() }),
      guard: {
        mode: "override",
        run: ({ locals }) => {
          events.push(`override:${String(locals.caller)}`);
          return allow({ scope: "override" as const });
        },
      },
      handler: ({ locals }) => locals.scope,
    }),
    tool<Seed>()({
      name: "public",
      description: "Public.",
      inputSchema: z.strictObject({ value: z.string() }),
      guard: "public",
      handler: ({ locals }) => {
        events.push(`handler:public-${String(locals.caller)}`);
        return String(locals.caller);
      },
    }),
  ];
  const registry = createMcpRegistry(registrations, {
    guard: ({ locals, source }) => {
      assert.equal(source, "local");
      events.push(`surface:${locals.requestId}`);
      return allow({ caller: "Ada" as const });
    },
  });
  const base = {
    locals: { requestId: "request-1" },
    signal: new AbortController().signal,
    surface: "mcp" as const,
    source: "local" as const,
    env: { get: () => undefined },
  };

  for (const name of ["supplement", "override", "public"]) {
    const outcome = await registry.lookup(name)?.invoke({ value: name }, base);
    assert.equal(outcome?.kind, "ok");
  }
  assert.deepEqual(events, [
    "surface:request-1",
    "operation:Ada",
    "handler:write",
    "override:undefined",
    "handler:public-undefined",
  ]);
});

test("registry composes the MCP surface guard for raw registrations", async () => {
  const events: string[] = [];
  const inputSchema = z.strictObject({ value: z.string() });
  const supplement = registerMcpTool({
    name: "raw-supplement",
    description: "Raw supplement registration.",
    inputSchema: { type: "object" },
    declaration: {
      inputSchema,
      guardPlan: compileGuardPlan<{ value: string }, { requestId: string; caller?: string }>()({
        surface: () => {
          events.push("stale-surface");
          return false;
        },
        operation: ({ locals }) => {
          events.push(`operation:${locals.caller}`);
          return allow({ operation: true as const });
        },
      }),
      handler: ({ inputs, locals }: {
        readonly inputs: { value: string };
        readonly locals: { requestId: string; caller?: string; operation?: boolean };
      }) => {
        events.push(`handler:${inputs.value}`);
        return { value: inputs.value, caller: locals.caller, operation: locals.operation };
      },
    },
  });
  const override = registerMcpTool({
    name: "raw-override",
    description: "Raw override registration.",
    inputSchema: { type: "object" },
    declaration: {
      inputSchema,
      guardPlan: compileGuardPlan<{ value: string }, { requestId: string }>()({
        surface: () => false,
        operation: {
          mode: "override",
          run: () => {
            events.push("override");
            return allow();
          },
        },
      }),
      handler: () => {
        events.push("override-handler");
        return "override";
      },
    },
  });
  const publicRegistration = registerMcpTool({
    name: "raw-public",
    description: "Raw public registration.",
    inputSchema: { type: "object" },
    declaration: {
      inputSchema,
      guardPlan: compileGuardPlan<{ value: string }, { requestId: string }>()({
        surface: () => false,
        operation: "public",
      }),
      handler: () => {
        events.push("public-handler");
        return "public";
      },
    },
  });
  const registry = createMcpRegistry([supplement, override, publicRegistration], {
    guard: ({ locals }) => {
      events.push(`surface:${locals.requestId}`);
      return allow({ caller: "Ada" as const });
    },
  });
  const base = {
    locals: { requestId: "raw-request" },
    signal: new AbortController().signal,
    surface: "mcp" as const,
    source: "local" as const,
    env: { get: () => undefined },
  };
  const outcome = await registry.lookup("raw-supplement")?.invoke(
    { value: "ok" },
    base,
  );
  assert.equal((await registry.lookup("raw-override")?.invoke({ value: "ok" }, base))?.kind, "ok");
  assert.equal((await registry.lookup("raw-public")?.invoke({ value: "ok" }, base))?.kind, "ok");

  assert.deepEqual(events, [
    "surface:raw-request",
    "operation:Ada",
    "handler:ok",
    "override",
    "override-handler",
    "public-handler",
  ]);
  assert.equal(outcome?.kind, "ok");
  if (outcome?.kind === "ok") {
    assert.deepEqual(outcome.result, { value: "ok", caller: "Ada", operation: true });
  }
});

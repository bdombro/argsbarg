/*
Factory-level tests for generated REST, JSON-RPC, and MCP local and relay commands.
They prove exact selectors, explicit relays, native presentation, and no local fallback.
*/

import assert from "node:assert/strict";
import test from "node:test";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { allow } from "../core/invocation.ts";
import { command } from "../core/types.ts";
import { route } from "../http/routes.ts";
import { method } from "../json-rpc/declaration.ts";
import { createMcpRegistry, registerMcpTool } from "../mcp/registry.ts";
import { tool } from "../mcp/registry.ts";
import { argsbarg } from "../runtime/cli.ts";
import { compileGuardPlan } from "../runtime/invoke.ts";
import type { HttpMount } from "../server/listener.ts";

test("factory registers native REST, RPC, and MCP generated commands with local parity", async () => {
  const input = z.strictObject({ value: z.string() });
  const rest = route()({
    id: "echoRest",
    method: "POST",
    path: "/echo",
    description: "Echo.",
    body: input,
    outputSchema: input,
    handler: ({ inputs }) => inputs,
  });
  const rpc = method()({
    name: "echoRpc",
    description: "Echo.",
    inputSchema: input,
    handler: ({ inputs }) => inputs,
  });
  const mcpDeclaration = {
    inputSchema: input,
    guardPlan: compileGuardPlan<z.output<typeof input>, object>()({}),
    handler: ({ inputs }: { readonly inputs: z.output<typeof input> }) => inputs,
  };
  const tool = registerMcpTool({
    name: "echoMcp",
    description: "Echo.",
    inputSchema: { type: "object" },
    declaration: mcpDeclaration,
  } as Parameters<typeof registerMcpTool>[0]);
  assert.equal(createMcpRegistry([tool]).lookup("echoMcp")?.name, "echoMcp");

  const app = argsbarg({
    key: "factory",
    version: "1.0.0",
    description: "Factory.",
    commands: [],
    http: { routes: [rest] },
    jsonRpc: { methods: [rpc] },
    mcp: { tools: [tool] },
  });

  const restResult = await app.invoke(["api", "post", "/api/echo"], {
    stdin: '{"value":"rest"}',
  });
  const rpcResult = await app.invoke(["rpc", "echoRpc"], { stdin: '{"value":"rpc"}' });
  const mcpResult = await app.invoke(["mcp", "call", "echoMcp"], { stdin: '{"value":"mcp"}' });
  assert.equal(restResult.exitCode, 0);
  assert.deepEqual(JSON.parse(restResult.stdout), { value: "rest" });
  assert.equal(rpcResult.stdout, '{"value":"rpc"}\n');
  assert.equal(JSON.parse(mcpResult.stdout).structuredContent.value, "mcp");

  const yamlRest = await app.invoke(["api", "POST", "/api/echo", "--yaml"], { stdin: "value: rest" });
  const yamlRpc = await app.invoke(["rpc", "echoRpc", "--yaml"], { stdin: "value: rpc" });
  const yamlMcp = await app.invoke(["mcp", "call", "echoMcp", "--yaml"], { stdin: "value: mcp" });
  assert.equal(yamlRest.exitCode, 0);
  assert.deepEqual(parseYaml(yamlRest.stdout), { value: "rest" });
  assert.equal(yamlRpc.exitCode, 0);
  assert.deepEqual(parseYaml(yamlRpc.stdout), { value: "rpc" });
  assert.equal(yamlMcp.exitCode, 0);
  assert.equal(parseYaml(yamlMcp.stdout).structuredContent.value, "mcp");
  const malformed = await app.invoke(["api", "POST", "/api/echo", "--yaml"], { stdin: "value: [" });
  assert.equal(malformed.exitCode, 1);
  assert.match(malformed.stderr, /^INVALID_YAML:/);

  const yamlRelay = await app.invoke(["api", "POST", "/api/echo", "--yaml", "--relay", "https://relay.example"], {
    stdin: "value: relay",
    fetch: async (_url, init) => {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("accept"), "application/yaml");
      assert.equal(headers.get("content-type"), "application/yaml; charset=utf-8");
      assert.deepEqual(parseYaml(String(init?.body)), { value: "relay" });
      return new Response("value: remote\n", { headers: { "content-type": "application/yaml" } });
    },
  });
  assert.equal(yamlRelay.exitCode, 0);
  assert.equal(yamlRelay.stdout, "value: remote\n");

  const help = await app.invoke(["--help"]);
  assert.match(help.stdout, /\n {2}api\s/);
  assert.match(help.stdout, /\n {2}rpc\s/);
  assert.match(help.stdout, /\n {2}mcp\s/);

  const optionChild = argsbarg({
    key: "options-child",
    version: "1.0.0",
    description: "Options child.",
    options: [
      {
        name: "tenant",
        description: "Tenant.",
        kind: "string",
        required: true,
      },
    ],
    commands: [
      command({
        key: "show",
        description: "Show.",
        handler: ({ inputs }) => String((inputs as { readonly tenant?: string }).tenant),
      }),
    ],
  });
  const optionParent = argsbarg({
    key: "options-parent",
    version: "1.0.0",
    description: "Options parent.",
    commands: [],
    children: { mounted: { app: optionChild, expose: ["cli"] } },
  });
  const optionResult = await optionParent.invoke(["mounted", "--tenant", "acme", "show"]);
  assert.equal(optionResult.stdout, "acme\n", optionResult.stderr);
  assert.match((await optionParent.invoke(["mounted", "--help"])).stdout, /--tenant/);

  const policyChild = argsbarg({
    key: "policy-child",
    version: "1.0.0",
    description: "Policy child.",
    commands: [],
    http: {
      routes: [
        route()({
          id: "fail",
          method: "GET",
          path: "/fail",
          description: "Fail.",
          outputSchema: z.object({ ok: z.boolean() }),
          handler: () => {
            throw new Error("child REST failure");
          },
        }),
      ],
    },
    jsonRpc: {
      methods: [
        method()({
          name: "fail",
          description: "Fail.",
          inputSchema: z.strictObject({}),
          handler: () => {
            throw new Error("child RPC failure");
          },
        }),
      ],
    },
  });
  const parentHooks: string[] = [];
  let parentReports = 0;
  const policyParent = argsbarg({
    key: "policy-parent",
    version: "1.0.0",
    description: "Policy parent.",
    commands: [],
    children: { mounted: { app: policyChild } },
    hooks: {
      beforeInvoke: (context) => { parentHooks.push(`before:${context.path.join(":")}`); },
      onError: (context) => { parentHooks.push(`error:${context.path.join(":")}`); },
    },
    errorReporter: {
      async reportError() { parentReports += 1; },
      async reportMessage() {},
    },
  });
  const childRest = await policyParent.invoke(["api", "GET", "/api/mounted/fail"]);
  const childRpc = await policyParent.invoke(["rpc", "mounted.fail"], { stdin: "{}" });
  assert.equal(childRest.exitCode, 1);
  assert.equal(childRpc.exitCode, 1);
  assert.deepEqual(parentHooks, []);
  assert.equal(parentReports, 0);
});

test("CLI surface and command guards compose once while generated mirrors keep target policy", async () => {
  const previous = process.env.ARGS_BARG_GUARD_CALLER;
  process.env.ARGS_BARG_GUARD_CALLER = "Ada";
  const events: string[] = [];
  const supplement = command({
    key: "supplement",
    description: "Supplement.",
    guard: (ctx) => {
      assert.equal(ctx.source, "local");
      assert.equal(ctx.surface, "cli");
      events.push("operation:supplement");
      return allow({ operationCaller: "supplement" as const });
    },
    handler: ({ locals }) => {
      events.push("handler:supplement");
      return `${String((locals as { readonly surfaceCaller?: string }).surfaceCaller)}:${locals.operationCaller}`;
    },
  });
  const override = command({
    key: "override",
    description: "Override.",
    guard: {
      mode: "override",
      run: (ctx) => {
        assert.equal(ctx.source, "local");
        events.push("operation:override");
        return allow({ operationCaller: "override" as const });
      },
    },
    handler: ({ locals }) => {
      events.push("handler:override");
      return locals.operationCaller;
    },
  });
  const publicCommand = command({
    key: "public",
    description: "Public.",
    guard: "public",
    handler: () => {
      events.push("handler:public");
      return "public";
    },
  });
  const rpc = method()({
    name: "guardTarget",
    description: "Generated target.",
    inputSchema: z.strictObject({}),
    handler: () => {
      events.push("handler:rpc");
      return "rpc";
    },
  });
  try {
    const app = argsbarg({
      key: "guards",
      version: "1.0.0",
      description: "Guards.",
      commands: [supplement, override, publicCommand],
      cli: {
        guard: (ctx) => {
          assert.equal(ctx.source, "local");
          if (ctx.source !== "local") throw new TypeError("CLI guard did not receive the local source");
          events.push("surface");
          return allow({ surfaceCaller: ctx.env.get("ARGS_BARG_GUARD_CALLER") });
        },
      },
      jsonRpc: { methods: [rpc] },
    });

    assert.equal((await app.invoke(["supplement"])).stdout, "Ada:supplement\n");
    assert.deepEqual(events.splice(0), ["surface", "operation:supplement", "handler:supplement"]);
    assert.equal((await app.invoke(["override"])).stdout, "override\n");
    assert.deepEqual(events.splice(0), ["operation:override", "handler:override"]);
    assert.equal((await app.invoke(["public"])).stdout, "public\n");
    assert.deepEqual(events.splice(0), ["handler:public"]);
    assert.equal((await app.invoke(["rpc", "guardTarget"], { stdin: "{}" })).stdout, '"rpc"\n');
    assert.deepEqual(events.splice(0), ["handler:rpc"]);
  } finally {
    if (previous === undefined) delete process.env.ARGS_BARG_GUARD_CALLER;
    else process.env.ARGS_BARG_GUARD_CALLER = previous;
  }
});

test("composed child declarations keep child policy, scoped sources, hooks, and exact generated names", async () => {
  const previous = process.env.MOUNTED_TOKEN;
  process.env.MOUNTED_TOKEN = "scoped";
  const events: string[] = [];
  let parentGuards = 0;
  let childGuards = 0;
  let childCalls = 0;
  const childHooks = {
    beforeInvoke: (context: { readonly path: readonly string[] }) => {
      events.push(`before:${context.path.join(":")}`);
    },
  };
  const child = argsbarg({
    key: "ignored-child-key",
    version: "1.0.0",
    description: "Child.",
    commands: [
      command({
        key: "token",
        description: "Read the scoped token.",
        handler: (context) => {
          childCalls += 1;
          assert.equal(context.source, "local");
          if (context.source !== "local") throw new TypeError("Expected local child source");
          assert.equal(context.env.get("TOKEN"), "scoped");
          return "token";
        },
      }),
    ],
    cli: {
      guard: (context) => {
        childGuards += 1;
        assert.equal(context.source, "local");
        if (context.source !== "local") throw new TypeError("Expected local source");
        assert.equal(context.env.get("TOKEN"), "scoped");
        assert.equal(context.env.get("IGNORED_CHILD_KEY_TOKEN"), undefined);
        return true;
      },
    },
    hooks: childHooks,
    http: {
      guard: (context) => {
        childGuards += 1;
        assert.equal(context.source, "local");
        if (context.source !== "local") throw new TypeError("Expected local source");
        assert.equal(context.env.get("TOKEN"), "scoped");
        return true;
      },
      routes: [
        route()({
          id: "rest",
          method: "GET",
          path: "/rest",
          description: "Child REST.",
          outputSchema: z.object({ ok: z.boolean() }),
          handler: () => {
            childCalls += 1;
            return { ok: true };
          },
        }),
      ],
    },
    jsonRpc: {
      guard: (context) => {
        childGuards += 1;
        assert.equal(context.source, "local");
        return true;
      },
      methods: [
        method()({
          name: "rpc",
          description: "Child RPC.",
          inputSchema: z.strictObject({}),
          handler: () => {
            childCalls += 1;
            return "rpc";
          },
        }),
      ],
    },
    mcp: {
      guard: (context) => {
        childGuards += 1;
        assert.equal(context.source, "local");
        return true;
      },
      tools: [
        tool()({
          name: "mcp",
          description: "Child MCP.",
          inputSchema: z.strictObject({}),
          handler: () => {
            childCalls += 1;
            return "mcp";
          },
        }),
      ],
    },
  });
  const parent = argsbarg({
    key: "parent",
    version: "1.0.0",
    description: "Parent.",
    commands: [],
    children: { mounted: { app: child } },
    cli: { guard: () => { parentGuards += 1; return true; } },
    http: { routes: [], guard: () => { parentGuards += 1; return true; } },
    jsonRpc: { methods: [], guard: () => { parentGuards += 1; return true; } },
    mcp: { tools: [], guard: () => { parentGuards += 1; return true; } },
  });

  try {
    const cli = await parent.invoke(["mounted", "token"]);
    assert.equal(cli.stdout, "token\n");
    const rest = await parent.invoke(["api", "GET", "/api/mounted/rest"]);
    const rpc = await parent.invoke(["rpc", "mounted.rpc"], { stdin: "{}" });
    const mcp = await parent.invoke(["mcp", "call", "mounted__mcp"], { stdin: "{}" });
    assert.equal(rest.exitCode, 0, rest.stderr);
    assert.deepEqual(JSON.parse(rest.stdout), { ok: true });
    assert.equal(rpc.stdout, '"rpc"\n');
    assert.equal(JSON.parse(mcp.stdout).structuredContent, "mcp");
    assert.equal(parentGuards, 0);
    assert.equal(childGuards, 4);
    assert.equal(childCalls, 4);
    assert.equal(events.filter((event) => event.startsWith("before:")).length, 4);

    const remoteCalls = await parent.invoke(
      ["rpc", "mounted.rpc", "--relay", "https://relay.example/rpc"],
      {
        stdin: "{}",
        fetch: async (url) => {
          assert.equal(String(url), "https://relay.example/rpc");
          return Response.json({ jsonrpc: "2.0", id: 1, result: "remote" });
        },
      },
    );
    assert.equal(remoteCalls.stdout, '"remote"\n');
    assert.equal(childCalls, 4);
  } finally {
    if (previous === undefined) delete process.env.MOUNTED_TOKEN;
    else process.env.MOUNTED_TOKEN = previous;
  }
});

test("parent and child collisions fail at construction with both owners", () => {
  const child = argsbarg({
    key: "child",
    version: "1.0.0",
    description: "Child.",
    commands: [{ key: "run", description: "Run.", handler: () => "child" }],
  });
  assert.throws(
    () =>
      argsbarg({
        key: "parent",
        version: "1.0.0",
        description: "Parent.",
        commands: [{ key: "child", description: "Duplicate.", handler: () => "parent" }],
        children: { child: { app: child, expose: ["cli"] } },
      }),
    /CLI collision "child".*"child\.cli:child".*"parent\.cli:child"/,
  );

  const routedChild = argsbarg({
    key: "routes",
    version: "1.0.0",
    description: "Routes.",
    commands: [],
    http: {
      routes: [
        route()({
          id: "list",
          method: "GET",
          path: "/items",
          description: "List.",
          outputSchema: z.object({ ok: z.boolean() }),
          handler: () => ({ ok: true }),
        }),
      ],
    },
  });
  assert.throws(
    () =>
      argsbarg({
        key: "parent",
        version: "1.0.0",
        description: "Parent.",
        commands: [],
        children: { mounted: { app: routedChild } },
        http: {
          routes: [
            route()({
              id: "mounted__list",
              method: "GET",
              path: "/other",
              description: "Other.",
              outputSchema: z.object({ ok: z.boolean() }),
              handler: () => ({ ok: true }),
            }),
          ],
        },
      }),
    /REST collision "mounted__list".*mounted.*parent/,
  );

  assert.throws(
    () =>
      argsbarg({
        key: "parent",
        version: "1.0.0",
        description: "Parent.",
        commands: [],
        children: { serve: { app: child, expose: ["cli"] } },
      }),
    /CLI collision "serve".*serve\.cli.*framework\.cli:serve/,
  );
  assert.throws(
    () =>
      argsbarg({
        key: "parent",
        version: "1.0.0",
        description: "Parent.",
        commands: [{ key: "serve", description: "Reserved.", handler: () => undefined }],
      }),
    /Reserved command name: serve/,
  );
});

test("relay uses one explicit request and never falls back to local work", async () => {
  let localCalls = 0;
  const methodDef = method()({
    name: "sideEffect",
    description: "Side effect.",
    inputSchema: z.strictObject({}),
    handler: () => {
      localCalls += 1;
      return { ok: true };
    },
  });
  const app = argsbarg({
    key: "relay",
    version: "1.0.0",
    description: "Relay.",
    commands: [],
    jsonRpc: { methods: [methodDef] },
  });
  let fetchCalls = 0;
  const result = await app.invoke(
    ["rpc", "sideEffect", "--relay", "https://relay.example/rpc", "--header", "X-Key: explicit"],
    {
      stdin: "{}",
      fetch: async (url, init) => {
        fetchCalls += 1;
        assert.equal(String(url), "https://relay.example/rpc");
        assert.equal(new Headers(init?.headers).get("x-key"), "explicit");
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 999, result: { ok: true } }), { status: 200 });
      },
    },
  );
  assert.equal(fetchCalls, 1);
  assert.equal(localCalls, 0);
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /CALL_PROTOCOL_ERROR/);
});

test("app hooks wrap every native and local-mirror invocation once", async () => {
  const seen: string[] = [];
  const input = z.strictObject({ value: z.string() });
  const hooks = {
    beforeInvoke: (context: { readonly surface: string }) => {
      seen.push(`before:${context.surface}`);
    },
    afterInvoke: (context: { readonly surface: string }) => {
      seen.push(`after:${context.surface}`);
    },
  };
  const rest = route()({
    id: "hookRest",
    method: "POST",
    path: "/hook",
    description: "Hook.",
    body: input,
    outputSchema: input,
    handler: ({ inputs, surface }) => {
      seen.push(`handler:${surface}`);
      return inputs;
    },
  });
  const rpc = method()({
    name: "hookRpc",
    description: "Hook.",
    inputSchema: input,
    handler: ({ inputs, surface }) => {
      seen.push(`handler:${surface}`);
      return inputs;
    },
  });
  const declaration = {
    inputSchema: input,
    guardPlan: compileGuardPlan<z.output<typeof input>, object>()({}),
    handler: ({ inputs, surface }: { readonly inputs: z.output<typeof input>; readonly surface: string }) => {
      seen.push(`handler:${surface}`);
      return inputs;
    },
  };
  const tool = registerMcpTool({
    name: "hookMcp",
    description: "Hook.",
    inputSchema: { type: "object" },
    declaration,
  } as Parameters<typeof registerMcpTool>[0]);
  const app = argsbarg({
    key: "hooks",
    version: "1.0.0",
    description: "Hooks.",
    commands: [],
    hooks,
    http: { routes: [rest] },
    jsonRpc: { methods: [rpc] },
    mcp: { tools: [tool] },
  });

  assert.equal((await app.invoke(["api", "POST", "/api/hook"], { stdin: '{"value":"rest"}' })).exitCode, 0);
  assert.equal((await app.invoke(["rpc", "hookRpc"], { stdin: '{"value":"rpc"}' })).exitCode, 0);
  assert.equal((await app.invoke(["mcp", "call", "hookMcp"], { stdin: '{"value":"mcp"}' })).exitCode, 0);

  const internals = app as unknown as {
    createNativeHttpMounts(selected?: readonly string[]): readonly HttpMount[];
  };
  const mounts = internals.createNativeHttpMounts();
  const restMount = mounts.find((mount) => mount.claims.some((claim) => claim.path === "/api"));
  const rpcMount = mounts.find((mount) => mount.claims.some((claim) => claim.path === "/rpc"));
  const mcpMount = mounts.find((mount) => mount.claims.some((claim) => claim.path === "/mcp"));
  assert.ok(restMount);
  assert.ok(rpcMount);
  assert.ok(mcpMount);
  const restRequest = new Request("http://localhost/api/hook", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"value":"wire-rest"}',
  });
  assert.equal(
    (await restMount.handle(restRequest, { signal: restRequest.signal })).status,
    201,
  );
  const rpcRequest = new Request("http://localhost/rpc", {
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hookRpc", params: { value: "wire-rpc" } }),
  });
  assert.equal(
    (await rpcMount.handle(rpcRequest, { signal: rpcRequest.signal })).status,
    200,
  );
  const mcpRequest = new Request("http://localhost/mcp", {
    method: "POST",
    headers: { "mcp-method": "tools/call", "mcp-name": "hookMcp" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "hookMcp",
        arguments: { value: "wire-mcp" },
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  const mcpResponse = await mcpMount.handle(mcpRequest, { signal: mcpRequest.signal });
  const mcpBody = await mcpResponse.text();
  assert.equal(mcpResponse.status, 200, mcpBody);
  assert.equal((JSON.parse(mcpBody) as { result?: { isError?: boolean } }).result?.isError, false, mcpBody);

  for (const surface of ["http", "jsonRpc", "mcp"]) {
    assert.equal(seen.filter((event) => event === `before:${surface}`).length, 2, `${surface}: ${seen.join(",")}`);
    assert.equal(seen.filter((event) => event === `handler:${surface}`).length, 2, `${surface}: ${seen.join(",")}`);
    assert.equal(seen.filter((event) => event === `after:${surface}`).length, 2, `${surface}: ${seen.join(",")}`);
  }
});

test("native error reporting skips Zod invalid outcomes but covers MCP with no app hooks", async () => {
  const reports: unknown[] = [];
  const errorReporter = {
    async reportError(error: unknown) {
      reports.push(error);
    },
    async reportMessage() {},
  };
  const input = z.strictObject({ value: z.string() });
  const rest = route()({
    id: "validated",
    method: "POST",
    path: "/validated",
    description: "Validated.",
    body: input,
    outputSchema: input,
    handler: ({ inputs }) => inputs,
  });
  const declaration = {
    inputSchema: input,
    guardPlan: compileGuardPlan<z.output<typeof input>, object>()({}),
    handler: () => {
      throw new Error("MCP exploded");
    },
  };
  const tool = registerMcpTool({
    name: "explodes",
    description: "Explodes.",
    inputSchema: { type: "object" },
    declaration,
  } as Parameters<typeof registerMcpTool>[0]);
  const app = argsbarg({
    key: "reporting",
    version: "1.0.0",
    description: "Reporting.",
    commands: [],
    errorReporter,
    http: { routes: [rest] },
    mcp: { tools: [tool] },
  });

  assert.equal((await app.invoke(["api", "POST", "/api/validated"], { stdin: '{"value":1}' })).exitCode, 1);
  assert.equal(reports.length, 0);
  assert.equal((await app.invoke(["mcp", "call", "explodes"], { stdin: '{"value":"ok"}' })).exitCode, 1);
  assert.equal(reports.length, 1);
  assert.equal((reports[0] as Error).message, "MCP exploded");
});

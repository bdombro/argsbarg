/*
Focused tests for package-internal child snapshot composition.
They cover names, exposure, scoped sources, immutability, and collision facts without factory integration.
*/

import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import type { InvocationBase, NameView } from "../core/invocation.ts";
import { type AppSpec, hasSubcommands, OptionKind } from "../core/types.ts";
import { type HttpRouteRegistration, route } from "../http/routes.ts";
import { method } from "../json-rpc/declaration.ts";
import { tool } from "../mcp/registry.ts";
import {
  assertNoChildCollisions,
  type ChildAppView,
  type ChildCollisionFact,
  type ChildSourceScope,
  composeChildren,
  scopeChildInvocation,
} from "./children.ts";

/** Returns one structural child app without changing the not-yet-public child types. */
function child(
  fields: Record<string, unknown> = {},
): ChildAppView {
  return {
    spec: Object.freeze({
      key: "original",
      description: "Child app.",
      version: "1.0.0",
      commands: [],
      ...fields,
    }) as AppSpec,
  };
}

/** Captures only exact string lookups without exposing the backing object. */
function exactView(values: Readonly<Record<string, string>>): NameView {
  return Object.freeze({ get: (name: string) => values[name] });
}

/** Creates a case-insensitive HTTP header view equivalent to native Fetch Headers. */
function headerView(values: Readonly<Record<string, string>>): NameView {
  const headers = new Headers(values);
  return Object.freeze({ get: (name: string) => headers.get(name) ?? undefined });
}

/** Returns one fixed local invocation base suitable for source-scope tests. */
function localBase(env: NameView): InvocationBase<object> {
  return {
    source: "local",
    env,
    locals: {},
    signal: new AbortController().signal,
    surface: "cli",
  };
}

/** Creates a route declaration with a short JSON shape for identity tests. */
function jsonRoute(
  id: string,
  path: string,
  methodName: HttpRouteRegistration["method"] = "GET",
): HttpRouteRegistration {
  return route()({
    id,
    method: methodName,
    path,
    description: `${id} route.`,
    outputSchema: z.strictObject({ ok: z.boolean() }),
    handler: () => ({ ok: true }),
  });
}

/** Creates an RPC declaration with a stable empty-input contract. */
function rpcMethod(name: string) {
  return method()({
    name,
    description: `${name} method.`,
    inputSchema: z.strictObject({}),
    outputSchema: z.boolean(),
    handler: () => true,
  });
}

/** Creates an MCP declaration with a stable empty-input contract. */
function mcpTool(name: string) {
  return tool()({
    name,
    description: `${name} tool.`,
    inputSchema: z.strictObject({}),
    outputSchema: z.boolean(),
    handler: () => true,
  });
}

test("composes exact nested CLI, REST, RPC, and MCP names without changing the child app", () => {
  const cli = {
    key: "run",
    description: "Run.",
    handler: () => undefined,
  };
  const http = jsonRoute("listInvoices", "/invoices");
  const rpc = rpcMethod("reports.get");
  const mcp = mcpTool("list_invoices");
  const grandchild = child({
    http: { routes: [jsonRoute("root", "/")] },
    jsonRpc: { methods: [rpcMethod("retry")] },
    mcp: { tools: [mcpTool("retry")] },
  });
  const mounted = child({
    commands: [cli],
    children: { reports: { app: grandchild } },
    http: { routes: [http] },
    jsonRpc: { methods: [rpc] },
    mcp: { tools: [mcp] },
  });

  const snapshot = composeChildren({
    operations: { app: mounted },
  });

  assert.equal(snapshot.cli[0]?.root.key, "operations");
  assert.deepEqual(snapshot.cli[0]?.path, ["operations"]);
  assert.deepEqual(snapshot.cli[1]?.path, ["operations", "reports"]);
  assert.equal(snapshot.http[0]?.route.id, "operations__listInvoices");
  assert.equal(snapshot.http[0]?.route.path, "/operations/invoices");
  assert.equal(snapshot.http[1]?.route.id, "operations__reports__root");
  assert.equal(snapshot.http[1]?.route.path, "/operations/reports");
  assert.equal(snapshot.jsonRpc[0]?.method.name, "operations.reports.get");
  assert.equal(snapshot.jsonRpc[1]?.method.name, "operations.reports.retry");
  assert.equal(snapshot.mcp[0]?.tool.name, "operations__list_invoices");
  assert.equal(snapshot.mcp[1]?.tool.name, "operations__reports__retry");

  assert.equal(mounted.spec.key, "original");
  assert.ok(hasSubcommands(mounted.spec));
  assert.equal(mounted.spec.commands[0]?.key, "run");
  assert.equal(http.id, "listInvoices");
  assert.equal(http.path, "/invoices");
  assert.equal(rpc.name, "reports.get");
  assert.equal(mcp.name, "list_invoices");
});

test("applies omitted, subset, and nested-intersection exposure including empty surfaces", () => {
  const nested = child({
    http: { routes: [] },
    jsonRpc: { methods: [rpcMethod("nested")] },
    mcp: { tools: [mcpTool("nested")] },
  });
  const mounted = child({
    children: { inner: { app: nested, expose: ["mcp"] } },
    http: { routes: [jsonRoute("root", "/root")] },
    jsonRpc: { methods: [rpcMethod("root")] },
  });

  const all = composeChildren({ suite: { app: mounted } });
  assert.deepEqual(all.surfaces, ["cli", "http", "jsonRpc", "mcp"]);
  assert.equal(all.mcp[0]?.tool.name, "suite__inner__nested");

  const restOnly = composeChildren({ suite: { app: mounted, expose: ["http"] } });
  assert.deepEqual(restOnly.surfaces, ["http"]);
  assert.equal(restOnly.http.length, 1);
  assert.equal(restOnly.jsonRpc.length, 0);
  assert.equal(restOnly.mcp.length, 0);

  const emptyHttp = composeChildren({
    suite: { app: child({ http: { routes: [] } }), expose: ["http"] },
  });
  assert.deepEqual(emptyHttp.surfaces, ["http"]);
  assert.equal(emptyHttp.http.length, 0);
});

test("rejects invalid, duplicate, empty, and unconfigured expose values", () => {
  const app = child({ http: { routes: [] } });
  assert.throws(
    () => composeChildren({ suite: { app, expose: [] } }),
    /expose must be a non-empty surface list/,
  );
  assert.throws(
    () => composeChildren({ suite: { app, expose: ["http", "http"] } }),
    /duplicate surface "http"/,
  );
  assert.throws(
    () => composeChildren({ suite: { app, expose: ["mcp"] } }),
    /unconfigured surface "mcp"/,
  );
  assert.throws(
    () =>
      composeChildren({
        suite: { app, expose: ["rpc" as "mcp"] },
      }),
    /unsupported surface "rpc"/,
  );
});

test("snapshots mounted child-owned MCP Tasks providers with their policy", () => {
  const app = child({
    mcp: {
      tools: [],
      tasks: {
        get: () => {
          throw new Error("not called");
        },
        update: () => undefined,
        cancel: () => undefined,
      },
    },
  });
  const snapshot = composeChildren({ suite: { app } });
  assert.equal(snapshot.mcpTasks.length, 1);
  assert.equal(snapshot.mcpTasks[0]?.provider, app.spec.mcp?.tasks);
  assert.deepEqual(snapshot.mcpTasks[0]?.path, ["suite"]);
  assert.equal(snapshot.mcpTasks[0]?.guard, app.spec.mcp?.guard);
});

test("scopes exact local and case-insensitive HTTP sources while hiding descendants", () => {
  const reports = child({ mcp: { tools: [mcpTool("list")] } });
  const billing = child({ children: { reports: { app: reports } } });
  const snapshot = composeChildren({ billing: { app: billing } });
  const descendant = snapshot.mcp[0]?.source;
  assert.ok(descendant);

  const ancestorScoped = snapshot.cli[0]?.source as ChildSourceScope;
  const scoped = scopeChildInvocation(
    localBase(
      exactView({
        BILLING_TOKEN: "own",
        BILLING_REPORTS_TOKEN: "child",
        OTHER_TOKEN: "other",
      }),
    ),
    ancestorScoped,
  );
  assert.equal(scoped.source, "local");
  if (scoped.source !== "local") throw new Error("expected local source");
  assert.equal(scoped.env.get("TOKEN"), "own");
  assert.equal(scoped.env.get("REPORTS_TOKEN"), undefined);
  assert.equal(scoped.env.get("OTHER_TOKEN"), undefined);
  assert.equal("headers" in scoped, false);

  const reportScoped = scopeChildInvocation(
    {
      source: "http",
      headers: headerView({
        "billing-reports-Authorization": "child-http",
        Authorization: "unscoped",
      }),
      locals: {},
      signal: new AbortController().signal,
      surface: "http",
    },
    descendant,
  );
  assert.equal(reportScoped.source, "http");
  if (reportScoped.source !== "http") throw new Error("expected HTTP source");
  assert.equal(reportScoped.headers.get("authorization"), "child-http");
  assert.equal(reportScoped.headers.get("TOKEN"), undefined);
  assert.equal("env" in reportScoped, false);
});

test("freezes cloned declaration metadata and preserves child-owned policy references", () => {
  const option = {
    name: "count",
    description: "Original option.",
    kind: OptionKind.Number,
  };
  const command = {
    key: "run",
    description: "Run.",
    options: [option],
    handler: () => undefined,
  };
  const routeEntry = jsonRoute("run", "/run");
  const registeredTool = mcpTool("run");
  const guard = () => true;
  const beforeInvoke = () => undefined;
  const nestedCli = {
    completions: { hidden: true },
    schema: { hidden: true },
  };
  const mounted = child({
    cli: {
      hidden: true,
      completions: { hidden: true },
      schema: { hidden: true },
      guard,
    },
    commands: [
      {
        ...command,
        cli: nestedCli,
      },
    ],
    hooks: { beforeInvoke },
    http: { routes: [routeEntry], guard },
    mcp: { tools: [registeredTool], guard },
  });

  const snapshot = composeChildren({ suite: { app: mounted } });
  option.description = "Mutated option.";
  (routeEntry as { description: string }).description = "Mutated route.";
  (registeredTool as { description: string }).description = "Mutated tool.";

  const root = snapshot.cli[0]?.root;
  assert.notEqual(snapshot.cli[0]?.root, mounted.spec);
  assert.ok(root && hasSubcommands(root));
  assert.equal(root.commands[0]?.options?.[0]?.description, "Original option.");
  assert.deepEqual(root.cli, {
    hidden: true,
    completions: { hidden: true },
    schema: { hidden: true },
  });
  assert.deepEqual(root.commands[0]?.cli, {
    completions: { hidden: true },
    schema: { hidden: true },
  });
  assert.notEqual(root.cli, mounted.spec.cli);
  assert.ok(hasSubcommands(mounted.spec));
  assert.notEqual(root.commands[0]?.cli, mounted.spec.commands[0]?.cli);
  assert.notEqual(root.commands[0]?.cli?.completions, nestedCli.completions);
  assert.notEqual(root.commands[0]?.cli?.schema, nestedCli.schema);
  assert.equal(snapshot.http[0]?.route.description, "run route.");
  assert.equal(snapshot.mcp[0]?.tool.description, "run tool.");
  assert.equal((snapshot.mcp[0]?.tool.inputSchema as { title?: string }).title, undefined);
  assert.equal(snapshot.mcp[0]?.tool.withSurfaceGuard?.(undefined).name, "suite__run");
  assert.equal(snapshot.cli[0]?.guard, guard);
  assert.equal(snapshot.cli[0]?.hooks?.beforeInvoke, beforeInvoke);
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.cli));
  assert.ok(Object.isFrozen(snapshot.cli[0]?.root));
  assert.ok(Object.isFrozen(snapshot.mcp[0]?.tool.inputSchema));
  assert.ok(snapshot.collisions.every((fact) => Object.isFrozen(fact)));
  assert.ok(
    snapshot.collisions
      .filter((fact) => fact.routeSegments !== undefined)
      .every((fact) => Object.isFrozen(fact.routeSegments)),
  );
});

test("rejects invalid mount keys and overlapping sibling source prefixes", () => {
  for (const key of ["", "-x", "x-", "x--y", "x_y", "x.y", "Upper", "1start"]) {
    assert.throws(() => composeChildren({ [key]: { app: child() } }), /Invalid child mount key/);
  }
  assert.throws(
    () =>
      composeChildren({
        billing: { app: child() },
        "billing-reports": { app: child() },
      }),
    /environment source-prefix collision "BILLING_REPORTS_"/,
  );
});

test("reports duplicate CLI, REST, RPC, and MCP identities with both owners", () => {
  const cliNested = child();
  const cliChild = child({
    commands: [{ key: "billing", description: "Own billing.", handler: () => undefined }],
    children: { billing: { app: cliNested, expose: ["cli"] } },
  });
  assert.throws(
    () => composeChildren({ operations: { app: cliChild, expose: ["cli"] } }),
    /CLI collision "operations billing".*"operations.cli:operations billing".*"operations.billing.cli:operations billing"/,
  );

  const httpOperationNested = child({ http: { routes: [jsonRoute("invoice", "/nested")] } });
  const httpOperationChild = child({
    children: { billing: { app: httpOperationNested, expose: ["http"] } },
    http: { routes: [jsonRoute("billing__invoice", "/own")] },
  });
  assert.throws(
    () => composeChildren({ operations: { app: httpOperationChild, expose: ["http"] } }),
    /REST collision "operations__billing__invoice"/,
  );

  const httpRouteNested = child({ http: { routes: [jsonRoute("nested", "/:id")] } });
  const httpRouteChild = child({
    children: { billing: { app: httpRouteNested, expose: ["http"] } },
    http: { routes: [jsonRoute("own", "/billing/:name")] },
  });
  assert.throws(
    () => composeChildren({ operations: { app: httpRouteChild, expose: ["http"] } }),
    /REST collision "GET \/operations\/billing\/:id"/,
  );

  const rpcNested = child({ jsonRpc: { methods: [rpcMethod("invoice")] } });
  const rpcChild = child({
    children: { billing: { app: rpcNested, expose: ["jsonRpc"] } },
    jsonRpc: { methods: [rpcMethod("billing.invoice")] },
  });
  assert.throws(
    () => composeChildren({ operations: { app: rpcChild, expose: ["jsonRpc"] } }),
    /JSON-RPC collision "operations.billing.invoice"/,
  );

  const mcpNested = child({ mcp: { tools: [mcpTool("invoice")] } });
  const mcpChild = child({
    children: { billing: { app: mcpNested, expose: ["mcp"] } },
    mcp: { tools: [mcpTool("billing__invoice")] },
  });
  assert.throws(
    () => composeChildren({ operations: { app: mcpChild, expose: ["mcp"] } }),
    /MCP collision "operations__billing__invoice"/,
  );
});

test("collision facts remain independent of visibility and enforce exact owner metadata", () => {
  const hiddenCli = composeChildren({
    hidden: {
      app: child({
        commands: [
          {
            key: "secret",
            description: "Hidden but callable.",
            cli: { hidden: true },
            handler: () => undefined,
          },
        ],
      }),
      expose: ["cli"],
    },
  });

  const nested = child({
    commands: [{ key: "nested", description: "Nested.", handler: () => undefined }],
  });
  const mounted = child({
    cli: { enabled: false },
    commands: [{ key: "own", description: "Own.", handler: () => undefined }],
    children: { nested: { app: nested } },
  });
  const snapshot = composeChildren({ disabled: { app: mounted } });
  assert.deepEqual(snapshot.cli, []);
  assert.ok(snapshot.surfaces.includes("cli"));
  assert.equal(snapshot.collisions.some((fact) => fact.kind === "cli"), false);

  const leaflessDisabled = composeChildren({
    disabled: { app: child({ cli: { enabled: false } }) },
  });
  assert.deepEqual(leaflessDisabled.cli, []);
  assert.deepEqual(leaflessDisabled.surfaces, ["cli"]);
  assert.equal(leaflessDisabled.collisions.some((fact) => fact.kind === "cli"), false);
  assert.ok(hiddenCli.collisions.some((fact) => fact.identity === "hidden secret"));

  const disabledCli = composeChildren({
    disabled: {
      app: child({
        commands: [
          {
            key: "off",
            description: "Disabled.",
            cli: { enabled: false },
            handler: () => undefined,
          },
        ],
      }),
      expose: ["cli"],
    },
  });
  assert.equal(disabledCli.collisions.some((fact) => fact.identity === "disabled off"), false);

  const facts: ChildCollisionFact[] = [
    { kind: "rpc", identity: "suite.run", ownerPath: "suite.first" },
    { kind: "rpc", identity: "suite.run", ownerPath: "suite.second" },
  ];
  assert.throws(
    () => assertNoChildCollisions(facts),
    /between "suite.first" and "suite.second"/,
  );
});

test("validates each final composed MCP name through the canonical registry profile", () => {
  const invalid = mcpTool("");
  const snapshot = composeChildren({
    suite: { app: child({ mcp: { tools: [invalid] } }) },
  });
  assert.equal(snapshot.mcp[0]?.tool.name, "suite__");
  assert.ok(snapshot.mcp[0]?.tool.name.length > 0);
});

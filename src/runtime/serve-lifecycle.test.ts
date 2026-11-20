/*
Focused lifecycle tests for native service registration.
They verify that signal-driven listener shutdown resolves normally instead of terminating the process.
*/

import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { route } from "../http/routes.ts";
import { method } from "../json-rpc/declaration.ts";
import { tool } from "../mcp/registry.ts";
import { argsbarg } from "./cli.ts";

test("native serve stops once on SIGTERM and resolves", async () => {
  const app = argsbarg({
    key: "service",
    description: "Service.",
    version: "1.0.0",
    commands: [],
    http: {
      routes: [
        route()({
          id: "health",
          method: "GET",
          path: "/health",
          description: "Health.",
          outputSchema: z.strictObject({ ok: z.boolean() }),
          handler: () => ({ ok: true }),
        }),
      ],
    },
  });
  const serving = app.serveHttp({ port: 0 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  process.emit("SIGTERM");
  await assert.doesNotReject(serving);
});

test("native service return flushes stdout and stderr", async () => {
  const app = argsbarg({
    key: "flush-service",
    description: "Service.",
    version: "1.0.0",
    commands: [],
    http: {
      routes: [
        route()({
          id: "health",
          method: "GET",
          path: "/health",
          description: "Health.",
          outputSchema: z.strictObject({ ok: z.boolean() }),
          handler: () => ({ ok: true }),
        }),
      ],
    },
  });
  const stdoutWrite = process.stdout.write;
  const stderrWrite = process.stderr.write;
  let stdoutFlushed = 0;
  let stderrFlushed = 0;
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    if (chunk === "" && typeof rest[0] === "function") {
      stdoutFlushed += 1;
      (rest[0] as () => void)();
    }
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    if (chunk === "" && typeof rest[0] === "function") {
      stderrFlushed += 1;
      (rest[0] as () => void)();
    }
    return true;
  }) as typeof process.stderr.write;
  try {
    const serving = app.serveHttp({ port: 0 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    process.emit("SIGTERM");
    await serving;
    assert.equal(stdoutFlushed, 1);
    assert.equal(stderrFlushed, 1);
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  }
});

test("explicit unconfigured services fail before binding", async () => {
  const app = argsbarg({
    key: "selection",
    description: "Selection.",
    version: "1.0.0",
    commands: [],
    http: { routes: [] },
  });
  await assert.rejects(app.serveHttp({ port: 0 }, ["rpc"]), /not configured: rpc/);
  await assert.rejects(app.serveHttp({ port: 0 }, ["http", "mcp"]), /not configured: mcp/);
});

test("stdio serve rejects every malformed grammar before MCP I/O", async () => {
  const app = argsbarg({
    key: "stdio-selection",
    description: "Stdio selection.",
    version: "1.0.0",
    commands: [],
    mcp: { tools: [] },
  });
  let starts = 0;
  const runtime = app as unknown as {
    runService(argv: readonly string[]): Promise<void>;
    serveMcp(): Promise<void>;
  };
  runtime.serveMcp = async () => {
    starts += 1;
  };
  for (const argv of [
    ["--stdio", "mcp"],
    ["mcp", "--stdio", "extra"],
    ["mcp", "--stdio", "--host", "localhost"],
    ["mcp", "--stdio", "--stdio"],
  ]) {
    await assert.rejects(runtime.runService(argv), /exactly that grammar/);
  }
  assert.equal(starts, 0);
  await runtime.runService(["mcp", "--stdio"]);
  assert.equal(starts, 1);
});

test("selected listener mounts framework health and status endpoints", async () => {
  const app = argsbarg({
    key: "health",
    description: "Health.",
    version: "1.0.0",
    commands: [],
    jsonRpc: { methods: [] },
  });
  const mounts = (
    app as unknown as {
      createNativeHttpMounts(selected?: readonly string[]): readonly import("../server/listener.ts").HttpMount[];
    }
  ).createNativeHttpMounts(["rpc"]);
  const health = mounts.find((mount) => mount.claims.some((claim) => claim.path === "/status"));
  assert.ok(health);
  const response = await health.handle(new Request("http://localhost/status"), {
    signal: new AbortController().signal,
  });
  assert.deepEqual(await response.json(), { ok: true, services: ["rpc"] });
});

test("child-only services contribute to parent mounts without invoking child lifecycle", async () => {
  const child = argsbarg({
    key: "child",
    description: "Child.",
    version: "1.0.0",
    commands: [],
    http: {
      routes: [
        route()({
          id: "health",
          method: "GET",
          path: "/health",
          description: "Child health.",
          outputSchema: z.strictObject({ ok: z.boolean() }),
          handler: () => ({ ok: true }),
        }),
      ],
    },
    jsonRpc: {
      methods: [
        method()({
          name: "ready",
          description: "Child ready.",
          inputSchema: z.strictObject({}),
          handler: () => true,
        }),
      ],
    },
    mcp: {
      tools: [
        tool()({
          name: "ready",
          description: "Child ready.",
          inputSchema: z.strictObject({}),
          handler: () => true,
        }),
      ],
    },
  });
  let lifecycleCalls = 0;
  child.run = async () => { lifecycleCalls += 1; };
  child.serveHttp = async () => { lifecycleCalls += 1; };
  child.serveMcp = async () => { lifecycleCalls += 1; };
  const parent = argsbarg({
    key: "parent",
    description: "Parent.",
    version: "1.0.0",
    commands: [],
    children: { child: { app: child } },
  });
  const mounts = (
    parent as unknown as {
      createNativeHttpMounts(selected?: readonly string[]): readonly import("../server/listener.ts").HttpMount[];
    }
  ).createNativeHttpMounts();
  assert.equal(mounts.length, 4);
  assert.ok(mounts.some((mount) => mount.claims.some((claim) => claim.path === "/api")));
  assert.ok(mounts.some((mount) => mount.claims.some((claim) => claim.path === "/rpc")));
  assert.ok(mounts.some((mount) => mount.claims.some((claim) => claim.path === "/mcp")));
  const status = mounts.find((mount) => mount.claims.some((claim) => claim.path === "/status"));
  assert.ok(status);
  const response = await status.handle(new Request("http://localhost/status"), {
    signal: new AbortController().signal,
  });
  assert.deepEqual(await response.json(), { ok: true, services: ["http", "rpc", "mcp"] });
  assert.equal(lifecycleCalls, 0);
});

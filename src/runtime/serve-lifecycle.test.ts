/*
Focused lifecycle tests for native service registration.
They verify that signal-driven listener shutdown resolves normally instead of terminating the process.
*/

import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { get as httpGet } from "node:http";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { route } from "../http/routes.ts";
import { method } from "../json-rpc/declaration.ts";
import { tool } from "../mcp/registry.ts";
import { resolveHttpServeConfig } from "../server/overrides.ts";
import { argsbarg } from "./cli.ts";

test("keyed listener settings retain default and legacy TCP and reject an empty explicit set", () => {
  const spec = { key: "listener", description: "Listener.", version: "1.0.0", commands: [] };
  assert.deepEqual(resolveHttpServeConfig(spec).targets, [{ kind: "tcp", host: "127.0.0.1", port: 3000 }]);
  const legacy = { ...spec, http: { routes: [], host: "localhost", port: 3100 } };
  assert.deepEqual(resolveHttpServeConfig(legacy, { port: 0 }).targets, [{ kind: "tcp", host: "localhost", port: 0 }]);
  assert.deepEqual(resolveHttpServeConfig({ ...legacy, server: { listeners: { tcp: {} } } }).targets, [
    { kind: "tcp", host: "127.0.0.1", port: 3000 },
  ]);
  assert.throws(
    // @ts-expect-error Untyped callers must be rejected at runtime too.
    () => resolveHttpServeConfig({ ...spec, server: { listeners: {} } }),
    /requires at least one/,
  );
});

test("a public lazy listener serves RPC over Unix, alone or with TCP", { skip: process.platform === "win32" }, async () => {
  const directory = await mkdtemp("/tmp/argsbarg-");
  try {
    for (const dual of [false, true]) {
      const path = join(directory, "app.sock");
      let resolutions = 0;
      const app = argsbarg({
        key: "unix",
        description: "Unix listener.",
        version: "1.0.0",
        handler: () => "local",
        jsonRpc: { methods: [] },
        server: {
          listeners: () => {
            resolutions += 1;
            return dual ? { tcp: { port: 0 }, socket: { path } } : { socket: { path } };
          },
        },
      });
      assert.equal((await app.invoke([])).exitCode, 0);
      assert.equal(resolutions, 0);
      if (!dual) await assert.rejects(app.serveHttp({ port: 0 }), /TCP overrides require/);
      const beforeStart = resolutions;
      // Wait until serveHttp has installed its own shutdown handler after all binds.
      const baselineHandlers = process.listenerCount("SIGTERM");
      const serving = app.serveHttp();
      const signal = AbortSignal.timeout(2000);
      try {
        await Promise.race([
          serving.then(() => assert.fail("HTTP service stopped before it was ready")),
          (async () => {
            while (process.listenerCount("SIGTERM") === baselineHandlers) await delay(5, undefined, { signal });
          })(),
        ]);
        const reply = await new Promise<string>((resolve, reject) => {
          httpGet({ socketPath: path, path: "/status", signal }, async (response) => {
            try {
              assert.equal(response.statusCode, 200);
              let body = "";
              for await (const chunk of response.setEncoding("utf8")) body += chunk;
              resolve(body);
            } catch (error) {
              reject(error);
            }
          }).on("error", reject);
        });
        assert.deepEqual(JSON.parse(reply), { ok: true, services: ["rpc"] });
        assert.equal(resolutions, beforeStart + 1);
      } finally {
        if (process.listenerCount("SIGTERM") > baselineHandlers) process.emit("SIGTERM");
        await serving;
      }
      await assert.rejects(lstat(path), { code: "ENOENT" });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("public Unix launch rejects shared directories and preserves existing paths", { skip: process.platform === "win32" }, async () => {
  const directory = await mkdtemp("/tmp/argsbarg-");
  const path = join(directory, "app.sock");
  const app = argsbarg({
    key: "unix",
    description: "Restricted socket.",
    version: "1.0.0",
    commands: [],
    http: { routes: [] },
    server: { listeners: { socket: { path } } },
  });
  try {
    await chmod(directory, 0o755);
    await assert.rejects(app.serveHttp(), /directory must be .*private/);
    await assert.rejects(lstat(path), { code: "ENOENT" });
    await chmod(directory, 0o700);
    await writeFile(path, "foreign");
    await assert.rejects(app.serveHttp(), /socket path already exists/);
    assert.equal(await readFile(path, "utf8"), "foreign");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

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
    server: { listeners: () => { throw new Error("invalid HTTP environment"); } },
  });
  assert.equal((await app.invoke(["--help"])).exitCode, 0);
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

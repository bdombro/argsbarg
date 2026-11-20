/*
Focused tests for framework-owned health and status routes.
They verify exact claims, selected service reporting, and method admission.
*/

import assert from "node:assert/strict";
import test from "node:test";
import { createFrameworkHealthMount } from "./health.ts";

test("framework health mount owns exact operational roots and selected services", async () => {
  const mount = createFrameworkHealthMount(["rpc", "mcp"]);
  assert.deepEqual(mount.claims, [
    { kind: "exact", path: "/health/liveness" },
    { kind: "exact", path: "/health/readiness" },
    { kind: "exact", path: "/status" },
  ]);
  const context = { signal: new AbortController().signal };
  const liveness = await mount.handle(new Request("http://localhost/health/liveness"), context);
  const readiness = await mount.handle(new Request("http://localhost/health/readiness"), context);
  const status = await mount.handle(new Request("http://localhost/status"), context);
  assert.deepEqual(await liveness.json(), { ok: true });
  assert.deepEqual(await readiness.json(), { ok: true });
  assert.deepEqual(await status.json(), { ok: true, services: ["rpc", "mcp"] });
});

test("framework health mount rejects non-GET requests without status fallback", async () => {
  const mount = createFrameworkHealthMount(["http"]);
  const response = await mount.handle(new Request("http://localhost/status", { method: "POST" }), {
    signal: new AbortController().signal,
  });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET");
});

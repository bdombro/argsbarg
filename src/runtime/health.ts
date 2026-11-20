/*
Framework-owned operational endpoints mounted beside selected HTTP services.
They report listener-level liveness, readiness, and the selected service inventory.
*/

import type { HttpMount } from "../server/listener.ts";

/** Stable service names exposed by the shared HTTP listener. */
export type HttpServiceName = "http" | "rpc" | "mcp";

/** Frozen operational response emitted by a framework health endpoint. */
interface HealthResponse {
  /** Whether the observed framework state is operational. */
  readonly ok: true;
  /** Selected shared-listener services, present for the status endpoint. */
  readonly services?: readonly HttpServiceName[];
}

/** Returns a compact JSON response for a framework operational endpoint. */
function json(
  /** JSON-safe operational payload. */
  body: HealthResponse,
): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * Creates the exact root health/status mount for one successfully configured listener.
 * These endpoints do not require an app route or enter any invocation guard/hook pipeline.
 */
export function createFrameworkHealthMount(
  /** Services selected for this shared HTTP listener. */
  services: readonly HttpServiceName[],
): HttpMount {
  const selected = Object.freeze([...services]);
  return {
    claims: [
      { kind: "exact", path: "/health/liveness" },
      { kind: "exact", path: "/health/readiness" },
      { kind: "exact", path: "/status" },
    ],
    handle(request) {
      if (request.method !== "GET") {
        return new Response(null, { status: 405, headers: { Allow: "GET" } });
      }
      const path = new URL(request.url).pathname;
      if (path === "/health/liveness") return json({ ok: true });
      if (path === "/health/readiness") return json({ ok: true });
      return json({ ok: true, services: selected });
    },
  };
}

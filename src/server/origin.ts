/*
Shared Origin admission for the REST and MCP HTTP mounts.
It does not set CORS headers or authenticate callers.
*/

import type { AllowedOrigins } from "../core/types.ts";
import type { HttpMount } from "./listener.ts";

/** Origin policy and rejection logging supplied by a mount owner. */
export interface OriginGateOptions {
  /** Exact trusted origins, or "*" to skip Origin admission. */
  readonly allowedOrigins?: AllowedOrigins | undefined;
  /** Observes the same safe diagnostic returned to a rejected caller. */
  readonly onOriginRejected?: ((message: string) => void) | undefined;
}

/** Recognizes an exact HTTP(S) origin without credentials, path, or query. */
function isHttpOrigin(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value;
  } catch {
    return false;
  }
}

/** Rejects untrusted browser origins before invoking the wrapped mount. */
export function withOriginGate(
  /** Public setting name shown in config errors and rejection diagnostics. */
  setting: "http.allowedOrigins" | "mcp.http.allowedOrigins",
  /** Startup policy and optional warning sink. */
  { allowedOrigins, onOriginRejected }: OriginGateOptions,
  /** Mounted REST or MCP adapter. */
  mount: HttpMount,
): HttpMount {
  if (allowedOrigins === "*") return mount;
  if (
    allowedOrigins !== undefined &&
    (!Array.isArray(allowedOrigins) || !Array.from(allowedOrigins).every(isHttpOrigin))
  ) {
    throw new TypeError(`${setting} must be "*" or a list of exact HTTP(S) origins`);
  }
  const trusted = new Set(allowedOrigins);
  return {
    claims: mount.claims,
    handle(request, context) {
      const origin = request.headers.get("Origin");
      if (origin === null || trusted.has(origin)) return mount.handle(request, context);

      const submitted =
        isHttpOrigin(origin) || origin === "null"
          ? `Origin ${JSON.stringify(origin.length > 160 ? `${origin.slice(0, 157)}...` : origin)}`
          : "The submitted Origin";
      const message = `${submitted} is not allowed. If you trust this browser app, add its exact HTTP(S) origin to ${setting}.`;
      try {
        onOriginRejected?.(message);
      } catch {
        // A failing log sink must not replace the rejection or admit the request.
      }
      return Response.json(
        { error: { code: "ORIGIN_NOT_ALLOWED", message } },
        { status: 403, headers: { "cache-control": "no-store" } },
      );
    },
  };
}

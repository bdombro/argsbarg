/*
HTTP mount for the standalone JSON-RPC surface and its OpenRPC discovery document.
It adapts Web requests to the transport-neutral dispatcher without owning a listener or local/relay path.
*/

import type { InvocationBase } from "../core/invocation.ts";
import type { HttpMount } from "../server/listener.ts";
import type { JsonRpcCatalog } from "./catalog.ts";
import { dispatchJsonRpc, type JsonRpcDispatchResult, type JsonRpcNotificationObservation } from "./dispatch.ts";
import { generateOpenRpc, type OpenRpcAppInfo } from "./openrpc.ts";

/** Fixed catalog, application identity and request-local seed sources for the RPC HTTP mount. */
export interface JsonRpcHttpMountOptions<Seed extends object> {
  /** One factory-owned catalog shared by dispatch and OpenRPC discovery. */
  readonly catalog: JsonRpcCatalog<Seed>;
  /** Stable identity embedded in the cached OpenRPC document. */
  readonly appInfo: OpenRpcAppInfo;
  /** Creates the fresh transport seed locals for one batch member. */
  readonly createLocals: () => Seed;
  /** Optional bounded observer for notification outcomes. */
  readonly observeNotification?: (event: JsonRpcNotificationObservation) => void | Promise<void>;
}

/** JSON media type shared by successful and native adapter-error responses. */
const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

/** Produces a small native JSON response without exposing framework or handler details. */
function jsonResponse(
  /** HTTP status selected by the transport adapter. */
  status: number,
  /** Strictly controlled response value. */
  body: unknown,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": JSON_CONTENT_TYPE },
  });
}

/** Produces the exact wrong-method response for one claimed RPC path. */
function methodNotAllowed(
  /** Sole HTTP method supported by the claimed path. */
  allow: "GET" | "POST",
): Response {
  return new Response(JSON.stringify({ error: "Method not allowed" }), {
    status: 405,
    headers: {
      allow,
      "content-type": JSON_CONTENT_TYPE,
    },
  });
}

/** Encodes one defined transport-neutral JSON-RPC result as a 200 response. */
function dispatchResponse(
  /** Strict result or response array produced by DP-22 dispatch. */
  result: Exclude<JsonRpcDispatchResult, undefined>,
): Response {
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { "content-type": JSON_CONTENT_TYPE },
  });
}

/** Creates the exact package-internal `/rpc` and OpenRPC mounts for one retained catalog. */
export function createJsonRpcHttpMount<Seed extends object>(
  /** Catalog identity and per-request factories retained by the mount. */
  options: JsonRpcHttpMountOptions<Seed>,
): HttpMount {
  const openRpcBody = JSON.stringify(generateOpenRpc(options.catalog, options.appInfo));
  return {
    claims: [
      { kind: "exact", path: "/rpc" },
      { kind: "exact", path: "/rpc/openrpc.json" },
    ],
    async handle(request, context): Promise<Response> {
      const path = new URL(request.url).pathname;
      if (path === "/rpc/openrpc.json") {
        if (request.method !== "GET") return methodNotAllowed("GET");
        return new Response(openRpcBody, {
          status: 200,
          headers: { "content-type": JSON_CONTENT_TYPE },
        });
      }
      if (path !== "/rpc") {
        throw new TypeError(`JSON-RPC HTTP mount received unclaimed path ${JSON.stringify(path)}`);
      }
      if (request.method !== "POST") return methodNotAllowed("POST");

      let body: string;
      try {
        body = await request.text();
      } catch (error) {
        if (request.signal.aborted || context.signal.aborted) throw error;
        return jsonResponse(500, { error: "Internal Server Error" });
      }

      const result = await dispatchJsonRpc(options.catalog, body, {
        createBase: (): InvocationBase<Seed> => ({
          source: "http",
          headers: {
            get: (name) => request.headers.get(name) ?? undefined,
          },
          locals: options.createLocals(),
          signal: request.signal,
          surface: "jsonRpc",
        }),
        ...(options.observeNotification === undefined ? {} : { observeNotification: options.observeNotification }),
      });
      return result === undefined ? new Response(null, { status: 204 }) : dispatchResponse(result);
    },
  };
}

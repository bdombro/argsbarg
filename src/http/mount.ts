/*
REST-specific HTTP mount over one immutable catalog.
It owns the fixed /api claim, discovery, wire hooks, CORS, and trace finishing.
*/

import { randomUUID } from "node:crypto";
import type { HttpWireContext, HttpWireHooks, InvokeFailureKind } from "../core/types.ts";
import { extractTraceContext, formatTraceparent } from "../log/trace.ts";
import type { HttpMount, HttpMountContext } from "../server/listener.ts";
import { type OriginGateOptions, withOriginGate } from "../server/origin.ts";
import { dispatchHttpRequest } from "./dispatch.ts";
import { finishHttpResponse, httpErrorResponse } from "./encode.ts";
import { responseDocumentFormat } from "./media.ts";
import { generateHttpCatalogOpenApi, type HttpCatalogOpenApiOptions } from "./openapi.ts";
import { API_CORS_HEADERS, apiDocsHtml, apiOptionsResponse } from "./result.ts";
import type { HttpRouteCatalog } from "./routes.ts";

/** Safe transport facts available after one REST request completes. */
export interface HttpMountAccess {
  /** Native request method. */
  readonly method: string;
  /** Absolute mount-observed pathname. */
  readonly path: string;
  /** Final HTTP response status. */
  readonly status: number;
  /** Request duration in integer milliseconds. */
  readonly durationMs: number;
  /** Fresh request correlation identifier. */
  readonly requestId: string;
  /** Best-effort client address used by framework hooks and access logs. */
  readonly clientIp: string;
  /** Valid incoming W3C trace identifier, when supplied. */
  readonly traceId?: string;
  /** New W3C span identifier, when the request supplied valid trace state. */
  readonly spanId?: string;
}

/** Configuration for the package-internal REST mount. */
export interface HttpMountOptions<Seed extends object = Record<never, never>> extends OriginGateOptions {
  /** One immutable catalog shared by dispatch and discovery. */
  readonly catalog: HttpRouteCatalog;
  /** Stable OpenAPI document identity supplied by the future factory owner. */
  readonly identity: HttpCatalogOpenApiOptions;
  /** Optional HTTP wire hooks supplied by the resolved app configuration. */
  readonly hooks?: HttpWireHooks;
  /** Whether the forwarded client address may be used by wire hooks and access facts. */
  readonly trustProxy?: boolean;
  /** Creates fresh operation seed locals from one request's safe wire context. */
  readonly seedLocals?: (context: HttpWireContext) => Seed;
  /** Receives one completed access observation without response-body access. */
  readonly observeAccess?: (access: HttpMountAccess) => void;
}

/** Resolves the accepted proxy-aware client address without exposing transport objects. */
function resolveClientIp(request: Request, trustProxy: boolean): string {
  if (!trustProxy) return "unknown";
  const forwarded = request.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || "unknown";
}

/** Builds a generic terminal REST response without exposing internal exception text. */
function internalError(request: Request): Response {
  const format = responseDocumentFormat(request.headers.get("accept"));
  return httpErrorResponse(500, "INTERNAL_ERROR", "An unexpected error occurred", undefined, undefined, format);
}

/** Builds the only exact JSON discovery response owned by the REST mount. */
function openApiResponse(catalog: HttpRouteCatalog, identity: HttpCatalogOpenApiOptions): Response {
  return new Response(JSON.stringify(generateHttpCatalogOpenApi(catalog, identity)), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** Builds the only REST-owned HTML documentation response. */
function docsResponse(): Response {
  return new Response(apiDocsHtml("/api/openapi.json"), {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/**
 * Creates the exact REST mount for the fixed `/api` surface.
 *
 * The mount never consumes response bodies and retains the listener's request signal by identity.
 */
export function createHttpMount<Seed extends object = Record<never, never>>(
  /** Fixed catalog, wire policy, identity, and seed-local dependencies. */
  options: HttpMountOptions<Seed>,
): HttpMount {
  return withOriginGate("http.allowedOrigins", options, {
    claims: [{ kind: "prefix", path: "/api" }],
    async handle(request, context: HttpMountContext): Promise<Response> {
      const started = performance.now();
      const url = new URL(request.url);
      const trace = extractTraceContext(request);
      const wire: HttpWireContext = {
        request,
        requestId: randomUUID(),
        clientIp: resolveClientIp(request, options.trustProxy ?? false),
        path: url.pathname,
        method: request.method,
        ...(trace === undefined ? {} : { traceId: trace.traceId, spanId: trace.spanId }),
      };
      const access = (status: number): HttpMountAccess => ({
        method: request.method,
        path: url.pathname,
        status,
        durationMs: Math.round(performance.now() - started),
        requestId: wire.requestId,
        clientIp: wire.clientIp,
        ...(trace === undefined ? {} : { traceId: trace.traceId, spanId: trace.spanId }),
      });
      let onErrorCalled = false;

      const finish = (response: Response): Response =>
        finishHttpResponse(response, {
          cors: API_CORS_HEADERS,
          trace:
            trace === undefined
              ? undefined
              : {
                  traceparent: formatTraceparent({
                    traceId: trace.traceId,
                    spanId: trace.spanId,
                    sampled: trace.sampled,
                  }),
                },
        });

      const fail = async (
        error: unknown,
        failureKind: InvokeFailureKind = "unexpected",
        response = internalError(request),
      ): Promise<Response> => {
        if (!onErrorCalled) {
          onErrorCalled = true;
          try {
            await options.hooks?.onError?.({ ...wire, failureKind, error });
          } catch {
            // Error hooks are observe-only; their own failures must not replace the safe response.
          }
        }
        try {
          options.observeAccess?.(access(response.status));
        } catch {
          // Access observation is downstream I/O and cannot expose or replace the response.
        }
        return finish(response);
      };

      try {
        if (context.signal !== request.signal) {
          throw new TypeError("HTTP mount received a request signal different from the listener signal");
        }
        await options.hooks?.onRequest?.(wire);

        let response: Response;
        if (request.method === "OPTIONS") {
          response = apiOptionsResponse();
        } else if (request.method === "GET" && url.pathname === "/api/openapi.json") {
          response = openApiResponse(options.catalog, options.identity);
        } else if (request.method === "GET" && url.pathname === "/api/docs") {
          response = docsResponse();
        } else {
          const seed = {
            ...(options.seedLocals?.(wire) ?? ({} as Seed)),
            requestId: wire.requestId,
          } as Seed;
          response = await dispatchHttpRequest(options.catalog, request, {
            mountPath: "/api",
            locals: seed,
          });
        }

        if (response.status >= 500) {
          return fail(new Error("REST dispatch encoded a terminal response"), "unexpected", response);
        }

        try {
          await options.hooks?.onResponse?.({
            ...wire,
            status: response.status,
            durationMs: Math.round(performance.now() - started),
          });
        } catch (error) {
          return fail(error);
        }
        try {
          options.observeAccess?.(access(response.status));
        } catch {
          // Access observation is downstream I/O and cannot replace a successful response.
        }
        return finish(response);
      } catch (error) {
        return fail(error);
      }
    },
  });
}

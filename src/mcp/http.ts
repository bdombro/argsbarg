/*
Package-internal Streamable HTTP adapter for the MCP 2026 dispatcher.
It owns the exact /mcp mount, native HTTP framing, middleware, first-progress SSE, and request-local cancellation.
*/

import type { Denial, NameView } from "../core/invocation.ts";
import type { Locals } from "../core/types.ts";
import type { HttpMount, HttpMountContext } from "../server/listener.ts";
import type { McpDispatchResponse } from "./dispatcher.ts";
import { dispatchMcpRequestDetailed } from "./dispatcher.ts";
import {
  decodeMcpRequest,
  type McpErrorResponse,
  type McpRequest,
  type McpResultResponse,
  type McpServerInfo,
} from "./protocol.ts";
import { MCP_HANDLER_STARTED } from "./progress.ts";
import type { McpRegistry } from "./registry.ts";
import type { McpTaskRuntime } from "./tasks.ts";

/** Stable mount-local view of the MCP routing headers before the body is consumed. */
export interface McpHttpMiddlewareContext {
  /** Exact `Mcp-Method` value supplied by the caller. */
  readonly method: string;
  /** Exact `Mcp-Name` value, omitted when the caller did not supply it. */
  readonly name?: string;
  /** Case-insensitive name-only view over the native request headers. */
  readonly headers: NameView;
}

/** One middleware decision: a native response stops dispatch; fresh locals continue it. */
export type McpHttpMiddlewareResult<Seed extends object> =
  | {
      /** Continues with fresh verified request-local seed locals. */
      readonly kind: "next";
      /** Verified locals merged before D2 guard evaluation. */
      readonly locals: Seed;
    }
  | {
      /** Ends the request before body decoding or MCP dispatch. */
      readonly kind: "respond";
      /** Exact native HTTP response returned to the caller. */
      readonly response: Response;
    };

/** Mount-local middleware run before body consumption or MCP dispatch. */
export type McpHttpMiddleware<Seed extends object> = (
  /** Native request retained only at the HTTP middleware boundary. */
  request: Request,
  /** Parsed routing-header values and a non-enumerable credential source. */
  context: McpHttpMiddlewareContext,
) => McpHttpMiddlewareResult<Seed> | Promise<McpHttpMiddlewareResult<Seed>>;

/** Public MCP HTTP policy configuration. */
export interface McpHttpConfig<Seed extends object = Locals> {
  /** Optional pre-dispatch middleware that verifies and seeds one HTTP caller. */
  readonly middleware?: McpHttpMiddleware<Seed>;
}

/** Inputs for constructing the package-internal MCP HTTP mount. */
export interface CreateMcpHttpMountOptions<Seed extends object> {
  /** One fixed startup registry shared by discovery, listing, and calls. */
  readonly registry: McpRegistry<Seed>;
  /** Optional configured app-owned Tasks provider runtime. */
  readonly tasks?: McpTaskRuntime;
  /** Stable identity stamped into every encoded MCP result. */
  readonly serverInfo: McpServerInfo;
  /** Optional fixed discovery instructions. */
  readonly instructions?: string;
  /** Exact mount-local middleware callback. */
  readonly middleware?: McpHttpMiddleware<Seed>;
  /** Creates runtime-owned framework locals once for each accepted request. */
  readonly seedLocals?: () => Seed;
}

/** A first event from a request-local progress channel. */
interface ProgressEvent {
  /** Complete MCP notification ready for SSE framing. */
  readonly message: unknown;
}

/** One race outcome used to choose JSON or first-progress SSE. */
type DispatchRace =
  | {
      /** Dispatch reached its terminal protocol response first. */
      readonly kind: "terminal";
      /** Terminal protocol response, or `undefined` for a notification. */
      readonly response: McpDispatchResponse;
      /** Exact D2 outcome for a completed registered tool call. */
      readonly outcome?: import("../core/invocation.ts").InvocationOutcome<unknown>;
    }
  | {
      /** The request's first valid progress notification arrived first. */
      readonly kind: "progress";
      /** First queued progress event. */
      readonly event: ProgressEvent;
    }
  | {
      /** Unexpected dispatch failure that must not cross the HTTP boundary. */
      readonly kind: "failure";
    };

/** One manually controlled promise paired with its completion function. */
interface Deferred<T> {
  /** Promise observed by the HTTP adapter. */
  readonly promise: Promise<T>;
  /** Settles the promise exactly once. */
  readonly resolve: (value: T) => void;
}

/** Creates the exact `/mcp` mount around one accepted registry and dispatcher. */
export function createMcpHttpMount<Seed extends object>(options: CreateMcpHttpMountOptions<Seed>): HttpMount {
  return {
    claims: [{ kind: "exact", path: "/mcp" }],
    handle: (request, context) => handleMcpHttpRequest(options, request, context),
  };
}

/** Handles one exact mount request without importing Node listener transport state. */
async function handleMcpHttpRequest<Seed extends object>(
  options: CreateMcpHttpMountOptions<Seed>,
  request: Request,
  context: HttpMountContext,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  }

  const method = readRoutingHeader(request.headers, "Mcp-Method");
  if (method === undefined || method.length === 0) return requestError("Missing or invalid Mcp-Method header");
  const name = readRoutingHeader(request.headers, "Mcp-Name");
  if (name !== undefined && name.length === 0) return requestError("Invalid Mcp-Name header");
  const headers = headerView(new Headers(request.headers));

  let middlewareLocals: Seed = {} as Seed;
  if (options.middleware !== undefined) {
    let middlewareResult: unknown;
    try {
      middlewareResult = await options.middleware(request, {
        method,
        ...(name === undefined ? {} : { name }),
        headers,
      });
    } catch {
      return serverError();
    }
    if (!isMiddlewareResult<Seed>(middlewareResult)) return serverError();
    if (middlewareResult.kind === "respond") {
      if (!(middlewareResult.response instanceof Response)) return serverError();
      return middlewareResult.response;
    }
    middlewareLocals = middlewareResult.locals;
  }

  let body: unknown;
  try {
    body = JSON.parse(await request.text()) as unknown;
  } catch {
    return requestError("Invalid JSON request body");
  }

  const decoded = decodeMcpRequest(body);
  if (decoded.kind === "error") return jsonResponse(decoded.response, mcpProtocolHttpStatus(decoded.response));
  const headerError = validateMethodHeaders(decoded.request, method, name);
  if (headerError !== undefined) return requestError(headerError);

  const requestController = linkedController(context.signal);
  try {
    const firstProgress = deferred<ProgressEvent>();
    const progress = progressReporter(decoded.request, requestController.signal, firstProgress.resolve);
    const queuedProgress: ProgressEvent[] = [];
    let streamProgress: ((event: ProgressEvent) => void) | undefined;
    let terminal = false;
    const report = (event: ProgressEvent): void => {
      if (terminal) return;
      if (streamProgress === undefined) queuedProgress.push(event);
      else streamProgress(event);
    };
    progress.onEvent = report;

    const terminalPromise = dispatchMcpRequestDetailed({
      request: decoded.request,
      registry: options.registry,
      ...(options.tasks === undefined ? {} : { tasks: options.tasks }),
      base: {
        locals: Object.assign({}, middlewareLocals, options.seedLocals?.() ?? {}, {
          reportProgress: progress.reportProgress,
        }) as Seed,
        signal: requestController.signal,
        surface: "mcp",
        source: "http",
        headers,
      },
      serverInfo: options.serverInfo,
      ...(options.instructions === undefined ? {} : { instructions: options.instructions }),
    }).then(
      (detail): DispatchRace => ({
        kind: "terminal",
        response: detail.response,
        ...(detail.outcome === undefined ? {} : { outcome: detail.outcome }),
      }),
      (): DispatchRace => ({ kind: "failure" }),
    );

    const winner = await Promise.race<DispatchRace>([
      terminalPromise,
      firstProgress.promise.then((event): DispatchRace => ({ kind: "progress", event })),
    ]);
    if (winner.kind === "failure") {
      terminal = true;
      requestController.unlink();
      return serverError();
    }
    if (winner.kind === "terminal") {
      terminal = true;
      requestController.unlink();
      if (
        winner.outcome?.kind === "denied" &&
        (winner.outcome.denial.http !== undefined || winner.outcome.denial.challenge !== undefined)
      ) {
        return denialResponse(winner.outcome.denial);
      }
      return winner.response === undefined
        ? new Response(null, { status: 202 })
        : jsonResponse(winner.response, mcpProtocolHttpStatus(winner.response));
    }

    const stream = progressStream(
      winner.event,
      queuedProgress,
      terminalPromise,
      (send) => {
        streamProgress = send;
      },
      requestController,
      () => {
        terminal = true;
        requestController.unlink();
      },
    );
    return new Response(stream, {
      status: 200,
      headers: {
        "cache-control": "no-cache",
        "content-type": "text/event-stream",
      },
    });
  } catch {
    requestController.abort();
    requestController.unlink();
    return serverError();
  }
}

/** Builds a request-local reporter that validates monotonic progress and delivers one first event. */
function progressReporter(
  request: McpRequest,
  signal: AbortSignal,
  resolveFirst: (event: ProgressEvent) => void,
): {
  /** Reports one valid monotonic progress update. */
  reportProgress(progress: number, total?: number, message?: string): void;
  /** Receives later events after the first event has won the HTTP race. */
  onEvent: (event: ProgressEvent) => void;
} {
  const token = request.meta?.progressToken;
  let previous = -1;
  let first = true;
  let handlerStarted = false;
  const beforeHandler: ProgressEvent[] = [];
  const controls = {
    onEvent: (_event: ProgressEvent): void => {},
    reportProgress(progress: number, total?: number, message?: string): void {
      if (token === undefined || signal.aborted) return;
      if (
        !Number.isFinite(progress) ||
        progress < 0 ||
        progress <= previous ||
        (total !== undefined && (!Number.isFinite(total) || total < progress))
      ) {
        throw new TypeError("MCP progress must be finite, increasing, and no greater than total");
      }
      previous = progress;
      const event = {
        message: {
          jsonrpc: "2.0",
          method: "notifications/progress",
          params: {
            progressToken: token,
            progress,
            ...(total === undefined ? {} : { total }),
            ...(message === undefined ? {} : { message }),
          },
        },
      } as const;
      if (!handlerStarted) {
        beforeHandler.push(event);
      } else if (first) {
        first = false;
        resolveFirst(event);
      } else {
        controls.onEvent(event);
      }
    },
  };
  Object.defineProperty(controls.reportProgress, MCP_HANDLER_STARTED, {
    value: (): void => {
      if (handlerStarted) return;
      handlerStarted = true;
      if (beforeHandler.length === 0) return;
      first = false;
      const [firstEvent, ...rest] = beforeHandler.splice(0);
      if (firstEvent !== undefined) resolveFirst(firstEvent);
      for (const event of rest) controls.onEvent(event);
    },
  });
  return controls;
}

/** Creates an SSE body that emits queued progress followed by exactly one terminal MCP message. */
function progressStream(
  first: ProgressEvent,
  queued: ProgressEvent[],
  terminal: Promise<DispatchRace>,
  attach: (send: (event: ProgressEvent) => void) => void,
  requestController: AbortController & { unlink(): void },
  settle: () => void,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let closed = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const close = (): void => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // Stream cancellation is already terminal.
        }
      };
      const enqueue = (event: ProgressEvent): void => {
        if (closed) return;
        controller.enqueue(encodeSse(encoder, event.message));
      };
      enqueue(first);
      for (const event of queued.splice(0)) enqueue(event);
      attach(enqueue);
      void terminal.then(
        (outcome) => {
          if (closed) return;
          if (outcome.kind === "progress" || outcome.kind === "failure") {
            settle();
            close();
            return;
          }
          if (outcome.response === undefined) {
            settle();
            close();
            return;
          }
          enqueue({ message: outcome.response });
          settle();
          close();
        },
        () => {
          settle();
          close();
        },
      );
    },
    cancel(reason) {
      closed = true;
      requestController.abort(reason);
      requestController.unlink();
      settle();
    },
  });
}

/** Returns a native pre-SSE HTTP denial using D2 status, headers, and bearer challenge metadata. */
function denialResponse(denial: Denial): Response {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(denial.http?.headers ?? {}),
  };
  const challenge = bearerChallenge(denial);
  if (challenge !== undefined) headers["www-authenticate"] = challenge;
  return new Response(JSON.stringify({ error: { code: denial.code, message: denial.message } }), {
    status: denial.http?.status ?? 403,
    headers,
  });
}

/** Builds the accepted bearer challenge without exposing other denial metadata. */
function bearerChallenge(denial: Denial): string | undefined {
  if (denial.challenge === undefined) return undefined;
  const attributes: string[] = [];
  if (denial.challenge.error !== undefined) {
    attributes.push(`error="${quoteChallenge(denial.challenge.error)}"`);
  }
  if (denial.challenge.scopes !== undefined && denial.challenge.scopes.length > 0) {
    attributes.push(`scope="${quoteChallenge(denial.challenge.scopes.join(" "))}"`);
  }
  return `Bearer${attributes.length === 0 ? "" : ` ${attributes.join(", ")}`}`;
}

/** Escapes one quoted bearer challenge attribute. */
function quoteChallenge(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

/** Encodes one complete MCP message as one `data:` SSE event. */
function encodeSse(encoder: TextEncoder, message: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(message)}\n\n`);
}

/** Validates post-decode MCP routing header consistency. */
function validateMethodHeaders(request: McpRequest, method: string, name: string | undefined): string | undefined {
  if (request.method !== method) return "Mcp-Method does not match the MCP request method";
  const bodyName = request.params.name;
  if (request.method === "tools/call") {
    if (name === undefined) return "Missing Mcp-Name header";
    if (typeof bodyName !== "string" || name !== bodyName) return "Mcp-Name does not match the MCP tool name";
    return undefined;
  }
  if (
    (request.method === "server/discover" ||
      request.method === "tools/list" ||
      request.method === "initialize" ||
      request.method.startsWith("tasks/")) &&
    name !== undefined
  ) {
    return "Mcp-Name is not valid for this MCP method";
  }
  return undefined;
}

/** Returns a stable case-sensitive routing header value from Fetch headers. */
function readRoutingHeader(headers: Headers, name: string): string | undefined {
  return headers.get(name) ?? undefined;
}

/** Exposes only exact header lookup through the accepted D2 HTTP source contract. */
function headerView(headers: Headers): NameView {
  const view: NameView = {
    get: (name) => (typeof name === "string" ? (headers.get(name) ?? undefined) : undefined),
  };
  return Object.freeze(view);
}

/** Returns a native request-framing error without entering MCP dispatch. */
function requestError(message: string): Response {
  return jsonResponse({ error: message }, 400);
}

/** Returns a sanitized unexpected adapter failure. */
function serverError(): Response {
  return jsonResponse({ error: "Internal server error" }, 500);
}

/** Serializes one protocol or native JSON body with exact application/json media type. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Maps MCP-defined HTTP-bound protocol errors without changing ordinary JSON-RPC status. */
function mcpProtocolHttpStatus(response: McpErrorResponse | McpResultResponse): 200 | 400 {
  if (!("error" in response)) return 200;
  return response.error.code === -32_020 ||
    response.error.code === -32_021 ||
    response.error.code === -32_022
    ? 400
    : 200;
}

/** Creates a linked per-request controller and a one-shot listener unlink. */
function linkedController(signal: AbortSignal): AbortController & { abort: AbortController["abort"]; unlink(): void } {
  const controller = new AbortController();
  const abort = (): void => controller.abort(signal.reason);
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  let unlinked = false;
  return Object.assign(controller, {
    unlink(): void {
      if (unlinked) return;
      unlinked = true;
      signal.removeEventListener("abort", abort);
    },
  });
}

/** Creates a promise whose value can be supplied once by a request-local producer. */
function deferred<T>(): Deferred<T> {
  let resolveValue: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolveValue = resolve;
  });
  return {
    promise,
    resolve: (value) => {
      resolveValue?.(value);
      resolveValue = undefined;
    },
  };
}

/** Accepts only the exact middleware discriminated result branches. */
function isMiddlewareResult<Seed extends object>(
  value: unknown,
): value is McpHttpMiddlewareResult<Seed> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === "respond") return candidate.response instanceof Response;
  return (
    candidate.kind === "next" &&
    typeof candidate.locals === "object" &&
    candidate.locals !== null &&
    !Array.isArray(candidate.locals)
  );
}

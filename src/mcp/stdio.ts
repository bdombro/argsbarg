/*
Incremental MCP 2026 NDJSON transport over process stdio.
It owns framing, raw protocol writes, request cancellation, progress, and concurrent active calls.
*/

import type { Readable, Writable } from "node:stream";
import type { InvocationBase, NameView } from "../core/invocation.ts";
import { invocationScopeState } from "../runtime/invocation-scope.ts";
import { dispatchMcpRequest } from "./dispatcher.ts";
import {
  decodeMcpRequest,
  type McpRequest,
  type McpRequestId,
  type McpServerInfo,
  mcpErrorResponse,
} from "./protocol.ts";
import type { McpRegistry } from "./registry.ts";

/** Typed request-local progress control supplied in MCP seed locals. */
export interface McpProgressLocals {
  /** Emits one strictly increasing progress notification when the request opted in. */
  reportProgress(progress: number, total?: number, message?: string): void;
}

/** Factory inputs and injectable process streams owned by the stdio adapter. */
export interface McpStdioOptions<Seed extends object> {
  /** One immutable registry shared with listing and dispatch. */
  readonly registry: McpRegistry<Seed & McpProgressLocals>;
  /** Stable identity stamped into every MCP result. */
  readonly serverInfo: McpServerInfo;
  /** Optional fixed instructions returned by `server/discover`. */
  readonly instructions?: string;
  /** Creates fresh caller-independent locals for one decoded request. */
  createSeedLocals(request: McpRequest): Seed | Promise<Seed>;
  /** Injectable input; defaults to the process stdin stream. */
  readonly stdin?: Readable;
  /** Injectable raw output; defaults to the unpatched process stdout writer. */
  readonly stdout?: Writable;
  /** Injected lifecycle/log sink that must not use protocol stdout. */
  readonly emitLifecycle?: (message: string, action: string) => void;
  /** Optional adapter-lifecycle signal; aborting it rejects the loop and active calls. */
  readonly signal?: AbortSignal;
}

/** Tracks one active request and its exact typed cancellation controller. */
interface ActiveRequest {
  /** Controller aborted only for this request. */
  readonly controller: AbortController;
  /** Marks dispatch or response writing as terminal for progress. */
  terminal: boolean;
}

/** Writes complete protocol frames in order without blocking dispatch or decoding. */
interface FrameWriter {
  /** Queues one JSON message, optionally skipping it when its request became terminal. */
  enqueue(message: object, shouldWrite?: () => boolean): void;
  /** Waits until every accepted frame has completed or failed. */
  drain(): Promise<void>;
}

/** Runs the MCP 2026 NDJSON adapter until stdin EOF, abort, or a fatal loop/write failure. */
export async function serveMcpStdio<Seed extends object>(options: McpStdioOptions<Seed>): Promise<void> {
  const input = options.stdin ?? process.stdin;
  const output = options.stdout ?? process.stdout;
  const decoder = new TextDecoder();
  const scopeState = invocationScopeState();
  const previousOutsidePolicy = scopeState.stdoutOutsideToStderr;
  const env = processEnvView();
  const active = new Map<McpRequestId, ActiveRequest>();
  const running = new Set<Promise<void>>();
  let buffer = "";
  let loopFailure: unknown;
  let rejectFailure: (error: unknown) => void = () => {};
  const failure = new Promise<never>((_resolve, reject) => {
    rejectFailure = reject;
  });
  void failure.catch(() => {});

  scopeState.stdoutOutsideToStderr = true;
  const writer = createFrameWriter(output, output === process.stdout, scopeState.rawStdoutWrite, failure, fail);

  /** Converts arbitrary failures to the stable loop rejection value. */
  function asError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value));
  }

  /** Aborts all work and stops input after the first fatal failure. */
  function fail(value: unknown): void {
    if (loopFailure !== undefined) return;
    loopFailure = asError(value);
    rejectFailure(loopFailure);
    for (const request of active.values()) request.controller.abort(loopFailure);
    input.destroy(loopFailure instanceof Error ? loopFailure : new Error(String(loopFailure)));
  }

  /** Relays fatal stream and write errors into one exact loop failure. */
  function onOutputError(error: Error): void {
    fail(error);
  }

  /** Relays a caller lifecycle abort without treating ordinary EOF as cancellation. */
  function onAbort(): void {
    fail(options.signal?.reason ?? new Error("MCP stdio lifecycle aborted"));
  }

  output.on("error", onOutputError);
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener("abort", onAbort, { once: true });

  /** Starts one decoded notification or request without serializing handler execution. */
  function startRequest(request: McpRequest): void {
    const isNotification = request.id === undefined;
    if (!isNotification && request.id !== undefined) {
      if (active.has(request.id)) {
        writer.enqueue(mcpErrorResponse(request.id, -32_600, "Request ID is already in flight"));
        return;
      }
    }

    const requestState: ActiveRequest = { controller: new AbortController(), terminal: false };
    if (request.id !== undefined) active.set(request.id, requestState);
    const task = runRequest(request, requestState)
      .catch((error) => {
        fail(error);
        throw error;
      })
      .finally(() => {
        requestState.terminal = true;
        if (request.id !== undefined && active.get(request.id) === requestState) active.delete(request.id);
        running.delete(task);
      });
    running.add(task);
    void task.catch(() => {});
  }

  /** Runs one request base through the accepted registry/dispatcher boundary. */
  async function runRequest(request: McpRequest, requestState: ActiveRequest): Promise<void> {
    if (requestState.controller.signal.aborted) return;
    const seed = await options.createSeedLocals(request);
    if (requestState.controller.signal.aborted) return;
    let previousProgress = -1;

    const locals: Seed & McpProgressLocals = {
      ...seed,
      reportProgress: (progress, total, message) => {
        const progressToken = request.meta?.progressToken;
        if (requestState.terminal || requestState.controller.signal.aborted || progressToken === undefined) {
          return;
        }
        if (
          !Number.isFinite(progress) ||
          progress < 0 ||
          progress <= previousProgress ||
          (total !== undefined && (!Number.isFinite(total) || total < 0 || progress > total))
        ) {
          throw new RangeError("Progress must increase and must not exceed its finite total");
        }
        previousProgress = progress;
        writer.enqueue(
          {
            jsonrpc: "2.0",
            method: "notifications/progress",
            params: {
              progress,
              progressToken,
              ...(total === undefined ? {} : { total }),
              ...(message === undefined ? {} : { message }),
            },
          },
          () => !requestState.controller.signal.aborted,
        );
      },
    };
    const base: InvocationBase<Seed & McpProgressLocals> = {
      env,
      locals,
      signal: requestState.controller.signal,
      source: "local",
      surface: "mcp",
    };
    const response = await dispatchMcpRequest({
      base,
      instructions: options.instructions,
      registry: options.registry,
      request,
      serverInfo: options.serverInfo,
    });
    requestState.terminal = true;
    if (response !== undefined) {
      writer.enqueue(response, () => !requestState.controller.signal.aborted);
    }
  }

  /** Handles one complete NDJSON text frame through the pure MCP decoder. */
  function acceptFrame(line: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(line) as unknown;
    } catch {
      raw = undefined;
    }
    if (isRecord(raw) && raw.jsonrpc === "2.0" && !("id" in raw) && raw.method === "notifications/cancelled") {
      const decodedCancellation = decodeMcpRequest(raw);
      if (decodedCancellation.kind === "error") return;
      const params = decodedCancellation.request.params;
      const requestId = params?.requestId;
      const reason = params?.reason;
      if (
        (typeof requestId === "string" || (typeof requestId === "number" && Number.isSafeInteger(requestId))) &&
        (reason === undefined || typeof reason === "string")
      ) {
        active.get(requestId)?.controller.abort(reason);
      }
      return;
    }
    const decoded = decodeMcpRequest(line);
    if (decoded.kind === "error") {
      writer.enqueue(decoded.response);
      return;
    }
    const { request } = decoded;
    startRequest(request);
  }

  try {
    options.emitLifecycle?.("MCP stdio adapter ready", "mcp.server.ready");
    for await (const chunk of input) {
      if (loopFailure !== undefined) break;
      buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1 && loopFailure === undefined) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.length > 0) acceptFrame(line);
        newline = buffer.indexOf("\n");
      }
    }
    if (loopFailure === undefined) {
      const trailing = `${buffer}${decoder.decode()}`.trim();
      if (trailing.length > 0) acceptFrame(trailing);
    }
    const settled = await Promise.allSettled([...running]);
    const rejected = settled.find((result) => result.status === "rejected");
    if (loopFailure === undefined && rejected !== undefined && rejected.status === "rejected") {
      loopFailure = asError(rejected.reason);
    }
    await writer.drain();
    if (loopFailure !== undefined) throw loopFailure;
    options.emitLifecycle?.("MCP stdio adapter stopped", "mcp.server.stop");
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    output.off("error", onOutputError);
    for (const request of active.values()) {
      if (loopFailure !== undefined) request.controller.abort(loopFailure);
    }
    scopeState.stdoutOutsideToStderr = previousOutsidePolicy;
  }
}

/** Captures launch-owned string environment values behind a read-only name lookup. */
function processEnvView(): NameView {
  const snapshot = new Map(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  return Object.freeze({ get: (name: string) => snapshot.get(name) });
}

/** Checks for a non-null record without arrays. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Creates the serialized raw frame queue around a real or injected writable. */
function createFrameWriter(
  output: Writable,
  raw: boolean,
  rawWrite: (text: string) => boolean,
  failure: Promise<never>,
  fail: (error: unknown) => void,
): FrameWriter {
  let tail = Promise.resolve();
  let failed: unknown;

  /** Writes one already serialized complete frame and waits for backpressure. */
  const write = async (text: string): Promise<void> => {
    if (failed !== undefined) throw failed;
    if (raw) {
      let accepted: boolean;
      try {
        accepted = rawWrite(text);
      } catch (error) {
        fail(error);
        throw error;
      }
      if (!accepted) {
        await Promise.race([new Promise<void>((resolve) => output.once("drain", resolve)), failure]);
      }
      return;
    }

    let accepted = true;
    const written = Promise.race([
      new Promise<void>((resolve, reject) => {
        accepted = output.write(text, (error?: Error | null) => (error ? reject(error) : resolve()));
      }),
      failure,
    ]);
    const drained = accepted
      ? Promise.resolve()
      : Promise.race([new Promise<void>((resolve) => output.once("drain", resolve)), failure]);
    await Promise.all([written, drained]);
  };

  return {
    enqueue(message, shouldWrite = () => true) {
      const current = tail.then(async () => {
        if (failed !== undefined) throw failed;
        if (!shouldWrite()) return;
        await write(`${JSON.stringify(message)}\n`);
      });
      tail = current.catch((error) => {
        failed ??= error;
        fail(error);
      });
    },
    async drain() {
      await tail;
      if (failed !== undefined) throw failed;
    },
  };
}

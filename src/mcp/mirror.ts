/*
Package-internal MCP CLI mirrors for direct registry calls and exact-URL relays.
It preserves native MCP results and captured output without starting a listener or falling back locally.
*/

import type {
  CliCallEntry,
  CliCallResult,
  CliFailedCallResult,
  CliLocalCallContext as CliLocalCallContextShared,
  CliNativeCallResult,
} from "../cli/mirror.ts";
import { invokeMcpRegisteredTool, type McpRegisteredToolCall } from "./dispatcher.ts";
import {
  encodeMcpName,
  MCP_CLIENT_CAPABILITIES_KEY,
  MCP_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSION_KEY,
  type McpErrorResponse,
  type McpResultResponse,
  type McpServerInfo,
} from "./protocol.ts";
import type { McpRegistry } from "./registry.ts";

/** Parsed, transport-neutral input for one generated `mcp call` invocation. */
export interface McpCliCallInput {
  /** Exact case-sensitive registered tool name. */
  readonly name: string;
  /** Native JSON object supplied as MCP tool arguments. */
  readonly arguments: Readonly<Record<string, unknown>>;
}

/** One explicit caller-supplied relay header entry. */
export type CliRelayHeader = readonly [name: string, value: string];

/** Explicit sanitized relay headers accepted in the future shared CLI call shape. */
export type CliRelayHeaders = readonly CliRelayHeader[] | Readonly<Record<string, string>> | Headers;

/** Local MCP call source fixed by the generated CLI. */
export type McpCliLocalContext<Seed extends object> = CliLocalCallContextShared<Seed>;

/** Common relay fields fixed by the generated CLI. */
interface McpCliRelayFields {
  /** Selects one remote call with no local execution. */
  readonly mode: "relay";
  /** Already validated explicit headers; no ambient values are added. */
  readonly headers: CliRelayHeaders;
  /** Injected fetch implementation. */
  readonly fetch: typeof globalThis.fetch;
  /** Exact signal passed to the injected fetch. */
  readonly signal: AbortSignal;
}

/** Relay source accepting the shared URL name and the narrower endpoint alias. */
export type McpCliRelayContext = McpCliRelayFields &
  (
    | {
        /** Exact HTTP(S) MCP endpoint; no path is appended. */
        readonly url: URL;
        /** Endpoint alias is absent when using the shared URL field. */
        readonly endpoint?: never;
      }
    | {
        /** Narrow MCP endpoint spelling accepted during later CLI integration. */
        readonly endpoint: URL;
        /** Shared URL field is absent when using the MCP-specific spelling. */
        readonly url?: never;
      }
  );

/** Exclusive source contexts accepted by an MCP CLI call entry. */
export type McpCliCallContext<Seed extends object> = McpCliLocalContext<Seed> | McpCliRelayContext;

/** Shared-shape CLI context exported here until later factory integration owns the cross-surface type. */
export type CliCallContext<Seed extends object = object> = McpCliCallContext<Seed>;

/** Native MCP result or protocol error plus the captured invocation streams. */
export type McpCliNativeResult = CliNativeCallResult<McpResultResponse | McpErrorResponse>;

/** Client-safe failure before or during local/relay execution. */
export type McpCliCallFailure = CliFailedCallResult;

/** One package-internal generated-call registration. */
export type { CliCallEntry, CliCallResult } from "../cli/mirror.ts";

/** Fixed local and relay registrations for one configured MCP tool surface. */
export interface McpCliCalls<Seed extends object> {
  /** Exact local registry invocation path. */
  readonly local: CliCallEntry<McpCliCallInput, McpResultResponse | McpErrorResponse, McpCliLocalContext<Seed>>;
  /** Exact one-fetch relay path. */
  readonly relay: CliCallEntry<McpCliCallInput, McpResultResponse | McpErrorResponse, McpCliRelayContext>;
}

/** Inputs for constructing the MCP local and relay CLI entries. */
export interface CreateMcpCliCallsOptions<Seed extends object> {
  /** One fixed startup registry shared with the native MCP transports. */
  readonly registry: McpRegistry<Seed>;
  /** Stable identity encoded into local MCP results. */
  readonly serverInfo: McpServerInfo;
}

/** Creates exactly the direct registry and relay MCP registrations with no I/O at construction time. */
export function createMcpCliCalls<Seed extends object>(
  /** Registry and identity retained by both registrations. */
  options: CreateMcpCliCallsOptions<Seed>,
): McpCliCalls<Seed> {
  return Object.freeze({
    local: Object.freeze({
      invoke: (input: McpCliCallInput, context: McpCliLocalContext<Seed>) => invokeLocal(options, input, context),
    }),
    relay: Object.freeze({
      invoke: (input: McpCliCallInput, context: McpCliRelayContext) => invokeRelay(input, context),
    }),
  });
}

/** Invokes one exact local registry entry once and preserves D2's captured output. */
async function invokeLocal<Seed extends object>(
  options: CreateMcpCliCallsOptions<Seed>,
  input: McpCliCallInput,
  context: McpCliLocalContext<Seed>,
): Promise<CliCallResult<McpResultResponse | McpErrorResponse>> {
  if (context.signal.aborted) return failure("transport", "CALL_ABORTED", "MCP call was aborted");
  const entry = options.registry.lookup(input.name);
  if (entry === undefined) return failure("input", "MCP_TOOL_NOT_FOUND", "MCP tool is not registered");
  const call = await invokeMcpRegisteredTool(
    1,
    entry,
    input.arguments,
    {
      locals: { ...context.locals },
      signal: context.signal,
      surface: "mcp",
      source: "local",
      env: context.env,
    },
    options.serverInfo,
  );
  if (context.signal.aborted) {
    return failure("transport", "CALL_ABORTED", "MCP call was aborted", undefined, call.stdout, call.stderr);
  }
  return nativeFromCall(call);
}

/** Converts the narrow dispatcher result to the generated CLI result shape. */
function nativeFromCall(call: McpRegisteredToolCall): McpCliNativeResult {
  return {
    kind: "native",
    value: call.response,
    stdout: call.stdout,
    stderr: call.stderr,
  };
}

/** Sends one MCP tools/call envelope to the exact configured endpoint. */
async function invokeRelay(
  input: McpCliCallInput,
  context: McpCliRelayContext,
): Promise<CliCallResult<McpResultResponse | McpErrorResponse>> {
  if (context.signal.aborted) return failure("transport", "CALL_ABORTED", "MCP relay was aborted");
  let body: string;
  try {
    body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: input.name,
        arguments: input.arguments,
        _meta: {
          [MCP_PROTOCOL_VERSION_KEY]: MCP_PROTOCOL_VERSION,
          [MCP_CLIENT_CAPABILITIES_KEY]: {},
        },
      },
    });
  } catch {
    return failure("input", "INVALID_MCP_ARGUMENTS", "MCP arguments are not JSON serializable");
  }

  const headers = new Headers(context.headers as HeadersInit);
  headers.set("content-type", "application/json");
  headers.set("Accept", "application/json, text/event-stream");
  headers.set("MCP-Protocol-Version", MCP_PROTOCOL_VERSION);
  headers.set("Mcp-Method", "tools/call");
  headers.set("Mcp-Name", encodeMcpName(input.name));

  let response: Response;
  try {
    response = await context.fetch(context.url ?? context.endpoint, {
      method: "POST",
      body,
      headers,
      redirect: "manual",
      signal: context.signal,
    });
  } catch {
    return failure(
      "transport",
      context.signal.aborted ? "CALL_ABORTED" : "MCP_RELAY_FAILED",
      context.signal.aborted ? "MCP relay was aborted" : "MCP relay request failed",
    );
  }

  if (context.signal.aborted) return failure("transport", "CALL_ABORTED", "MCP relay was aborted");
  if (!response.ok) {
    return failure(
      "transport",
      "MCP_RELAY_HTTP_ERROR",
      "MCP relay returned an unsuccessful HTTP status",
      response.status,
    );
  }

  const isSse = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() === "text/event-stream";
  let decoded: McpResultResponse | McpErrorResponse | undefined;
  try {
    decoded =
      isSse && response.body !== null
        ? await readRelayEventStream(response.body, context.signal)
        : decodeMcpResponse(await response.json());
  } catch {
    return failure(
      "transport",
      context.signal.aborted ? "CALL_ABORTED" : "INVALID_MCP_RESPONSE",
      context.signal.aborted
        ? "MCP relay was aborted"
        : isSse
          ? "MCP relay returned a malformed event stream"
          : "MCP relay returned malformed JSON",
    );
  }
  if (context.signal.aborted) return failure("transport", "CALL_ABORTED", "MCP relay was aborted");
  if (decoded === undefined) {
    return failure("transport", "INVALID_MCP_RESPONSE", "MCP relay returned an invalid protocol response");
  }
  return { kind: "native", value: decoded, stdout: "", stderr: "" };
}

/** Reads the terminal response without waiting for the server to close the stream. */
async function readRelayEventStream(
  /** Body of the single relay response. */
  body: ReadableStream<Uint8Array>,
  /** Cancellation of this CLI invocation. */
  signal: AbortSignal,
): Promise<McpResultResponse | McpErrorResponse | undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let line = "";
  let afterCr = false;
  let data: string[] = [];
  /** Stops reading without waiting for a remote stream to finish. */
  const cancel = (): void => {
    void reader.cancel().catch(() => {}); // The body may already be errored or closed.
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done || signal.aborted) return undefined;
      const chunk = decoder.decode(value, { stream: true });
      if (chunk.length === 0) continue;
      let start = afterCr && chunk.startsWith("\n") ? 1 : 0;
      afterCr = chunk.endsWith("\r");
      for (const match of chunk.matchAll(/\r\n|\r|\n/g)) {
        const index = match.index;
        if (index < start) continue;
        line += chunk.slice(start, index);
        start = index + match[0].length;
        if (line === "") {
          if (data.length === 0) continue;
          const value: unknown = JSON.parse(data.join("\n"));
          data = [];
          if (
            isRecord(value) &&
            value.jsonrpc === "2.0" &&
            typeof value.method === "string" &&
            !Object.hasOwn(value, "id") &&
            !Object.hasOwn(value, "result") &&
            !Object.hasOwn(value, "error")
          ) {
            continue;
          }
          return decodeMcpResponse(value);
        }
        if (line === "data") data.push("");
        else if (line.startsWith("data:")) data.push(line.slice(line[5] === " " ? 6 : 5));
        line = "";
      }
      line += chunk.slice(start);
    }
    return undefined;
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}

/** Accepts only the complete 2026 tools/call result/error shape for request ID 1. */
function decodeMcpResponse(value: unknown): McpResultResponse | McpErrorResponse | undefined {
  if (!isRecord(value) || value.jsonrpc !== "2.0" || value.id !== 1) return undefined;
  const hasResult = Object.hasOwn(value, "result");
  const hasError = Object.hasOwn(value, "error");
  if (hasResult === hasError) return undefined;
  if (hasResult) {
    if (!isMcpToolResult(value.result)) return undefined;
    return value as unknown as McpResultResponse;
  }
  return isMcpProtocolError(value.error) ? (value as unknown as McpErrorResponse) : undefined;
}

/** Validates the complete result envelope emitted by the accepted MCP tools/call dispatcher. */
function isMcpToolResult(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || value.resultType !== "complete" || typeof value.isError !== "boolean") return false;
  if (!Array.isArray(value.content)) return false;
  for (const content of value.content) {
    if (!isRecord(content) || content.type !== "text" || typeof content.text !== "string") return false;
  }
  if (!isRecord(value._meta)) return false;
  const serverInfoKey = "io.modelcontextprotocol/serverInfo";
  const serverInfo = value._meta[serverInfoKey];
  if (!isRecord(serverInfo) || typeof serverInfo.name !== "string" || typeof serverInfo.version !== "string") {
    return false;
  }
  if (value.isError) {
    if (!isRecord(value.structuredContent) || !isRecord(value.structuredContent.error)) return false;
    return (
      typeof value.structuredContent.error.code === "string" &&
      typeof value.structuredContent.error.message === "string"
    );
  }
  return !Object.hasOwn(value, "structuredContent") || isJsonValue(value.structuredContent);
}

/** Validates the accepted JSON-RPC protocol error envelope. */
function isMcpProtocolError(value: unknown): boolean {
  if (!isRecord(value) || typeof value.code !== "number" || !Number.isSafeInteger(value.code)) return false;
  if (typeof value.message !== "string") return false;
  return !Object.hasOwn(value, "data") || isJsonValue(value.data);
}

/** Rejects values that cannot be represented by one MCP JSON payload. */
function isJsonValue(value: unknown, seen: Set<object> = new Set()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((member) => isJsonValue(member, seen))
    : Object.entries(value).every(([key, member]) => key.length >= 0 && isJsonValue(member, seen));
  seen.delete(value);
  return valid;
}

/** Creates one sanitized CLI failure without any dynamic source or transport detail. */
function failure(
  category: McpCliCallFailure["category"],
  code: string,
  message: string,
  status?: number,
  stdout = "",
  stderr = "",
): McpCliCallFailure {
  return {
    kind: "failure",
    category,
    code,
    message,
    ...(status === undefined ? {} : { status }),
    stdout,
    stderr,
  };
}

/** Tests for a non-null, non-array JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

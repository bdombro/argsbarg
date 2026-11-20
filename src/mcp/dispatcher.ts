/*
Transport-neutral routing for MCP 2026 discovery, catalog listing, and tool calls.
It performs exact registry lookup and is the only bridge from decoded protocol data to D2 invocation.
*/

import { AppError } from "../core/errors.ts";
import type { InvocationBase, InvocationOutcome } from "../core/invocation.ts";
import {
  encodeMcpResult,
  MCP_CACHE_POLICY,
  MCP_PROTOCOL_VERSION,
  type McpErrorResponse,
  type McpRequest,
  type McpRequestId,
  type McpResultResponse,
  type McpServerInfo,
  mcpErrorResponse,
} from "./protocol.ts";
import type { McpRegisteredTool, McpRegistry } from "./registry.ts";
import {
  encodeMcpTaskReference,
  isMcpTaskReference,
  MCP_TASKS_EXTENSION,
  type McpTaskAccess,
  type McpTaskRuntime,
  unavailableMcpTaskAccess,
} from "./tasks.ts";

/** Fixed server capabilities advertised by this MCP-only slice. */
export const MCP_CAPABILITIES = Object.freeze({ tools: Object.freeze({}) });

/** Inputs owned by the stateless MCP dispatcher. */
export interface McpDispatchRequest<Seed extends object> {
  /** Already decoded and validated MCP request or notification. */
  readonly request: McpRequest;
  /** One fixed startup registry used for both listing and invocation. */
  readonly registry: McpRegistry<Seed>;
  /** Adapter-owned source, fresh seed locals, signal, and MCP surface. */
  readonly base: InvocationBase<Seed>;
  /** Server identity stamped into every encoded result. */
  readonly serverInfo: McpServerInfo;
  /** Optional fixed server instructions in discovery. */
  readonly instructions?: string;
  /** Optional configured app-owned Tasks provider runtime. */
  readonly tasks?: McpTaskRuntime;
}

/** Transport-neutral response emitted for a request, or `undefined` for a notification. */
export type McpDispatchResponse = McpErrorResponse | McpResultResponse | undefined;

/** Routes one decoded MCP request through discovery, listing, or one native-bound invocation. */
export async function dispatchMcpRequest<Seed extends object>(
  /** Decoded request and all adapter-owned dispatch inputs. */
  dispatch: McpDispatchRequest<Seed>,
): Promise<McpDispatchResponse> {
  return (await dispatchMcpRequestDetailed(dispatch)).response;
}

/** Routes one request while retaining the exact terminal D2 outcome for native HTTP admission encoding. */
export async function dispatchMcpRequestDetailed<Seed extends object>(
  /** Decoded request and all adapter-owned dispatch inputs. */
  dispatch: McpDispatchRequest<Seed>,
): Promise<McpDispatchResult> {
  const { request } = dispatch;
  if (request.id === undefined) return { response: undefined };

  if (request.method === "initialize") {
    return {
      response: mcpErrorResponse(request.id, -32_022, "Unsupported protocol version: initialize is not supported", {
        supported: [MCP_PROTOCOL_VERSION],
      }),
    };
  }
  if ("cursor" in request.params) {
    return {
      response: mcpErrorResponse(request.id, -32_602, "Invalid params: pagination cursors are not issued by this server"),
    };
  }

  if (request.method === "server/discover") {
    return {
      response: encodeMcpResult(
        request.id,
        {
          ...MCP_CACHE_POLICY,
          supportedVersions: [MCP_PROTOCOL_VERSION],
          capabilities:
            dispatch.tasks === undefined
              ? MCP_CAPABILITIES
              : Object.freeze({
                  ...MCP_CAPABILITIES,
                  extensions: Object.freeze({ [MCP_TASKS_EXTENSION]: Object.freeze({}) }),
                }),
          ...(dispatch.instructions === undefined ? {} : { instructions: dispatch.instructions }),
        },
        dispatch.serverInfo,
      ),
    };
  }
  if (request.method === "tools/list") {
    return {
      response: encodeMcpResult(
        request.id,
        {
          ...MCP_CACHE_POLICY,
          tools: dispatch.registry.list(),
        },
        dispatch.serverInfo,
      ),
    };
  }
  if (request.method === "tasks/get" || request.method === "tasks/update" || request.method === "tasks/cancel") {
    if (dispatch.tasks === undefined) {
      return { response: mcpErrorResponse(request.id, -32_601, "Method not found") };
    }
    return dispatch.tasks.dispatch(request, dispatch.base, dispatch.serverInfo);
  }
  if (request.method !== "tools/call") {
    return { response: mcpErrorResponse(request.id, -32_601, "Method not found") };
  }

  const name = request.params.name;
  if (typeof name !== "string") {
    return { response: mcpErrorResponse(request.id, -32_602, "Invalid params: name is required") };
  }
  const argumentsValue = request.params.arguments === undefined ? {} : request.params.arguments;
  if (!isRecord(argumentsValue)) {
    return {
      response: mcpErrorResponse(request.id, -32_602, "Invalid params: arguments must be an object"),
    };
  }

  const entry = dispatch.registry.lookup(name);
  if (entry === undefined) {
    return { response: mcpErrorResponse(request.id, -32_602, `Unknown tool: ${name}`) };
  }
  const call = await invokeMcpRegisteredTool(
    request.id,
    entry,
    argumentsValue,
    dispatch.base,
    dispatch.serverInfo,
    dispatch.tasks?.access(request, entry.name),
  );
  return {
    response: call.response,
    ...(call.outcome === undefined ? {} : { outcome: call.outcome }),
  };
}

/** Complete protocol response plus any D2 outcome produced by a selected tool call. */
export interface McpDispatchResult {
  /** Native MCP response, or `undefined` for a notification. */
  readonly response: McpDispatchResponse;
  /** Exact D2 outcome when argument unwrapping reached registered invocation. */
  readonly outcome?: InvocationOutcome<unknown>;
}

/** Unique marker returned when a declared wire wrapper is malformed. */
const invalidInputs = Symbol("invalid MCP wrapped inputs");

/** One native MCP response plus output captured from the exact D2 invocation. */
export interface McpRegisteredToolCall {
  /** Complete native MCP JSON-RPC response. */
  readonly response: McpResultResponse | McpErrorResponse;
  /** Exact D2 outcome for transport-level denial encoding. */
  readonly outcome?: InvocationOutcome<unknown>;
  /** Stdout captured by the local invocation. */
  readonly stdout: string;
  /** Stderr captured by the local invocation. */
  readonly stderr: string;
}

/** Invokes one preselected registry entry and exposes its native result with captured output. */
export async function invokeMcpRegisteredTool<Seed extends object>(
  /** Exact caller request ID retained by the native response. */
  id: McpRequestId,
  /** Exact immutable entry selected by the registry. */
  entry: McpRegisteredTool<Seed>,
  /** Validated MCP tool arguments object. */
  argumentsValue: Record<string, unknown>,
  /** Fresh source, locals, signal, and MCP surface for this invocation. */
  base: InvocationBase<Seed>,
  /** Stable identity encoded in local result metadata. */
  serverInfo: McpServerInfo,
  /** Capability-aware MCP Tasks helper exposed to the tool handler. */
  tasks: McpTaskAccess = unavailableMcpTaskAccess(),
): Promise<McpRegisteredToolCall> {
  const rawInputs = unwrapInputs(entry, argumentsValue);
  if (rawInputs === invalidInputs) {
    return {
      response: mcpErrorResponse(id, -32_602, 'Invalid params: wrapped input must contain exactly one "input" key'),
      stdout: "",
      stderr: "",
    };
  }
  const outcome = await entry.invoke(rawInputs, base, tasks);
  return {
    response: encodeCallOutcome(id, entry, outcome, serverInfo),
    outcome,
    stdout: outcome.stdout,
    stderr: outcome.stderr,
  };
}

/** Unwraps only the object-root marker declared by the registered entry. */
function unwrapInputs(
  entry: McpRegisteredTool,
  argumentsValue: Record<string, unknown>,
): unknown | typeof invalidInputs {
  if (!entry.inputWrapped) return argumentsValue;
  const keys = Object.keys(argumentsValue);
  if (keys.length !== 1 || keys[0] !== "input") return invalidInputs;
  return argumentsValue.input;
}

/** Encodes D2's exact terminal outcome as an MCP-native complete tool result or failure. */
function encodeCallOutcome(
  id: McpRequestId,
  entry: McpRegisteredTool,
  outcome: InvocationOutcome<unknown>,
  serverInfo: McpServerInfo,
): McpResultResponse {
  if (outcome.kind !== "ok") return encodeFailure(id, outcome, serverInfo);

  try {
    if (isMcpTaskReference(outcome.result)) {
      return encodeMcpTaskReference(id, outcome.result, serverInfo);
    }
    const structuredValue = entry.outputWrapped ? { result: outcome.result } : outcome.result;
    const text = formatContentText(structuredValue);
    const result: Record<string, unknown> = {
      content: [{ type: "text", text }],
      isError: false,
      ...(structuredValue === undefined ? {} : { structuredContent: structuredValue }),
    };
    JSON.stringify(result);
    return encodeMcpResult(id, result, serverInfo);
  } catch (error) {
    return encodeToolFailure(
      id,
      {
        code: "SERIALIZATION_ERROR",
        message: error instanceof Error ? error.message : "Handler result is not JSON serializable",
      },
      serverInfo,
    );
  }
}

/** Converts invalid, denied, and thrown D2 outcomes to MCP tool failures without credential disclosure. */
function encodeFailure(
  id: McpRequestId,
  outcome: Exclude<InvocationOutcome<unknown>, { readonly kind: "ok" }>,
  serverInfo: McpServerInfo,
): McpResultResponse {
  if (outcome.kind === "denied") {
    return encodeToolFailure(
      id,
      {
        code: outcome.denial.code,
        message: outcome.denial.message,
        ...(outcome.denial.http === undefined ? {} : { http: outcome.denial.http }),
        ...(outcome.denial.challenge === undefined ? {} : { challenge: outcome.denial.challenge }),
      },
      serverInfo,
    );
  }
  if (outcome.kind === "invalid") {
    return encodeToolFailure(
      id,
      { code: "INVALID_INPUT", message: "Invalid tool arguments", details: outcome.error.issues },
      serverInfo,
    );
  }
  if (outcome.error instanceof AppError) {
    return encodeToolFailure(
      id,
      {
        code: outcome.error.code,
        message: outcome.error.message,
        ...(outcome.error.details === undefined ? {} : { details: outcome.error.details }),
      },
      serverInfo,
    );
  }
  return encodeToolFailure(id, { code: "INTERNAL_ERROR", message: "Tool execution failed" }, serverInfo);
}

/** Builds a complete `tools/call` error result; `isError` remains inside a successful JSON-RPC result. */
function encodeToolFailure(
  id: McpRequestId,
  error: Readonly<Record<string, unknown>>,
  serverInfo: McpServerInfo,
): McpResultResponse {
  const message = String(error.message);
  const result = {
    content: [{ type: "text" as const, text: message }],
    structuredContent: { error },
    isError: true,
  };
  try {
    JSON.stringify(result);
  } catch {
    return encodeMcpResult(
      id,
      {
        content: [{ type: "text", text: "Tool execution failed" }],
        structuredContent: { error: { code: "INTERNAL_ERROR", message: "Tool execution failed" } },
        isError: true,
      },
      serverInfo,
    );
  }
  return encodeMcpResult(id, result, serverInfo);
}

/** Formats a JSON text block while keeping strings unquoted. */
function formatContentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  const encoded = JSON.stringify(value);
  return encoded === undefined ? "" : encoded;
}

/** Checks for a plain protocol argument object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

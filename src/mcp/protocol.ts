/*
Pure MCP 2026 JSON-RPC envelope decoding and result/error encoding.
This module performs no registry lookup, invocation, transport I/O, or source access.
*/

/** The sole MCP protocol revision served by the v9 core. */
export const MCP_PROTOCOL_VERSION = "2026-07-28" as const;

/** Required metadata key carrying the request protocol revision. */
export const MCP_PROTOCOL_VERSION_KEY = "io.modelcontextprotocol/protocolVersion" as const;

/** Required metadata key carrying the request client capabilities. */
export const MCP_CLIENT_CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities" as const;

/** Optional result metadata key carrying server identity. */
export const MCP_SERVER_INFO_KEY = "io.modelcontextprotocol/serverInfo" as const;

/** Fixed discovery and catalog cache policy selected by DP-23. */
export const MCP_CACHE_POLICY = Object.freeze({ ttlMs: 3_600_000, cacheScope: "public" as const });

/** JSON-RPC ID values accepted by the 2026 profile. */
export type McpRequestId = string | number;

/** Server identity emitted in result metadata. */
export interface McpServerInfo {
  /** Stable application server name. */
  readonly name: string;
  /** Stable application version. */
  readonly version: string;
}

/** Client implementation identity carried in request metadata. */
export interface McpClientInfo {
  /** Client implementation name. */
  readonly name: string;
  /** Client implementation version. */
  readonly version: string;
}

/** Validated metadata common to every served 2026 request. */
export interface McpRequestMeta {
  /** Exact supported protocol revision. */
  readonly protocolVersion: typeof MCP_PROTOCOL_VERSION;
  /** Caller-declared feature capabilities. */
  readonly clientCapabilities: Readonly<Record<string, unknown>>;
  /** Optional client implementation identity. */
  readonly clientInfo?: McpClientInfo;
  /** Optional progress token preserved for adapter-owned progress reporting. */
  readonly progressToken?: string | number;
}

/** Decoded JSON-RPC request or notification accepted for method routing. */
export interface McpRequest {
  /** JSON-RPC envelope version. */
  readonly jsonrpc: "2.0";
  /** Absent only for a notification. */
  readonly id?: McpRequestId;
  /** MCP method name. */
  readonly method: string;
  /** Validated method params, including the original `_meta` envelope value. */
  readonly params: Readonly<Record<string, unknown>>;
  /** Validated common metadata when present; `initialize` intentionally has none. */
  readonly meta?: McpRequestMeta;
}

/** One JSON-RPC protocol error body. */
export interface McpProtocolError {
  /** JSON-RPC numeric error code. */
  readonly code: number;
  /** Stable human-readable protocol message. */
  readonly message: string;
  /** Optional structured protocol details. */
  readonly data?: unknown;
}

/** JSON-RPC error envelope emitted by the protocol decoder or dispatcher. */
export interface McpErrorResponse {
  /** JSON-RPC envelope version. */
  readonly jsonrpc: "2.0";
  /** Request ID, or `null` when no usable ID exists. */
  readonly id: McpRequestId | null;
  /** Protocol error body. */
  readonly error: McpProtocolError;
}

/** JSON-RPC result envelope emitted for a complete MCP result. */
export interface McpResultResponse<Result = unknown> {
  /** JSON-RPC envelope version. */
  readonly jsonrpc: "2.0";
  /** Exact request ID. */
  readonly id: McpRequestId;
  /** Complete protocol result with method-owned fields. */
  readonly result: Result;
}

/** Successful decode or a protocol error that did not reach dispatch. */
export type McpDecodeResult =
  | {
      /** Identifies a valid request or notification. */
      readonly kind: "request";
      /** Validated protocol request. */
      readonly request: McpRequest;
    }
  | {
      /** Identifies an envelope/protocol failure. */
      readonly kind: "error";
      /** JSON-RPC error response. */
      readonly response: McpErrorResponse;
    };

/** Complete MCP result discriminator stamped on every result value. */
export type McpCompleteResult = {
  /** Current result state for this non-Tasks slice. */
  readonly resultType: "complete";
  /** Result metadata containing stable server identity. */
  readonly _meta: {
    /** Stable 2026 server identity field. */
    readonly [MCP_SERVER_INFO_KEY]: McpServerInfo;
  };
} & Readonly<Record<string, unknown>>;

/** Decodes a JSON string or unknown JSON value into the v9 MCP request profile. */
export function decodeMcpRequest(
  input: unknown,
  /** Validates HTTP routing headers after envelope parsing but before version negotiation. */
  checkHeaders?: (method: string, params: Readonly<Record<string, unknown>>) => string | undefined,
): McpDecodeResult {
  let value = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input) as unknown;
    } catch {
      return protocolError(null, -32_700, "Parse error");
    }
  }

  if (!isRecord(value) || Array.isArray(value)) return protocolError(null, -32_600, "Invalid Request");
  const id = readEnvelopeId(value);
  if (id.invalid) return protocolError(null, -32_600, "Invalid Request");
  if (
    value.jsonrpc !== "2.0" ||
    typeof value.method !== "string" ||
    value.method.length === 0 ||
    "result" in value ||
    "error" in value
  ) {
    return protocolError(id.value, -32_600, "Invalid Request");
  }

  const paramsValue = value.params === undefined ? {} : value.params;
  if (!isRecord(paramsValue) || Array.isArray(paramsValue)) {
    return protocolError(id.value, -32_602, "Invalid params: params must be an object");
  }
  const params = paramsValue;

  const mismatch = checkHeaders?.(value.method, params);
  if (mismatch !== undefined) return protocolError(id.value, -32_020, mismatch);

  if (value.method === "initialize") {
    return {
      kind: "request",
      request: { jsonrpc: "2.0", ...(id.value === null ? {} : { id: id.value }), method: value.method, params },
    };
  }

  const metaValue = params._meta;
  if (id.value === null && (metaValue === undefined || isRecord(metaValue))) {
    return { kind: "request", request: { jsonrpc: "2.0", method: value.method, params } };
  }
  if (!isRecord(metaValue) || Array.isArray(metaValue)) {
    return protocolError(id.value, -32_602, "Invalid params: _meta must be an object");
  }
  const protocolVersion = metaValue[MCP_PROTOCOL_VERSION_KEY];
  const clientCapabilities = metaValue[MCP_CLIENT_CAPABILITIES_KEY];
  if (typeof protocolVersion !== "string") {
    return protocolError(id.value, -32_602, "Invalid params: protocol version must be a string");
  }
  if (protocolVersion !== MCP_PROTOCOL_VERSION) {
    return protocolError(id.value, -32_022, `Unsupported protocol version: ${protocolVersion}`, {
      supported: [MCP_PROTOCOL_VERSION],
      requested: protocolVersion,
    });
  }
  if (!isRecord(clientCapabilities) || Array.isArray(clientCapabilities)) {
    return protocolError(id.value, -32_602, "Invalid params: client capabilities must be an object");
  }

  const clientInfoValue = metaValue[MCP_CLIENT_INFO_KEY];
  if (
    clientInfoValue !== undefined &&
    (!isRecord(clientInfoValue) ||
      typeof clientInfoValue.name !== "string" ||
      typeof clientInfoValue.version !== "string")
  ) {
    return protocolError(id.value, -32_602, "Invalid params: client info must be an implementation object");
  }
  const progressToken = metaValue.progressToken;
  if (
    progressToken !== undefined &&
    typeof progressToken !== "string" &&
    (typeof progressToken !== "number" || !Number.isSafeInteger(progressToken))
  ) {
    return protocolError(id.value, -32_602, "Invalid params: progress token must be a string or integer");
  }

  return {
    kind: "request",
    request: {
      jsonrpc: "2.0",
      ...(id.value === null ? {} : { id: id.value }),
      method: value.method,
      params,
      meta: {
        protocolVersion,
        clientCapabilities,
        ...(clientInfoValue === undefined
          ? {}
          : { clientInfo: { name: clientInfoValue.name, version: clientInfoValue.version } as McpClientInfo }),
        ...(progressToken === undefined ? {} : { progressToken }),
      },
    },
  };
}

/** The extension makes the public task ID the HTTP routing name for these methods. */
export function isMcpTaskMethod(method: string): boolean {
  return method === "tasks/get" || method === "tasks/update" || method === "tasks/cancel";
}

/** Encodes a routed name that cannot be carried verbatim as an HTTP field value. */
export function encodeMcpName(name: string): string {
  return /^[\x20-\x7e\t]*$/.test(name) && name.trim() === name &&
    !(name.startsWith("=?base64?") && name.endsWith("?="))
    ? name
    : `=?base64?${Buffer.from(name, "utf8").toString("base64")}?=`;
}

/** Decodes the routing sentinel, rejecting invalid Base64 or UTF-8. */
export function decodeMcpName(name: string): string | undefined {
  if (!name.startsWith("=?base64?") || !name.endsWith("?=")) {
    return /^[\x20-\x7e\t]*$/.test(name) ? name : undefined;
  }
  const encoded = name.slice("=?base64?".length, -2);
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** Builds a JSON-RPC protocol error envelope. */
export function mcpErrorResponse(
  /** Usable request ID, or `null` for parse/envelope failures. */
  id: McpRequestId | null,
  /** JSON-RPC numeric error code. */
  code: number,
  /** Stable error message. */
  message: string,
  /** Optional structured error data. */
  data?: unknown,
): McpErrorResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}

/** Encodes a complete MCP result and stamps server identity in result metadata. */
export function encodeMcpResult<Result extends Readonly<Record<string, unknown>>>(
  /** Exact request ID. */
  id: McpRequestId,
  /** Method-owned complete result fields. */
  result: Result,
  /** Stable server identity supplied by the adapter owner. */
  serverInfo: McpServerInfo,
): McpResultResponse<McpCompleteResult & Result> {
  const { resultType: _resultType, _meta: _requestMeta, ...methodResult } = result;
  return {
    jsonrpc: "2.0",
    id,
    result: {
      resultType: "complete",
      ...methodResult,
      _meta: {
        [MCP_SERVER_INFO_KEY]: { name: serverInfo.name, version: serverInfo.version },
      },
    } as McpCompleteResult & Result,
  };
}

/** Optional request metadata key carrying the client implementation identity. */
const MCP_CLIENT_INFO_KEY = "io.modelcontextprotocol/clientInfo" as const;

/** Creates a decode failure union without exposing a decoded request. */
function protocolError(id: McpRequestId | null, code: number, message: string, data?: unknown): McpDecodeResult {
  return { kind: "error", response: mcpErrorResponse(id, code, message, data) };
}

/** Extracts an envelope ID while distinguishing omission from an invalid supplied value. */
function readEnvelopeId(value: Record<string, unknown>): {
  readonly invalid: boolean;
  readonly value: McpRequestId | null;
} {
  if (!("id" in value)) return { invalid: false, value: null };
  const id = value.id;
  if (typeof id === "string" || (typeof id === "number" && Number.isSafeInteger(id))) {
    return { invalid: false, value: id };
  }
  return { invalid: true, value: null };
}

/** Checks for a non-null object without accepting arrays through later record narrowing. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

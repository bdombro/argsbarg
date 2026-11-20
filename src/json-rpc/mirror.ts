/*
In-process and relayed JSON-RPC calls for the generated CLI surface.
They preserve the native method outcome and captured output without opening a listener or falling back locally.
*/

import type {
  CliCallEntry,
  CliCallResult,
  CliFailedCallResult,
  CliLocalCallContext as CliLocalCallContextShared,
  CliNativeCallResult,
  CliRelayCallContext as CliRelayCallContextShared,
} from "../cli/mirror.ts";
import type { JsonRpcCatalog } from "./catalog.ts";
import {
  invokeJsonRpcMethodWithOutput,
  type JsonRpcErrorObject,
  type JsonRpcMethodOutcome,
  type JsonRpcNotificationObservation,
  type JsonValue,
  strictJsonValue,
} from "./dispatch.ts";

/** Native params accepted by the generated RPC command's single JSON document. */
export type JsonRpcMirrorParams = Record<string, unknown> | unknown[];

/** Parsed, catalog-selected JSON-RPC method input supplied to a mirror entry. */
export interface JsonRpcMirrorInput {
  /** Exact, case-sensitive registered method name. */
  readonly method: string;
  /** Omitted params, or one structured JSON object/array. */
  readonly params?: JsonRpcMirrorParams;
}

/** Safe package-internal failure returned by a mirror transport or invalid local input. */
export type CliCallFailure = CliFailedCallResult;

/** One native mirror success or native protocol/application error. */
export type CliCallNative<Native> = CliNativeCallResult<Native>;

/** Context for a direct invocation with one process-local credential source. */
export type CliLocalCallContext<Seed extends object = object> = CliLocalCallContextShared<Seed>;

/** Explicit relay headers already parsed and sanitized by the generated CLI. */
export type CliRelayHeaders = ReadonlyArray<readonly [name: string, value: string]>;

/** Context for one remote call with no local source or fallback path. */
export type CliRelayCallContext = CliRelayCallContextShared;

/** Discriminated package-internal mirror context. */
export type CliCallContext<Seed extends object = object> = CliLocalCallContext<Seed> | CliRelayCallContext;

/** One generated CLI registration that accepts parsed input and one matching source context. */
export type { CliCallEntry, CliCallResult } from "../cli/mirror.ts";

/** Two fixed generated registrations for the configured JSON-RPC surface. */
export interface JsonRpcMirrorEntries<Seed extends object = object> {
  /** Direct catalog invocation with env-only credentials. */
  readonly local: CliCallEntry<JsonRpcMirrorInput, JsonRpcMethodOutcome, CliLocalCallContext<Seed>>;
  /** One exact-URL fetch with no catalog lookup or local fallback. */
  readonly relay: CliCallEntry<JsonRpcMirrorInput, JsonRpcMethodOutcome, CliRelayCallContext>;
}

/** Stable error used when a relay receives an invalid protocol envelope. */
const INVALID_RELAY_RESPONSE = Object.freeze({
  code: "CALL_PROTOCOL_ERROR",
  message: "JSON-RPC relay returned an invalid response",
});

/** Returns a credential-safe normalized status or `undefined`. */
function sanitizedStatus(status: number): number | undefined {
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
}

/** Constructs one failure without exposing causes, URLs, bodies, headers, or credentials. */
function failure(
  /** Failure ownership category. */
  category: CliCallFailure["category"],
  /** Stable public-safe code. */
  code: string,
  /** Stable public-safe message. */
  message: string,
  /** Optional validated HTTP status. */
  status?: number,
  /** Captured invocation streams. */
  streams: { readonly stdout: string; readonly stderr: string } = { stdout: "", stderr: "" },
): CliCallFailure {
  const safeStatus = status === undefined ? undefined : sanitizedStatus(status);
  return {
    kind: "failure",
    category,
    code,
    message,
    ...(safeStatus === undefined ? {} : { status: safeStatus }),
    stdout: streams.stdout,
    stderr: streams.stderr,
  };
}

/** Returns a compact native call result with its captured streams. */
function native(value: JsonRpcMethodOutcome, stdout = "", stderr = ""): CliCallNative<JsonRpcMethodOutcome> {
  return { kind: "native", value, stdout, stderr };
}

/** Invokes one exact catalog method with a local env source and the caller's exact signal. */
export async function invokeJsonRpcLocal<Seed extends object>(
  /** Fixed catalog shared with the HTTP mount and discovery. */
  catalog: JsonRpcCatalog<Seed>,
  /** One exact method and parsed structured params. */
  input: JsonRpcMirrorInput,
  /** Fresh local source, seed locals, and cancellation. */
  context: CliLocalCallContext<Seed>,
): Promise<CliCallResult<JsonRpcMethodOutcome>> {
  const captured = await invokeJsonRpcMethodWithOutput(catalog, input.method, input.params, {
    source: "local",
    env: context.env,
    locals: context.locals,
    signal: context.signal,
    surface: "jsonRpc",
  });
  const streams = { stdout: captured.stdout, stderr: captured.stderr };
  return context.signal.aborted
    ? failure("transport", "CALL_ABORTED", "JSON-RPC call aborted", undefined, streams)
    : native(captured.outcome, captured.stdout, captured.stderr);
}

/** Returns the accepted remote error category selected from its protocol error code. */
function errorCategory(code: number): JsonRpcNotificationObservation["outcome"] {
  if (code === -32_601) return "method-not-found";
  if (code === -32_602) return "invalid-params";
  if (code === -32_001) return "denied";
  if (code === -32_000) return "application-error";
  return "internal-error";
}

/** Decodes one exact id-1 JSON-RPC response envelope and rejects extra members. */
function decodeRelayOutcome(value: unknown): JsonRpcMethodOutcome | undefined {
  const normalized = strictJsonValue(value);
  if (typeof normalized !== "object" || normalized === null || Array.isArray(normalized)) return undefined;
  const record = normalized as Record<string, JsonValue>;
  const keys = Object.keys(record).sort();
  if (record.jsonrpc !== "2.0" || record.id !== 1) return undefined;
  if (!(keys.length === 3 && keys.includes("jsonrpc") && keys.includes("id"))) return undefined;

  if (keys.includes("result")) {
    return { kind: "ok", result: record.result as JsonValue };
  }
  if (keys.includes("error")) {
    const rpcError = record.error;
    if (typeof rpcError !== "object" || rpcError === null || Array.isArray(rpcError)) return undefined;
    const errorRecord = rpcError as Record<string, unknown>;
    const errorKeys = Object.keys(errorRecord).sort();
    if (
      typeof errorRecord.code !== "number" ||
      !Number.isInteger(errorRecord.code) ||
      typeof errorRecord.message !== "string" ||
      (errorKeys.length !== 2 && errorKeys.length !== 3) ||
      errorKeys.some((key) => key !== "code" && key !== "message" && key !== "data")
    ) {
      return undefined;
    }
    const data = errorKeys.includes("data") ? (errorRecord.data as JsonValue) : undefined;
    const errorValue: JsonRpcErrorObject =
      data === undefined
        ? { code: errorRecord.code, message: errorRecord.message }
        : { code: errorRecord.code, message: errorRecord.message, data };
    return { kind: "error", error: errorValue, category: errorCategory(errorValue.code) };
  }
  return undefined;
}

/** Relays exactly one id-1 request to the supplied endpoint with no discovery or local fallback. */
export async function invokeJsonRpcRelay(
  /** Exact method and parsed params from the generated command. */
  input: JsonRpcMirrorInput,
  /** Exact endpoint, explicit headers, injected fetch, and cancellation. */
  context: CliRelayCallContext,
): Promise<CliCallResult<JsonRpcMethodOutcome>> {
  let headers: Headers;
  try {
    headers = new Headers(context.headers as HeadersInit);
  } catch {
    return failure("input", "CALL_INVALID_HEADERS", "JSON-RPC relay headers are invalid");
  }
  headers.set("content-type", "application/json");
  const envelope = {
    jsonrpc: "2.0",
    id: 1,
    method: input.method,
    ...(input.params === undefined ? {} : { params: input.params }),
  };

  let response: Response;
  try {
    response = await context.fetch(context.url, {
      method: "POST",
      headers,
      body: JSON.stringify(envelope),
      redirect: "manual",
      signal: context.signal,
    });
  } catch {
    return context.signal.aborted
      ? failure("transport", "CALL_ABORTED", "JSON-RPC call aborted")
      : failure("transport", "CALL_TRANSPORT_ERROR", "JSON-RPC relay request failed");
  }
  if (context.signal.aborted) return failure("transport", "CALL_ABORTED", "JSON-RPC call aborted");
  if (!response.ok) {
    return failure(
      "transport",
      "CALL_HTTP_ERROR",
      "JSON-RPC relay returned an unsuccessful HTTP status",
      response.status,
    );
  }

  let decoded: unknown;
  try {
    decoded = await response.json();
  } catch {
    return context.signal.aborted
      ? failure("transport", "CALL_ABORTED", "JSON-RPC call aborted")
      : failure("transport", INVALID_RELAY_RESPONSE.code, INVALID_RELAY_RESPONSE.message);
  }
  if (context.signal.aborted) return failure("transport", "CALL_ABORTED", "JSON-RPC call aborted");
  const outcome = decodeRelayOutcome(decoded);
  return outcome === undefined
    ? failure("transport", INVALID_RELAY_RESPONSE.code, INVALID_RELAY_RESPONSE.message)
    : native(outcome);
}

/** Creates the exactly two registrations consumed by the future generated RPC command. */
export function createJsonRpcMirror<Seed extends object>(
  /** Fixed catalog used only by the local registration. */
  catalog: JsonRpcCatalog<Seed>,
): JsonRpcMirrorEntries<Seed> {
  return {
    local: {
      invoke(input, context) {
        return invokeJsonRpcLocal(catalog, input, context);
      },
    },
    relay: {
      invoke(input, context) {
        return invokeJsonRpcRelay(input, context);
      },
    },
  };
}

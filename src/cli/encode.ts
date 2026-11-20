/*
CLI-native terminal encoding for shared invocation outcomes and generated REST/RPC/MCP calls.
It keeps captured streams separate, preserves native response streams, and owns exit-code policy.
*/

import { AppError } from "../core/errors.ts";
import type { InvocationOutcome } from "../core/invocation.ts";
import type { JsonRpcMethodOutcome } from "../json-rpc/dispatch.ts";
import type { McpErrorResponse, McpResultResponse } from "../mcp/protocol.ts";
import type { CliCallResult } from "./mirror.ts";

/** Captured CLI settlement without terminating the process. */
export interface CliEncodedOutcome {
  /** Public invoke result category. */
  readonly kind: "ok" | "help" | "error";
  /** Process exit status the terminal owner should publish. */
  readonly exitCode: number;
  /** Complete captured and returned stdout. */
  readonly stdout: string;
  /** Complete captured and diagnostic stderr. */
  readonly stderr: string;
  /** Stable safe error text when the invocation failed. */
  readonly errorMsg?: string;
}

/** One sink capable of presenting bytes incrementally and recording text. */
export interface CliCallWriter {
  /** Writes one stdout text or byte chunk and waits for accepted backpressure. */
  stdout(chunk: string | Uint8Array): Promise<void>;
  /** Writes one stderr text chunk and waits for accepted backpressure. */
  stderr(chunk: string): Promise<void>;
}

/** Native generated surface selected for value presentation. */
export type CliCallSurface = "rest" | "rpc" | "mcp";

/** Final process status from one generated local or relay presentation. */
export interface CliPresentedCall {
  /** Exit status selected after native presentation. */
  readonly exitCode: 0 | 1 | 130;
}

/** Compact first-line projection used when a thrown value is not an `Error`. */
function safeThrownMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "An unexpected error occurred";
}

/** Formats one Zod issue path with argsbarg's established `$` and dotted form. */
function issuePath(path: readonly PropertyKey[]): string {
  return path.length === 0 ? "$" : path.map(String).join(".");
}

/** Formats a shared invalid-input outcome once for the CLI encoder. */
function formatInvalid(error: Extract<InvocationOutcome<unknown>, { readonly kind: "invalid" }>["error"]): string {
  const lines = error.issues.map((issue) => {
    const suffix = issue.code === "invalid_type" && issue.input === undefined ? "required" : issue.message;
    return `${issuePath(issue.path)}: ${suffix}`;
  });
  return lines.length <= 10
    ? lines.join("\n")
    : `${lines.slice(0, 10).join("\n")}\n…and ${lines.length - 10} more errors`;
}

/** Serializes one ordinary handler value with the existing CLI response convention. */
function appendCliResult(stdout: string, result: unknown): string {
  if (result === undefined) return stdout;
  if (typeof result === "string") {
    return `${stdout}${result}${result.endsWith("\n") ? "" : "\n"}`;
  }
  const encoded = JSON.stringify(result, null, 2);
  if (encoded === undefined) return stdout;
  return `${stdout}${encoded}\n`;
}

/** Encodes one D2 terminal outcome into non-exiting CLI result data. */
export function encodeCliOutcome(
  /** Shared validation, denial, error, or success result. */
  outcome: InvocationOutcome<unknown>,
): CliEncodedOutcome {
  if (outcome.kind === "ok") {
    let stdout: string;
    try {
      stdout = appendCliResult(outcome.stdout, outcome.result);
    } catch {
      const errorMsg = "Handler result is not JSON serializable";
      return { kind: "error", exitCode: 1, stdout: outcome.stdout, stderr: `${errorMsg}\n`, errorMsg };
    }
    return { kind: "ok", exitCode: 0, stdout, stderr: outcome.stderr };
  }
  if (outcome.kind === "denied") {
    const errorMsg = `${outcome.denial.code}: ${outcome.denial.message}`;
    return {
      kind: "error",
      exitCode: 1,
      stdout: outcome.stdout,
      stderr: `${outcome.stderr}${errorMsg}\n`,
      errorMsg,
    };
  }
  if (outcome.kind === "invalid") {
    const errorMsg = formatInvalid(outcome.error);
    return {
      kind: "error",
      exitCode: 1,
      stdout: outcome.stdout,
      stderr: `${outcome.stderr}${errorMsg}\n`,
      errorMsg,
    };
  }
  const errorMsg =
    outcome.error instanceof AppError
      ? `${outcome.error.code}: ${outcome.error.message}`
      : safeThrownMessage(outcome.error);
  return {
    kind: "error",
    exitCode: 1,
    stdout: outcome.stdout,
    stderr: `${outcome.stderr}${errorMsg}\n`,
    errorMsg,
  };
}

/** Writes captured streams before a native generated-call value. */
async function writeCaptured(result: CliCallResult<unknown>, writer: CliCallWriter): Promise<void> {
  if (result.stdout.length > 0) await writer.stdout(result.stdout);
  if (result.stderr.length > 0) await writer.stderr(result.stderr);
}

/** Serializes one compact native JSON value plus its protocol newline. */
function compactJson(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("Native call result is not JSON serializable");
  return `${encoded}\n`;
}

/** Streams a native REST response body without buffering while preserving its final HTTP status policy. */
async function presentRest(response: Response, writer: CliCallWriter, signal: AbortSignal): Promise<0 | 1 | 130> {
  try {
    const reader = response.body?.getReader();
    while (reader !== undefined) {
      const next = await reader.read();
      if (next.done) break;
      await writer.stdout(next.value);
    }
    return response.status >= 200 && response.status < 400 ? 0 : 1;
  } catch {
    return signal.aborted ? 130 : 1;
  }
}

/** Presents an accepted JSON-RPC method success or native protocol/application error. */
async function presentRpc(value: JsonRpcMethodOutcome, writer: CliCallWriter): Promise<0 | 1> {
  if (value.kind === "ok") {
    await writer.stdout(compactJson(value.result));
    return 0;
  }
  await writer.stderr(compactJson(value.error));
  return 1;
}

/** Presents the complete MCP result/error payload while discarding no native protocol fields. */
async function presentMcp(value: McpResultResponse | McpErrorResponse, writer: CliCallWriter): Promise<0 | 1> {
  if ("error" in value) {
    await writer.stderr(compactJson(value.error));
    return 1;
  }
  if (
    typeof value.result === "object" &&
    value.result !== null &&
    "isError" in value.result &&
    value.result.isError === true
  ) {
    await writer.stderr(compactJson(value.result));
    return 1;
  }
  await writer.stdout(compactJson(value.result));
  return 0;
}

/** Presents one D35 local/relay result with exact captured output, stream, and exit behavior. */
export async function presentCliCall(
  /** Generated command's native surface. */
  surface: CliCallSurface,
  /** Native or safe failed call result. */
  result: CliCallResult<unknown>,
  /** Incremental terminal sink. */
  writer: CliCallWriter,
  /** Authoritative caller/process cancellation signal. */
  signal: AbortSignal,
): Promise<CliPresentedCall> {
  await writeCaptured(result, writer);
  if (result.kind === "failure") {
    await writer.stderr(`${result.code}: ${result.message}\n`);
    return { exitCode: signal.aborted ? 130 : 1 };
  }
  if (surface === "rest") {
    const exitCode = await presentRest(result.value as Response, writer, signal);
    return { exitCode: signal.aborted ? 130 : exitCode };
  }
  try {
    const exitCode =
      surface === "rpc"
        ? await presentRpc(result.value as JsonRpcMethodOutcome, writer)
        : await presentMcp(result.value as McpResultResponse | McpErrorResponse, writer);
    return { exitCode: signal.aborted ? 130 : exitCode };
  } catch {
    return { exitCode: signal.aborted ? 130 : 1 };
  }
}

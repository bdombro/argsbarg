/*
Deterministic REST encoding for shared invocation outcomes.
Handler-owned Web Responses pass through by identity without reading or buffering their bodies.
*/

import { type DocumentFormat, encodeDocument } from "../core/document.ts";
import { AppError } from "../core/errors.ts";
import type { Denial, InvocationOutcome } from "../core/invocation.ts";
import type { HttpBindError } from "./bind.ts";
import { documentMediaType } from "./media.ts";
import type { RegisteredHttpRoute } from "./routes.ts";

/** Stable JSON error document emitted by the REST adapter. */
export interface HttpErrorBody {
  /** Structured REST error envelope. */
  error: {
    /** Stable machine-readable error code. */
    code: string;
    /** Client-safe human-readable message. */
    message: string;
    /** Optional JSON-safe error details. */
    details?: unknown;
  };
}

/** Additional framework-owned headers applied after core REST encoding. */
export interface HttpResponseFinishing {
  /** CORS fields that replace only framework-owned values. */
  readonly cors?: Readonly<Record<string, string>>;
  /** Trace fields that replace only framework-owned values. */
  readonly trace?: Readonly<Record<string, string>>;
}

/** JSON-safe details projected from one Zod issue. */
function issueProjection(issue: { path: readonly PropertyKey[]; code: string; message: string }) {
  return {
    path: [...issue.path],
    code: issue.code,
    message: issue.message,
  };
}

/** Returns JSON-safe details or `undefined` without retaining cyclic or throwing values. */
function safeDetails(details: unknown): unknown {
  if (details === undefined) return undefined;
  try {
    const text = JSON.stringify(details);
    return text === undefined ? undefined : (JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
}

/** Builds response headers for a framework-owned document without touching native responses. */
function documentHeaders(format: DocumentFormat | undefined, extra?: Readonly<Record<string, string>>): Headers {
  const headers = new Headers({ "content-type": `${documentMediaType[format ?? "json"]}; charset=utf-8`, ...extra });
  if (format === "yaml") {
    headers.set("content-type", `${documentMediaType.yaml}; charset=utf-8`);
    headers.delete("content-length");
  }
  if (format !== undefined) {
    const variesBy = headers.get("vary")?.split(",").map((field) => field.trim().toLowerCase()) ?? [];
    if (!variesBy.includes("*") && !variesBy.includes("accept")) headers.append("vary", "Accept");
  }
  return headers;
}

/** Builds a document response with the stable REST error envelope. */
export function httpErrorResponse(
  /** HTTP status. */
  status: number,
  /** Stable machine-readable code. */
  code: string,
  /** Client-safe message. */
  message: string,
  /** Optional JSON-safe details. */
  details?: unknown,
  /** Optional additional error response headers. */
  headers?: Readonly<Record<string, string>>,
  /** Negotiated format; omitted for internal encoders that do not negotiate. */
  format?: DocumentFormat,
): Response {
  const safe = safeDetails(details);
  const body: HttpErrorBody = {
    error: {
      code,
      message,
      ...(safe === undefined ? {} : { details: safe }),
    },
  };
  return new Response(encodeDocument(body, format ?? "json"), {
    status,
    headers: documentHeaders(format, headers),
  });
}

/** Encodes a pre-invocation bind failure without creating an invocation outcome. */
export function encodeHttpBindError(
  /** Stable binder failure. */
  error: HttpBindError,
  /** Negotiated response format. */
  format?: DocumentFormat,
): Response {
  return httpErrorResponse(error.status, error.code, error.message, error.details, undefined, format);
}

/** Escapes one quoted bearer challenge attribute. */
function quoteChallenge(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

/** Builds the standards-shaped bearer challenge attached to an HTTP denial. */
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

/** Returns the method-specific ordinary success status. */
function defaultStatus(method: string): number {
  return method === "POST" ? 201 : 200;
}

/** Encodes a successful ordinary value in the selected document format. */
function encodeSuccess(result: unknown, route: RegisteredHttpRoute, format?: DocumentFormat): Response {
  if (result === undefined) {
    return httpErrorResponse(500, "NO_RESULT", "Handler returned no result", undefined, undefined, format);
  }
  let body: string;
  try {
    body = encodeDocument(result, format ?? "json");
  } catch {
    return httpErrorResponse(500, "INTERNAL_ERROR", "Handler result is not JSON serializable", undefined, undefined, format);
  }
  return new Response(body, {
    status: route.spec.response?.status ?? defaultStatus(route.spec.method),
    headers: documentHeaders(format, route.spec.response?.headers),
  });
}

/** Encodes the four shared D2 outcomes into one native REST response. */
export function encodeHttpOutcome(
  /** Shared invocation terminal outcome. */
  outcome: InvocationOutcome<unknown>,
  /** Registered route whose native response metadata applies. */
  route: RegisteredHttpRoute,
  /** Format for generated success and error documents. */
  format?: DocumentFormat,
): Response {
  if (outcome.kind === "ok") {
    return outcome.result instanceof Response ? outcome.result : encodeSuccess(outcome.result, route, format);
  }
  if (outcome.kind === "invalid") {
    return httpErrorResponse(400, "INVALID_INPUT", "Input validation failed", {
      issues: outcome.error.issues.slice(0, 10).map(issueProjection),
      issueCount: outcome.error.issues.length,
    }, undefined, format);
  }
  if (outcome.kind === "denied") {
    const headers: Record<string, string> = { ...(outcome.denial.http?.headers ?? {}) };
    const challenge = bearerChallenge(outcome.denial);
    if (challenge !== undefined) headers["www-authenticate"] = challenge;
    return httpErrorResponse(
      outcome.denial.http?.status ?? 403,
      outcome.denial.code,
      outcome.denial.message,
      undefined,
      headers,
      format,
    );
  }
  if (outcome.error instanceof AppError) {
    return httpErrorResponse(
      outcome.error.httpStatus ?? 500,
      outcome.error.code,
      outcome.error.message,
      outcome.error.details,
      undefined,
      format,
    );
  }
  return httpErrorResponse(500, "INTERNAL_ERROR", "An unexpected error occurred", undefined, undefined, format);
}

/**
 * Composes CORS and trace fields after encoding while reusing the encoded body stream.
 *
 * The direct outcome encoder intentionally returns handler `Response` objects by reference; this helper is
 * reserved for later mount-owned finishing.
 */
export function finishHttpResponse(
  /** Already encoded native response. */
  response: Response,
  /** Framework-owned CORS and trace fields to apply. */
  finishing: HttpResponseFinishing,
): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(finishing.cors ?? {})) headers.set(name, value);
  for (const [name, value] of Object.entries(finishing.trace ?? {})) headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

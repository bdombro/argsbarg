/*
Deterministic REST encoding for shared invocation outcomes.
Handler-owned Web Responses pass through by identity without reading or buffering their bodies.
*/

import { AppError } from "../core/errors.ts";
import type { Denial, InvocationOutcome } from "../core/invocation.ts";
import type { HttpBindError } from "./bind.ts";
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

/** Builds a JSON error response with the stable REST envelope. */
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
): Response {
  const safe = safeDetails(details);
  const body: HttpErrorBody = {
    error: {
      code,
      message,
      ...(safe === undefined ? {} : { details: safe }),
    },
  };
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(headers ?? {}),
    },
  });
}

/** Encodes a pre-invocation bind failure without creating an invocation outcome. */
export function encodeHttpBindError(
  /** Stable binder failure. */
  error: HttpBindError,
): Response {
  return httpErrorResponse(error.status, error.code, error.message, error.details);
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

/** Returns the method-specific ordinary JSON success status. */
function defaultStatus(method: string): number {
  return method === "POST" ? 201 : 200;
}

/** Encodes a successful ordinary value as one JSON response. */
function encodeJsonSuccess(result: unknown, route: RegisteredHttpRoute): Response {
  if (result === undefined) {
    return httpErrorResponse(500, "NO_RESULT", "Handler returned no result");
  }
  let body: string;
  try {
    const serialized = JSON.stringify(result);
    if (serialized === undefined) {
      return httpErrorResponse(500, "INTERNAL_ERROR", "Handler result is not JSON serializable");
    }
    body = serialized;
  } catch {
    return httpErrorResponse(500, "INTERNAL_ERROR", "Handler result is not JSON serializable");
  }
  return new Response(body, {
    status: route.spec.response?.status ?? defaultStatus(route.spec.method),
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(route.spec.response?.headers ?? {}),
    },
  });
}

/** Encodes the four shared D2 outcomes into one native REST response. */
export function encodeHttpOutcome(
  /** Shared invocation terminal outcome. */
  outcome: InvocationOutcome<unknown>,
  /** Registered route whose native response metadata applies. */
  route: RegisteredHttpRoute,
): Response {
  if (outcome.kind === "ok") {
    return outcome.result instanceof Response ? outcome.result : encodeJsonSuccess(outcome.result, route);
  }
  if (outcome.kind === "invalid") {
    return httpErrorResponse(400, "INVALID_INPUT", "Input validation failed", {
      issues: outcome.error.issues.slice(0, 10).map(issueProjection),
      issueCount: outcome.error.issues.length,
    });
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
    );
  }
  if (outcome.error instanceof AppError) {
    return httpErrorResponse(
      outcome.error.httpStatus ?? 500,
      outcome.error.code,
      outcome.error.message,
      outcome.error.details,
    );
  }
  return httpErrorResponse(500, "INTERNAL_ERROR", "An unexpected error occurred");
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

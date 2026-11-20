/*
Transport-neutral JSON-RPC 2.0 envelope decoding and D2 method dispatch.
It performs no HTTP, process, listener, or logging work and returns protocol data only.
*/

import { AppError } from "../core/errors.ts";
import type { InvocationBase, InvocationOutcome } from "../core/invocation.ts";
import { type JsonRpcCatalog, invokeRegisteredJsonRpcMethod } from "./catalog.ts";

/** Finite request identifiers accepted by the JSON-RPC profile. */
export type JsonRpcId = string | number | null;

/** Bounded notification outcome supplied to listener-side observation hooks. */
export interface JsonRpcNotificationObservation {
  /** Exact registered or requested method name. */
  readonly method: string;
  /** Notification outcome category. */
  readonly outcome: "ok" | "invalid-params" | "denied" | "application-error" | "internal-error" | "method-not-found";
  /** Stable denial or application code, when one is present and safe. */
  readonly code?: string;
}

/** Per-member transport-neutral invocation factory. */
export interface JsonRpcDispatchOptions<Seed extends object> {
  /** Creates fresh locals and the exclusive request source/signal for one member. */
  readonly createBase: () => InvocationBase<Seed>;
  /** Optional observation sink for fully executed notifications. */
  readonly observeNotification?: (event: JsonRpcNotificationObservation) => void | Promise<void>;
}

/** JSON-RPC error payload. */
export interface JsonRpcErrorObject {
  /** Protocol or application error number. */
  readonly code: number;
  /** Stable human-readable message. */
  readonly message: string;
  /** Optional strict JSON-safe projection. */
  readonly data?: JsonValue;
}

/** Strict JSON null, primitive, array, or object value. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { readonly [key: string]: JsonValue };

/** One protocol success or error response. */
export type JsonRpcResponse =
  | {
      /** JSON-RPC protocol version. */
      readonly jsonrpc: "2.0";
      /** Correlating request identifier. */
      readonly id: JsonRpcId;
      /** Direct handler result. */
      readonly result: JsonValue;
    }
  | {
      /** JSON-RPC protocol version. */
      readonly jsonrpc: "2.0";
      /** Correlating request identifier. */
      readonly id: JsonRpcId;
      /** Protocol, denial, or application error. */
      readonly error: JsonRpcErrorObject;
    };

/** One value returned by JSON-RPC dispatch, or `undefined` for all notifications. */
export type JsonRpcDispatchResult = JsonRpcResponse | readonly JsonRpcResponse[] | undefined;

/** Shared method invocation outcome before JSON-RPC envelope encoding. */
export type JsonRpcMethodOutcome =
  | { readonly kind: "ok"; readonly result: JsonValue }
  | {
      readonly kind: "error";
      readonly error: JsonRpcErrorObject;
      readonly category: JsonRpcNotificationObservation["outcome"];
    };

/** One encoded JSON-RPC method outcome together with the D2 invocation's captured process output. */
export interface JsonRpcMethodInvocation {
  /** Protocol-native method outcome encoded from the one D2 invocation. */
  readonly outcome: JsonRpcMethodOutcome;
  /** Stdout captured during that same invocation. */
  readonly stdout: string;
  /** Stderr captured during that same invocation. */
  readonly stderr: string;
}

/** Envelope whose method and identifier profile were accepted before invocation. */
interface DecodedRequest {
  /** Original exact request method. */
  readonly method: string;
  /** Native params value passed unchanged to D2. */
  readonly params: unknown;
  /** Whether this valid envelope omitted its ID member. */
  readonly notification: boolean;
  /** Request ID for response-bearing calls. */
  readonly id: JsonRpcId;
}

/** Successful response-free request before method lookup and validation. */
interface DecodedNotification {
  /** Original exact request method. */
  readonly method: string;
  /** Native params value passed unchanged to D2. */
  readonly params: unknown;
  /** Selects the response-free branch. */
  readonly notification: true;
  /** Placeholder never serialized. */
  readonly id: null;
}

/** Structurally malformed envelope classified without D2 invocation. */
interface MalformedRequest {
  /** Selects the malformed branch. */
  readonly malformed: true;
  /** Safe response identifier echoed from the envelope when possible. */
  readonly id: JsonRpcId;
  /** Protocol error code. */
  readonly code: -32600;
  /** Stable protocol message. */
  readonly message: "Invalid Request";
}

/** Params belonging to an otherwise valid envelope but rejected before Zod. */
interface InvalidParamsRequest {
  /** Exact requested method, retained for notification observation. */
  readonly method: string;
  /** Selects the pre-D2 params error. */
  readonly invalidParams: true;
  /** Whether the invalid params call is a notification. */
  readonly notification: boolean;
  /** Safe response identifier. */
  readonly id: JsonRpcId;
}

/** Result of classifying one JSON value. */
type DecodedMember = DecodedRequest | DecodedNotification | MalformedRequest | InvalidParamsRequest;

/** Own property names allowed on a JSON-RPC 2.0 request envelope. */
const REQUEST_KEYS = new Set(["jsonrpc", "method", "params", "id"]);

/** Returns true exactly for the DP-22 finite ID union. */
function isJsonRpcId(value: unknown): value is JsonRpcId {
  return value === null || typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

/** Returns a valid echoed ID, otherwise the protocol fallback `null`. */
function safeId(record: Record<string, unknown>): JsonRpcId {
  return Object.hasOwn(record, "id") && isJsonRpcId(record.id) ? record.id : null;
}

/** Returns true for a plain, structured params value accepted at the envelope boundary. */
function isStructuredParams(value: unknown): value is Record<string, unknown> | unknown[] {
  return Array.isArray(value) || (typeof value === "object" && value !== null && !Array.isArray(value));
}

/** Classifies one envelope without parsing schemas, invoking guards, or looking up methods. */
function decodeMember(value: unknown): DecodedMember {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { malformed: true, id: null, code: -32600, message: "Invalid Request" };
  }
  const record = value as Record<string, unknown>;
  const id = safeId(record);
  const hasValidId = !Object.hasOwn(record, "id") || isJsonRpcId(record.id);
  const envelopeValid =
    record.jsonrpc === "2.0" &&
    typeof record.method === "string" &&
    hasValidId &&
    Object.keys(record).every((key) => REQUEST_KEYS.has(key));
  if (!envelopeValid) {
    return { malformed: true, id, code: -32600, message: "Invalid Request" };
  }

  const method = record.method as string;
  const hasId = Object.hasOwn(record, "id");
  if (Object.hasOwn(record, "params") && !isStructuredParams(record.params)) {
    return { invalidParams: true, method, notification: !hasId, id };
  }
  return {
    method,
    params: Object.hasOwn(record, "params") ? record.params : undefined,
    notification: !hasId,
    id,
  };
}

/** Constructs one protocol error object without unsanitized dynamic values. */
function error(code: number, message: string, data?: JsonValue): JsonRpcErrorObject {
  return data === undefined ? { code, message } : { code, message, data };
}

/** Creates one immutable-shape success/error envelope. */
function response(id: JsonRpcId, outcome: JsonRpcMethodOutcome): JsonRpcResponse {
  return outcome.kind === "ok"
    ? { jsonrpc: "2.0", id, result: outcome.result }
    : { jsonrpc: "2.0", id, error: outcome.error };
}

/** Rejects unsafe native or relayed JSON values, including accessors, holes, cycles, and class instances. */
export function strictJsonValue(
  /** Candidate value from a handler or projected application details. */
  value: unknown,
  /** Objects currently on this traversal branch. */
  seen: Set<object> = new Set(),
): JsonValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "object") return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);

  if (Array.isArray(value)) {
    const result: JsonValue[] = [];
    const indexKeys = new Set(Array.from({ length: value.length }, (_, index) => String(index)));
    for (const key of Reflect.ownKeys(value)) {
      if (key !== "length" && (typeof key !== "string" || !indexKeys.has(key))) {
        seen.delete(value);
        return undefined;
      }
    }
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index)) {
        seen.delete(value);
        return undefined;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, index);
      if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
        seen.delete(value);
        return undefined;
      }
      const child = strictJsonValue(descriptor.value, seen);
      if (child === undefined) {
        seen.delete(value);
        return undefined;
      }
      result.push(child);
    }
    seen.delete(value);
    return result;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    seen.delete(value);
    return undefined;
  }
  const entries: [string, JsonValue][] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      seen.delete(value);
      return undefined;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
      seen.delete(value);
      return undefined;
    }
    const child = strictJsonValue(descriptor.value, seen);
    if (child === undefined) {
      seen.delete(value);
      return undefined;
    }
    entries.push([key, child]);
  }
  seen.delete(value);
  return Object.fromEntries(entries);
}

/** Formats the first ten Zod issues without reparsing or exposing original inputs. */
function formatZodIssues(outcome: Extract<InvocationOutcome<unknown>, { kind: "invalid" }>): string[] {
  const formatPath = (path: readonly PropertyKey[]): string => (path.length === 0 ? "$" : path.map(String).join("."));
  const all = outcome.error.issues.map((issue) => {
    const message = issue.code === "invalid_type" && issue.input === undefined ? "required" : issue.message;
    return `${formatPath(issue.path)}: ${message}`;
  });
  return all.length <= 10 ? all : [...all.slice(0, 10), `…and ${all.length - 10} more errors`];
}

/** Links one member-local abort controller to the transport signal supplied by its base factory. */
function linkMemberSignal(
  /** Transport-owned signal from the invocation base. */
  parent: AbortSignal,
): { readonly controller: AbortController; readonly unlink: () => void } {
  const controller = new AbortController();
  if (parent.aborted) {
    controller.abort(parent.reason);
    return { controller, unlink: () => undefined };
  }
  const relay = (): void => controller.abort(parent.reason);
  parent.addEventListener("abort", relay, { once: true });
  return { controller, unlink: () => parent.removeEventListener("abort", relay) };
}

/** Encodes one D2 terminal outcome with strict DP-22 safety and no captured-output leakage. */
function encodeOutcome(
  /** Exact D2 terminal outcome. */
  outcome: InvocationOutcome<unknown>,
): JsonRpcMethodOutcome {
  if (outcome.kind === "ok") {
    const result = strictJsonValue(outcome.result);
    return result === undefined
      ? { kind: "error", error: error(-32603, "Internal error"), category: "internal-error" }
      : { kind: "ok", result };
  }
  if (outcome.kind === "invalid") {
    return {
      kind: "error",
      category: "invalid-params",
      error: error(-32602, "Invalid params", {
        kind: "invalid-params",
        issues: formatZodIssues(outcome),
      }),
    };
  }
  if (outcome.kind === "denied") {
    return {
      kind: "error",
      category: "denied",
      error: error(-32001, outcome.denial.message, { kind: "denial", code: outcome.denial.code }),
    };
  }
  if (outcome.error instanceof AppError) {
    const details = strictJsonValue(outcome.error.details);
    const data: Record<string, JsonValue> = { kind: "application", code: outcome.error.code };
    if (details !== undefined) data.details = details;
    return {
      kind: "error",
      category: "application-error",
      error: error(-32000, outcome.error.message, data),
    };
  }
  return { kind: "error", category: "internal-error", error: error(-32603, "Internal error") };
}

/** Runs one encoded method outcome while optionally retaining the transport's member-signal boundary. */
async function invokeJsonRpcMethodCaptured<Seed extends object>(
  /** Fixed registered method catalog. */
  catalog: JsonRpcCatalog<Seed>,
  /** Exact, case-sensitive method name. */
  name: string,
  /** Native structured params passed unchanged as D2 raw input. */
  rawInputs: unknown,
  /** Fresh source, seed locals, and transport signal for this invocation. */
  base: InvocationBase<Seed>,
  /** Whether this invocation belongs to the independently linked batch/HTTP path. */
  linkSignal: boolean,
): Promise<JsonRpcMethodInvocation> {
  const entry = catalog.get(name);
  if (entry === undefined) {
    return {
      outcome: { kind: "error", category: "method-not-found", error: error(-32601, "Method not found") },
      stdout: "",
      stderr: "",
    };
  }
  const linked = linkSignal ? linkMemberSignal(base.signal) : undefined;
  const signal = linked?.controller.signal ?? base.signal;
  try {
    const outcome = await invokeRegisteredJsonRpcMethod(entry, rawInputs, {
      ...base,
      signal,
      surface: "jsonRpc",
    });
    return {
      outcome: encodeOutcome(outcome),
      stdout: outcome.stdout,
      stderr: outcome.stderr,
    };
  } finally {
    linked?.unlink();
  }
}

/** Invokes one registered method directly and retains output with the caller's exact local signal. */
export async function invokeJsonRpcMethodWithOutput<Seed extends object>(
  /** Fixed registered method catalog. */
  catalog: JsonRpcCatalog<Seed>,
  /** Exact, case-sensitive method name. */
  name: string,
  /** Native structured params passed unchanged as D2 raw input. */
  rawInputs: unknown,
  /** Fresh source, seed locals, and exact local cancellation signal for this invocation. */
  base: InvocationBase<Seed>,
): Promise<JsonRpcMethodInvocation> {
  return invokeJsonRpcMethodCaptured(catalog, name, rawInputs, base, false);
}

/** Invokes one registered method directly, without fabricating a JSON-RPC envelope. */
export async function invokeJsonRpcMethod<Seed extends object>(
  /** Fixed registered method catalog. */
  catalog: JsonRpcCatalog<Seed>,
  /** Exact, case-sensitive method name. */
  name: string,
  /** Native structured params passed unchanged as D2 raw input. */
  rawInputs: unknown,
  /** Fresh source, seed locals, and transport signal for this invocation. */
  base: InvocationBase<Seed>,
): Promise<JsonRpcMethodOutcome> {
  return (await invokeJsonRpcMethodCaptured(catalog, name, rawInputs, base, true)).outcome;
}

/** Maps one pre-invocation invalid-params call to a request/notification outcome. */
function invalidParamsOutcome(): JsonRpcMethodOutcome {
  return { kind: "error", category: "invalid-params", error: error(-32602, "Invalid params") };
}

/** Produces the one bounded notification observation accepted by the DP-22 profile. */
function notificationObservation(method: string, outcome: JsonRpcMethodOutcome): JsonRpcNotificationObservation {
  if (outcome.kind === "ok") return { method, outcome: "ok" };
  const application =
    outcome.category === "application-error" &&
    typeof outcome.error.data === "object" &&
    outcome.error.data !== null &&
    !Array.isArray(outcome.error.data) &&
    typeof outcome.error.data.code === "string"
      ? outcome.error.data.code
      : undefined;
  const denial =
    outcome.category === "denied" &&
    typeof outcome.error.data === "object" &&
    outcome.error.data !== null &&
    !Array.isArray(outcome.error.data) &&
    typeof outcome.error.data.code === "string"
      ? outcome.error.data.code
      : undefined;
  return {
    method,
    outcome: outcome.category,
    ...(application === undefined && denial === undefined ? {} : { code: application ?? denial }),
  };
}

/** Dispatches one classified request while suppressing valid notification responses. */
async function dispatchMember<Seed extends object>(
  /** Fixed method catalog. */
  catalog: JsonRpcCatalog<Seed>,
  /** Classifier result for this member. */
  decoded: DecodedMember,
  /** Per-member base factory and notification observer. */
  options: JsonRpcDispatchOptions<Seed>,
): Promise<JsonRpcResponse | undefined> {
  if ("malformed" in decoded) {
    return { jsonrpc: "2.0", id: decoded.id, error: error(decoded.code, decoded.message) };
  }
  const outcome =
    "invalidParams" in decoded
      ? invalidParamsOutcome()
      : await invokeJsonRpcMethod(catalog, decoded.method, decoded.params, options.createBase());
  if (decoded.notification) {
    await options.observeNotification?.(notificationObservation(decoded.method, outcome));
    return undefined;
  }
  return response(decoded.id, outcome);
}

/** Returns duplicate valid request IDs while preserving null and falsy identifiers. */
function duplicateIds(
  /** Decoded batch members. */
  decoded: readonly DecodedMember[],
): ReadonlySet<JsonRpcId> {
  const counts = new Map<JsonRpcId, number>();
  for (const member of decoded) {
    if (!("malformed" in member) && !member.notification) {
      counts.set(member.id, (counts.get(member.id) ?? 0) + 1);
    }
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([id]) => id));
}

/** Reclassifies duplicate request positions as Invalid Request before method invocation. */
function applyDuplicateIds(decoded: readonly DecodedMember[]): readonly DecodedMember[] {
  const duplicates = duplicateIds(decoded);
  return decoded.map((member) =>
    !("malformed" in member) && !member.notification && duplicates.has(member.id)
      ? { malformed: true as const, id: member.id, code: -32600 as const, message: "Invalid Request" as const }
      : member,
  );
}

/**
 * Decodes one JSON text or value and independently dispatches each request/batch member.
 * A single or batch of notifications returns `undefined`; malformed notifications still receive protocol errors.
 */
export async function dispatchJsonRpc<Seed extends object = object>(
  /** Fixed method catalog shared by dispatch and discovery. */
  catalog: JsonRpcCatalog<Seed>,
  /** One JSON text payload or an already-decoded JSON value. */
  input: string | unknown,
  /** Per-member invocation base and bounded observer. */
  options: JsonRpcDispatchOptions<Seed>,
): Promise<JsonRpcDispatchResult> {
  let value: unknown;
  try {
    value = typeof input === "string" ? JSON.parse(input) : input;
  } catch {
    return { jsonrpc: "2.0", id: null, error: error(-32700, "Parse error") };
  }

  const batchValue = Array.isArray(value) ? value : undefined;
  if (batchValue?.length === 0) {
    return { jsonrpc: "2.0", id: null, error: error(-32600, "Invalid Request") };
  }
  const rawMembers: unknown[] = batchValue ?? [value];
  const decoded = applyDuplicateIds(rawMembers.map(decodeMember));
  const settled = await Promise.allSettled(decoded.map((member) => dispatchMember(catalog, member, options)));
  const responses: JsonRpcResponse[] = [];
  settled.forEach((result, index) => {
    if (result.status === "fulfilled") {
      if (result.value !== undefined) responses.push(result.value);
      return;
    }
    const member = decoded[index];
    if (member !== undefined && !("malformed" in member) && member.notification) return;
    const id = member !== undefined && !("malformed" in member) ? member.id : (member?.id ?? null);
    responses.push({ jsonrpc: "2.0", id, error: error(-32603, "Internal error") });
  });
  if (batchValue !== undefined) return responses.length === 0 ? undefined : responses;
  return responses[0];
}

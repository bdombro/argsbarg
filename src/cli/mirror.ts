/*
Shared package-internal call registrations for generated CLI mirrors and relays.
It fixes the local/remote source, captured output, native result, and safe failure shapes once for every surface.
*/

import type { NameView } from "../core/invocation.ts";

/** Exact process-local source used by an in-process generated CLI call. */
export interface CliLocalCallContext<Seed extends object = object> {
  /** Selects direct local registration without HTTP or protocol middleware. */
  readonly mode: "local";
  /** Exact caller-owned cancellation signal retained by the invocation. */
  readonly signal: AbortSignal;
  /** Fresh seed locals copied before guards run. */
  readonly locals: Seed;
  /** Name-only view of the process-local environment. */
  readonly env: NameView;
}

/** Exact remote source used by a generated CLI relay call. */
export interface CliRelayCallContext {
  /** Selects one explicit remote request with no local fallback. */
  readonly mode: "relay";
  /** Exact caller-owned cancellation signal passed to Fetch. */
  readonly signal: AbortSignal;
  /** Already validated relay URL. */
  readonly url: URL;
  /** Explicit sanitized argv headers only. */
  readonly headers: ReadonlyArray<readonly [name: string, value: string]>;
  /** Fetch implementation supplied by the factory. */
  readonly fetch: typeof globalThis.fetch;
}

/** Exclusive source context accepted by every generated CLI registration. */
export type CliCallContext<Seed extends object = object> = CliLocalCallContext<Seed> | CliRelayCallContext;

/** One transport-native result plus output captured from the same local invocation. */
export interface CliNativeCallResult<Native> {
  /** Identifies a valid native application or protocol value. */
  readonly kind: "native";
  /** Native REST, RPC, or MCP value preserved without a neutral wrapper. */
  readonly value: Native;
  /** Captured stdout, or empty output for a relay. */
  readonly stdout: string;
  /** Captured stderr, or empty output for a relay. */
  readonly stderr: string;
}

/** One sanitized usage or transport failure with no native protocol value. */
export interface CliFailedCallResult {
  /** Identifies a terminal failure before a native value exists. */
  readonly kind: "failure";
  /** Separates caller input failures from transport/protocol failures. */
  readonly category: "input" | "transport";
  /** Stable client-safe failure code. */
  readonly code: string;
  /** Stable client-safe failure message. */
  readonly message: string;
  /** Sanitized remote status when the adapter observed one. */
  readonly status?: number;
  /** Captured stdout produced before failure. */
  readonly stdout: string;
  /** Captured stderr produced before failure. */
  readonly stderr: string;
}

/** Terminal value shared by all generated local and relay calls. */
export type CliCallResult<Native> = CliNativeCallResult<Native> | CliFailedCallResult;

/** One parsed-input registration consumed by the CLI factory. */
export interface CliCallEntry<Input, Native, Context = CliCallContext> {
  /** Invokes exactly one local declaration or one explicit relay request. */
  invoke(input: Input, context: Context): Promise<CliCallResult<Native>>;
}

/*
Package-internal REST mirrors for generated CLI local calls and explicit relay calls.
They preserve native responses and captured invocation output without starting a listener or falling back locally.
*/

import type {
  CliCallEntry,
  CliCallResult,
  CliFailedCallResult,
  CliLocalCallContext,
  CliNativeCallResult,
  CliRelayCallContext,
} from "../cli/mirror.ts";
import type { InvocationBase } from "../core/invocation.ts";
import { bindHttpCall, type HttpCallInput } from "./bind.ts";
import { encodeHttpOutcome } from "./encode.ts";
import { type HttpRouteCatalog, invokeRegisteredHttpRoute } from "./routes.ts";

export type { HttpCallInput } from "./bind.ts";

/** Successful native call value plus process output captured by one invocation. */
export type HttpNativeCallResult<Native = Response> = CliNativeCallResult<Native>;

/** Safe input or transport failure returned without throwing to the generated CLI. */
export type HttpFailureCallResult = CliFailedCallResult;

/** REST specialization of the shared generated-CLI result shape. */
export type HttpCallResult = CliCallResult<Response>;

/** Explicit process-local source fixed for one generated local REST call. */
export type HttpLocalCallContext<Seed extends object = Record<never, never>> = CliLocalCallContext<Seed>;

/** Explicit remote source and injected Fetch dependency for one relay call. */
export type HttpRelayCallContext = CliRelayCallContext;

/** Exclusive local or relay context accepted by the paired REST registration seam. */
export type CliCallContext<Seed extends object = Record<never, never>> =
  | HttpLocalCallContext<Seed>
  | HttpRelayCallContext;

/** One structurally shared generated-CLI registration for parsed input and a matching context. */
export type { CliCallEntry, CliCallResult } from "../cli/mirror.ts";

/** Package-local entry that executes one generated REST local call. */
export type HttpLocalMirror<Seed extends object = Record<never, never>> = CliCallEntry<
  HttpCallInput,
  Response,
  HttpLocalCallContext<Seed>
>;

/** Package-local entry that executes one generated REST relay call. */
export type HttpRelayMirror = CliCallEntry<HttpCallInput, Response, HttpRelayCallContext>;

/** Exactly two D35 registrations for one configured REST surface. */
export interface HttpMirrorEntries<Seed extends object = Record<never, never>> {
  /** Direct catalog invocation with local env-only credentials. */
  readonly local: HttpLocalMirror<Seed>;
  /** One exact-origin Fetch call with no local lookup or fallback. */
  readonly relay: HttpRelayMirror;
}

/** Returns a safe failure without carrying the original exception or wire values. */
function failure(
  category: "input" | "transport",
  code: string,
  message: string,
  stdout = "",
  stderr = "",
  status?: number,
): HttpFailureCallResult {
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

/** Returns a native response together with the invocation's captured output. */
function native<Native>(value: Native, stdout = "", stderr = ""): HttpNativeCallResult<Native> {
  return { kind: "native", value, stdout, stderr };
}

/** Validates REST call input before constructing a relay URL or request. */
function validRelayInput(input: HttpCallInput): HttpFailureCallResult | undefined {
  if (
    typeof input.method !== "string" ||
    typeof input.fullPath !== "string" ||
    !["GET", "POST", "PUT", "PATCH", "DELETE"].includes(input.method.toUpperCase()) ||
    !input.fullPath.startsWith("/") ||
    input.fullPath.startsWith("//") ||
    input.fullPath.includes("#")
  ) {
    return failure("input", "INVALID_CALL", "REST method and absolute full path are required");
  }
  if (
    input.body !== undefined &&
    (typeof input.body !== "object" || input.body === null || Array.isArray(input.body))
  ) {
    return failure("input", "INVALID_BODY", "Request body must be a JSON object");
  }
  return undefined;
}

/** Creates the direct catalog/declaration mirror for generated local REST calls. */
export function createHttpLocalMirror<Seed extends object = Record<never, never>>(
  /** Immutable catalog shared with native REST dispatch and discovery. */
  catalog: HttpRouteCatalog,
): HttpLocalMirror<Seed> {
  return {
    async invoke(input, context) {
      const bound = bindHttpCall(catalog, input);
      if (!bound.ok) {
        return failure("input", bound.code, bound.message, "", "", bound.status);
      }
      if (context.signal.aborted) return failure("transport", "CALL_ABORTED", "REST call was aborted");

      const base: InvocationBase<Seed> = {
        source: "local",
        env: context.env,
        locals: { ...context.locals } as Seed,
        signal: context.signal,
        surface: "http",
      };
      const outcome = await invokeRegisteredHttpRoute(bound.route, bound.rawInputs, base);
      if (context.signal.aborted) {
        return failure("transport", "CALL_ABORTED", "REST call was aborted", outcome.stdout, outcome.stderr);
      }
      return native(encodeHttpOutcome(outcome, bound.route), outcome.stdout, outcome.stderr);
    },
  };
}

/** Creates the explicit one-request relay mirror for generated REST calls. */
export function createHttpRelayMirror(): HttpRelayMirror {
  return {
    async invoke(input, context) {
      const invalid = validRelayInput(input);
      if (invalid !== undefined) return invalid;
      if (
        !["http:", "https:"].includes(context.url.protocol) ||
        context.url.username.length > 0 ||
        context.url.password.length > 0 ||
        context.url.pathname !== "/" ||
        context.url.search.length > 0 ||
        context.url.hash.length > 0
      ) {
        return failure("input", "INVALID_RELAY_URL", "REST relay requires an HTTP(S) origin");
      }

      let url: URL;
      try {
        url = new URL(`${context.url.origin}${input.fullPath}`);
        if (url.origin !== context.url.origin) throw new TypeError("Origin changed");
      } catch {
        return failure("input", "INVALID_CALL", "REST full path is not valid");
      }

      const headers = new Headers();
      for (const [name, value] of context.headers) headers.append(name, value);
      let body: string | undefined;
      if (input.body !== undefined) {
        try {
          body = JSON.stringify(input.body);
        } catch {
          return failure("input", "INVALID_BODY", "Request body must be JSON serializable");
        }
        if (body === undefined) {
          return failure("input", "INVALID_BODY", "Request body must be JSON serializable");
        }
        headers.set("content-type", "application/json; charset=utf-8");
      }

      try {
        const response = await context.fetch(url, {
          method: input.method.toUpperCase(),
          headers,
          signal: context.signal,
          redirect: "manual",
          ...(body === undefined ? {} : { body }),
        });
        if (!(response instanceof Response)) {
          return failure("transport", "INVALID_RESPONSE", "REST relay returned an invalid response");
        }
        if (context.signal.aborted) return failure("transport", "CALL_ABORTED", "REST call was aborted");
        return native(response);
      } catch {
        if (context.signal.aborted) {
          return failure("transport", "CALL_ABORTED", "REST call was aborted");
        }
        return failure("transport", "CALL_TRANSPORT_ERROR", "REST relay request failed");
      }
    },
  };
}

/** Creates the paired local and relay registrations consumed by the generated REST command. */
export function createHttpMirror<Seed extends object = Record<never, never>>(
  /** Fixed catalog retained only by the local registration. */
  catalog: HttpRouteCatalog,
): HttpMirrorEntries<Seed> {
  return Object.freeze({
    local: createHttpLocalMirror<Seed>(catalog),
    relay: createHttpRelayMirror(),
  });
}

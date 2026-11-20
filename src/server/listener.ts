/*
Shared Node HTTP listener: validates fixed mounts and binds, bridges Web requests and responses,
and owns transport-local streaming, rollback, draining, force, and socket cleanup.
*/

import { randomUUID } from "node:crypto";
import { lstat, rename, unlink } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { normalize as normalizePath } from "node:path";
import type { Readable } from "node:stream";
import { Readable as NodeReadable } from "node:stream";

/** A synchronous or asynchronous value returned by an HTTP mount. */
export type MaybePromise<T> = T | Promise<T>;

/** One normalized path ownership claim made by a mount. */
export type HttpMountClaim =
  | {
      /** Matches only the exact absolute pathname. */
      readonly kind: "exact";
      /** Normalized absolute pathname owned by the mount. */
      readonly path: string;
    }
  | {
      /** Matches the absolute pathname and its slash-delimited descendants. */
      readonly kind: "prefix";
      /** Normalized absolute pathname owned by the mount. */
      readonly path: string;
    };

/** Transport-local context supplied to an HTTP mount. */
export interface HttpMountContext {
  /** Exact Web request abort signal, suitable for adapter invocation. */
  readonly signal: AbortSignal;
}

/** One fixed protocol-neutral HTTP mount. */
export interface HttpMount {
  /** Flat exact and prefix pathname claims compiled before binding. */
  readonly claims: readonly HttpMountClaim[];
  /** Handles one dispatched native Web request without receiving Node transport objects. */
  handle(request: Request, context: HttpMountContext): MaybePromise<Response>;
}

/** One validated package-internal HTTP listen target. */
export type HttpListenTarget =
  | {
      /** Selects a TCP endpoint. */
      readonly kind: "tcp";
      /** Host passed to Node's TCP listen operation. */
      readonly host: string;
      /** Integer TCP port, including zero for an ephemeral port. */
      readonly port: number;
    }
  | {
      /** Selects a Unix-domain socket endpoint. */
      readonly kind: "unix";
      /** Absolute normalized socket path. */
      readonly path: string;
    };

/** Immutable actual address facts for one successfully bound endpoint. */
export type HttpBoundAddress =
  | {
      /** Identifies a TCP endpoint. */
      readonly kind: "tcp";
      /** Actual bound host text reported by Node. */
      readonly host: string;
      /** Actual bound TCP port, including a resolved ephemeral port. */
      readonly port: number;
      /** Complete listener origin for ordinary HTTP requests. */
      readonly url: string;
    }
  | {
      /** Identifies a Unix-domain endpoint. */
      readonly kind: "unix";
      /** Absolute path of the bound Unix socket. */
      readonly path: string;
    };

/** Current terminal lifecycle phase of a running listener. */
export type HttpListenerState = "running" | "draining" | "forcing" | "closed" | "failed";

/** Bounded shutdown policy selected by the first stop call. */
export interface HttpStopOptions {
  /** Milliseconds to wait for transport-active work before forced termination. */
  readonly forceAfterMs?: number;
}

/** Package-internal running listener and its single terminal lifecycle. */
export interface HttpListenerHandle {
  /** Frozen actual bind facts in target order. */
  readonly addresses: readonly HttpBoundAddress[];
  /** Live current lifecycle phase. */
  readonly state: HttpListenerState;
  /** Promise shared by the listener lifetime and every stop call. */
  readonly terminal: Promise<void>;
  /** Drains, then forces the remaining transport work after the accepted deadline. */
  stop(options?: HttpStopOptions): Promise<void>;
}

/** Number of milliseconds a stop waits by default before forcing transport cleanup. */
const DEFAULT_FORCE_AFTER_MS = 10_000;

/** A transport error used only when a client disconnects an active bridge. */
class HttpTransportAbort extends Error {
  /** Creates a recognizable client-disconnect or force error. */
  constructor(message: string) {
    super(message);
    this.name = "HttpTransportAbort";
  }
}

/** Promise controls used for one listener barrier or terminal transition. */
interface Deferred {
  /** Promise exposed to the listener lifecycle. */
  readonly promise: Promise<void>;
  /** Resolves the shared promise once. */
  resolve(): void;
  /** Rejects the shared promise once. */
  reject(error: unknown): void;
}

/** One captured Unix socket identity that makes cleanup replacement-safe. */
interface UnixSocketIdentity {
  /** Normalized socket path captured after successful bind. */
  readonly path: string;
  /** Device identifier captured from the bound socket. */
  readonly dev: number;
  /** Inode identifier captured from the bound socket. */
  readonly ino: number;
}

/** One Node endpoint retained by the listener lifecycle. */
interface ListenerEndpoint {
  /** Normalized target used for this endpoint. */
  readonly target: HttpListenTarget;
  /** Node HTTP server. */
  readonly server: Server;
  /** Frozen actual bind facts after startup. */
  address: HttpBoundAddress;
  /** Private identity of an owned Unix socket, when captured. */
  unixIdentity?: UnixSocketIdentity;
  /** One shared close promise, if close has started. */
  closePromise?: Promise<void>;
  /** Unix path whose newly bound identity could not be captured and must be preserved on close. */
  unverifiedUnixPath?: string;
  /** Foreign replacement temporarily moved aside while Node closes its Unix handle. */
  preservedForeignPath?: {
    /** Original externally supplied path. */
    readonly path: string;
    /** Temporary identity-preserving sibling name. */
    readonly temporary: string;
  };
}

/** Transport-active request and response bridge state. */
interface ActiveRequest {
  /** Controller whose dependent signal is attached to the Web request. */
  readonly controller: AbortController;
  /** Incoming Node request. */
  readonly request: IncomingMessage;
  /** Outgoing Node response. */
  readonly response: ServerResponse;
  /** Current Web response reader, once a response body starts streaming. */
  reader?: ReadableStreamDefaultReader<Uint8Array>;
}

/** Compiled immutable claim registration used by one dispatcher. */
interface CompiledMount {
  /** Registered mount handler. */
  readonly mount: HttpMount;
  /** Exact claims owned by this mount. */
  readonly exact: readonly HttpMountClaim[];
  /** Prefix claims owned by this mount. */
  readonly prefix: readonly HttpMountClaim[];
}

/** Creates a manually settled promise without exposing any mutable terminal state. */
function deferred(): Deferred {
  let resolvePromise: () => void = () => {};
  let rejectPromise: (error: unknown) => void = () => {};
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  let settled = false;
  return {
    promise,
    resolve: () => {
      if (settled) return;
      settled = true;
      resolvePromise();
    },
    reject: (error) => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    },
  };
}

/** Validates and returns one normalized absolute, segment-oriented HTTP pathname. */
function normalizeMountPath(path: string): string {
  if (!path.startsWith("/") || path.includes("\\") || path.includes("?") || path.includes("#") || path.includes("\0")) {
    throw new TypeError(`HTTP mount path must be an absolute normalized pathname: ${JSON.stringify(path)}`);
  }
  if (path.length > 1 && path.endsWith("/")) {
    throw new TypeError(`HTTP mount path must not have a trailing slash: ${JSON.stringify(path)}`);
  }
  const segments = path.split("/");
  if (path !== "/" && segments.slice(1).some((segment) => segment.length === 0)) {
    throw new TypeError(`HTTP mount path must not contain empty segments: ${JSON.stringify(path)}`);
  }
  const normalized = segments.filter((segment, index) => !(index === 0 && segment === "")).join("/");
  if (`/${normalized}` !== path || path.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new TypeError(`HTTP mount path is not normalized: ${JSON.stringify(path)}`);
  }
  return path;
}

/** Returns whether `path` is the claim or one of its slash-delimited descendants. */
function isPathAtOrInside(path: string, claim: string): boolean {
  if (claim === "/") return path.startsWith("/");
  return path === claim || path.startsWith(`${claim}/`);
}

/** Returns whether two compiled claims overlap at HTTP segment granularity. */
function claimsOverlap(left: HttpMountClaim, right: HttpMountClaim): boolean {
  if (left.kind === "exact" && right.kind === "exact") return left.path === right.path;
  if (left.kind === "prefix" && right.kind === "prefix") {
    return isPathAtOrInside(left.path, right.path) || isPathAtOrInside(right.path, left.path);
  }
  const exact = left.kind === "exact" ? left : right;
  const prefix = left.kind === "prefix" ? left : right;
  return isPathAtOrInside(exact.path, prefix.path);
}

/** Compiles and validates all mount claims before any endpoint opens. */
function compileMounts(mounts: readonly HttpMount[]): {
  /** Frozen compiled registrations in source order. */
  readonly mounts: readonly CompiledMount[];
  /** Flat claims retained for deterministic overlap validation. */
  readonly claims: readonly HttpMountClaim[];
} {
  if (mounts.length === 0) throw new TypeError("HTTP listener requires at least one mount");
  const compiled: CompiledMount[] = [];
  const allClaims: HttpMountClaim[] = [];
  for (const mount of mounts) {
    if (mount.claims.length === 0) throw new TypeError("HTTP mount requires at least one path claim");
    const claims = mount.claims.map((claim) => {
      if (claim.kind !== "exact" && claim.kind !== "prefix") {
        throw new TypeError(`Unsupported HTTP mount claim kind: ${String((claim as { kind: unknown }).kind)}`);
      }
      const normalized = normalizeMountPath(claim.path);
      return Object.freeze({ kind: claim.kind, path: normalized } as HttpMountClaim);
    });
    for (const claim of claims) {
      if (allClaims.some((registered) => claimsOverlap(claim, registered))) {
        throw new TypeError(`Overlapping HTTP mount claim: ${claim.kind} ${claim.path}`);
      }
      allClaims.push(claim);
    }
    compiled.push(
      Object.freeze({
        mount,
        exact: Object.freeze(claims.filter((claim) => claim.kind === "exact")),
        prefix: Object.freeze(claims.filter((claim) => claim.kind === "prefix")),
      }),
    );
  }
  return { mounts: Object.freeze(compiled), claims: Object.freeze(allClaims) };
}

/** Validates and freezes one normalized listener target. */
function normalizeTarget(target: HttpListenTarget): HttpListenTarget {
  if (target.kind === "tcp") {
    if (target.host.length === 0 || target.host.trim() !== target.host || target.host.includes("\0")) {
      throw new TypeError("TCP listen host must be non-empty normalized text");
    }
    if (!Number.isInteger(target.port) || target.port < 0 || target.port > 65_535) {
      throw new TypeError(`TCP listen port must be an integer from 0 through 65535: ${target.port}`);
    }
    return Object.freeze({ kind: "tcp", host: target.host, port: target.port });
  }
  if (target.kind !== "unix") {
    throw new TypeError(`Unsupported HTTP listen target kind: ${String((target as { kind: unknown }).kind)}`);
  }
  if (!target.path.startsWith("/") || target.path.includes("\0") || normalizePath(target.path) !== target.path) {
    throw new TypeError(`Unix listen path must be absolute and normalized: ${JSON.stringify(target.path)}`);
  }
  if (target.path === "/") throw new TypeError("Unix listen path must name a socket file");
  return Object.freeze({ kind: "unix", path: target.path });
}

/** Validates all targets and rejects duplicate effective binds before listening. */
function normalizeTargets(targets: readonly HttpListenTarget[]): readonly HttpListenTarget[] {
  if (targets.length === 0) throw new TypeError("HTTP listener requires at least one target");
  const normalized = targets.map(normalizeTarget);
  const seen = new Set<string>();
  for (const target of normalized) {
    const key =
      target.kind === "tcp"
        ? `tcp:${target.host.length}:${target.host}:${target.port}`
        : `unix:${target.path.length}:${target.path}`;
    if (seen.has(key)) throw new TypeError(`Duplicate HTTP listen target: ${key}`);
    seen.add(key);
  }
  return Object.freeze(normalized);
}

/** Returns a stable URL origin for one bound TCP endpoint. */
function addressUrl(host: string, port: number): string {
  const urlHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${urlHost}:${port}`;
}

/** Builds an immutable public bind fact from Node's actual address. */
function boundAddress(endpoint: ListenerEndpoint): HttpBoundAddress {
  const address = endpoint.server.address();
  if (endpoint.target.kind === "unix") {
    if (typeof address !== "string") throw new Error("Unix HTTP endpoint did not report its socket path");
    return Object.freeze({ kind: "unix", path: address });
  }
  if (address === null || typeof address === "string") {
    throw new Error("TCP HTTP endpoint did not report a network address");
  }
  return Object.freeze({
    kind: "tcp",
    host: address.address,
    port: address.port,
    url: addressUrl(address.address, address.port),
  });
}

/** Returns all raw incoming request headers without folding repeated values. */
function requestHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index];
    const value = request.rawHeaders[index + 1];
    if (name !== undefined && value !== undefined) headers.append(name, value);
  }
  return headers;
}

/** Builds the complete absolute request URL retained by the mount. */
function requestUrl(request: IncomingMessage, target: HttpListenTarget): string {
  const host = request.headers.host;
  if (host !== undefined) {
    try {
      return new URL(request.url ?? "/", `http://${host}`).href;
    } catch {
      // A malformed Host header must not become an adapter input.
    }
  }
  if (target.kind === "tcp") return new URL(request.url ?? "/", addressUrl(target.host, target.port)).href;
  return new URL(request.url ?? "/", "http://localhost").href;
}

/** Converts a Node stream to a Web stream while retaining pull-through delivery. */
function webRequestBody(request: IncomingMessage): ReadableStream<Uint8Array> {
  return NodeReadable.toWeb(request as Readable) as ReadableStream<Uint8Array>;
}

/** Builds one native Fetch request whose signal is controlled by this transport request. */
function toWebRequest(active: ActiveRequest, target: HttpListenTarget): Request {
  const method = active.request.method ?? "GET";
  const init: RequestInit & { duplex?: "half" } = {
    method,
    headers: requestHeaders(active.request),
    signal: active.controller.signal,
  };
  if (method !== "GET" && method !== "HEAD") {
    init.body = webRequestBody(active.request);
    init.duplex = "half";
  }
  return new Request(requestUrl(active.request, target), init);
}

/** Selects exactly one mount for an already validated registration set. */
function mountForPath(mounts: readonly CompiledMount[], pathname: string): HttpMount | undefined {
  for (const compiled of mounts) {
    if (compiled.exact.some((claim) => claim.path === pathname)) return compiled.mount;
  }
  for (const compiled of mounts) {
    if (compiled.prefix.some((claim) => isPathAtOrInside(pathname, claim.path))) return compiled.mount;
  }
  return undefined;
}

/** Appends one set of Node response headers while preserving every Set-Cookie value. */
function responseHeaders(response: Response): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, name) => {
    if (name !== "set-cookie") headers[name] = value;
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) headers["set-cookie"] = cookies;
  return headers;
}

/** Returns whether this method/status pair suppresses an HTTP response body. */
function suppressResponseBody(method: string, response: Response): boolean {
  return (
    method === "HEAD" ||
    (response.status >= 100 && response.status < 200) ||
    response.status === 204 ||
    response.status === 205 ||
    response.status === 304
  );
}

/** Cancels one response reader without allowing late stream errors to escape. */
async function cancelReader(active: ActiveRequest, reason: unknown): Promise<void> {
  const reader = active.reader;
  active.reader = undefined;
  if (reader === undefined) return;
  try {
    await reader.cancel(reason);
  } catch {
    // A disconnect/force is already terminal for this transport stream.
  }
}

/** Aborts one request signal and removes it from listener drain accounting. */
function terminateActive(activeRequests: Set<ActiveRequest>, active: ActiveRequest, reason: unknown): void {
  if (!active.controller.signal.aborted) active.controller.abort(reason);
  activeRequests.delete(active);
  void cancelReader(active, reason);
  if (!active.response.destroyed) active.response.destroy();
}

/** Waits for response backpressure to drain or for transport termination. */
function waitForDrain(active: ActiveRequest): Promise<void> {
  if (active.response.destroyed || active.response.writableEnded) {
    return Promise.reject(new HttpTransportAbort("HTTP client disconnected"));
  }
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      active.response.off("drain", onDrain);
      active.response.off("close", onClose);
      active.response.off("error", onError);
    };
    const onDrain = (): void => {
      cleanup();
      resolve();
    };
    const onClose = (): void => {
      cleanup();
      reject(new HttpTransportAbort("HTTP response closed before drain"));
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    active.response.once("drain", onDrain);
    active.response.once("close", onClose);
    active.response.once("error", onError);
  });
}

/** Writes one native Web response incrementally into a Node response. */
async function writeWebResponse(
  activeRequests: Set<ActiveRequest>,
  active: ActiveRequest,
  request: Request,
  response: Response,
): Promise<void> {
  if (!activeRequests.has(active)) {
    await response.body?.cancel(new HttpTransportAbort("HTTP request already disconnected"));
    return;
  }
  const headers = responseHeaders(response);
  if (suppressResponseBody(request.method, response) || response.body === null) {
    if (response.statusText.length > 0) {
      active.response.writeHead(response.status, response.statusText, headers);
    } else {
      active.response.writeHead(response.status, headers);
    }
    active.response.end();
    await response.body?.cancel();
    return;
  }

  const reader = response.body.getReader();
  active.reader = reader;
  if (response.statusText.length > 0) {
    active.response.writeHead(response.status, response.statusText, headers);
  } else {
    active.response.writeHead(response.status, headers);
  }
  while (activeRequests.has(active)) {
    const read = await reader.read();
    if (read.done) {
      active.reader = undefined;
      active.response.end();
      return;
    }
    if (!activeRequests.has(active)) break;
    if (!active.response.write(read.value) && activeRequests.has(active)) {
      await waitForDrain(active);
    }
  }
  active.reader = undefined;
  await cancelReader(active, new HttpTransportAbort("HTTP client disconnected"));
}

/** Sends one listener-owned generic response when a mount cannot be entered. */
function genericNodeResponse(response: ServerResponse, status: number, message: string): void {
  if (response.destroyed || response.writableEnded) return;
  if (!response.headersSent) {
    response.writeHead(status, {
      "content-length": Buffer.byteLength(message),
      "content-type": "text/plain; charset=utf-8",
    });
  }
  response.end(message);
}

/** Processes one Node request after the shared startup barrier opens. */
async function dispatchNodeRequest(
  activeRequests: Set<ActiveRequest>,
  mounts: readonly CompiledMount[],
  target: HttpListenTarget,
  request: IncomingMessage,
  response: ServerResponse,
  onRequestSettled: () => void,
): Promise<void> {
  const controller = new AbortController();
  const active: ActiveRequest = { controller, request, response };
  activeRequests.add(active);

  const onRequestAbort = (error: unknown): void => {
    terminateActive(activeRequests, active, error ?? new HttpTransportAbort("HTTP request was aborted"));
    onRequestSettled();
  };
  request.once("aborted", () => onRequestAbort(new HttpTransportAbort("HTTP request was aborted")));
  request.once("error", onRequestAbort);
  response.once("error", onRequestAbort);
  response.once("finish", () => {
    activeRequests.delete(active);
    onRequestSettled();
  });
  response.once("close", () => {
    if (!response.writableFinished) {
      terminateActive(activeRequests, active, new HttpTransportAbort("HTTP response closed before completion"));
    } else {
      activeRequests.delete(active);
    }
    onRequestSettled();
  });

  try {
    const webRequest = toWebRequest(active, target);
    const mount = mountForPath(mounts, new URL(webRequest.url).pathname);
    const mountResponse =
      mount === undefined
        ? new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } })
        : await mount.handle(webRequest, { signal: webRequest.signal });
    await writeWebResponse(activeRequests, active, webRequest, mountResponse);
  } catch {
    if (!activeRequests.has(active)) return;
    if (!response.headersSent) {
      genericNodeResponse(response, 500, "Internal Server Error");
    } else {
      terminateActive(activeRequests, active, new HttpTransportAbort("HTTP response stream failed"));
    }
  } finally {
    if (response.writableFinished) {
      activeRequests.delete(active);
      onRequestSettled();
    }
  }
}

/** Captures a newly bound Unix socket's private dev/inode identity. */
async function captureUnixIdentity(endpoint: ListenerEndpoint): Promise<void> {
  if (endpoint.target.kind !== "unix") return;
  const stat = await lstat(endpoint.target.path);
  if (!stat.isSocket()) throw new Error(`Bound Unix path is not a socket: ${endpoint.target.path}`);
  endpoint.unixIdentity = Object.freeze({
    path: endpoint.target.path,
    dev: stat.dev,
    ino: stat.ino,
  });
}

/** Closes one endpoint exactly once and remembers a shared close promise. */
function closeEndpoint(endpoint: ListenerEndpoint): Promise<void> {
  if (endpoint.closePromise !== undefined) return endpoint.closePromise;
  endpoint.closePromise = (async () => {
    await preserveForeignUnixReplacement(endpoint);
    let closeError: unknown;
    try {
      await new Promise<void>((resolve, reject) => {
        if (!endpoint.server.listening) {
          resolve();
          return;
        }
        endpoint.server.close((error) => {
          endpoint.server.closeIdleConnections?.();
          if (error === undefined) resolve();
          else reject(error);
        });
        endpoint.server.closeIdleConnections?.();
      });
    } catch (error) {
      closeError = error;
    }
    try {
      await restoreForeignUnixReplacement(endpoint);
    } catch (restoreError) {
      if (closeError === undefined) throw restoreError;
    }
    if (closeError !== undefined) throw closeError;
  })();
  return endpoint.closePromise;
}

/** Moves aside a foreign path Node would otherwise unlink while closing a Unix server. */
async function preserveForeignUnixReplacement(endpoint: ListenerEndpoint): Promise<void> {
  const identity = endpoint.unixIdentity;
  if (endpoint.preservedForeignPath !== undefined) return;
  const path = identity?.path ?? endpoint.unverifiedUnixPath;
  if (path === undefined) return;
  try {
    const stat = await lstat(path);
    if (identity !== undefined && stat.dev === identity.dev && stat.ino === identity.ino) return;
    const temporary = `${path}.argsbarg-preserved-${randomUUID()}`;
    await rename(path, temporary);
    endpoint.preservedForeignPath = { path, temporary };
  } catch (error) {
    if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") throw error;
  }
}

/** Restores an externally replaced Unix path after Node's close cleanup completes. */
async function restoreForeignUnixReplacement(endpoint: ListenerEndpoint): Promise<void> {
  const preserved = endpoint.preservedForeignPath;
  if (preserved === undefined) return;
  await rename(preserved.temporary, preserved.path);
  endpoint.preservedForeignPath = undefined;
}

/** Removes only a still identity-matching Unix socket owned by this runtime. */
async function cleanupUnixEndpoint(endpoint: ListenerEndpoint): Promise<void> {
  const identity = endpoint.unixIdentity;
  if (identity === undefined) return;
  try {
    const stat = await lstat(identity.path);
    if (stat.dev === identity.dev && stat.ino === identity.ino) await unlink(identity.path);
  } catch (error) {
    if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") throw error;
  }
}

/** Closes and identity-cleans one set of acquired endpoints in reverse target order. */
async function rollbackEndpoints(endpoints: readonly ListenerEndpoint[]): Promise<void> {
  for (const endpoint of [...endpoints].reverse()) {
    try {
      await closeEndpoint(endpoint);
    } catch {
      // Rollback preserves the original startup/runtime failure.
    }
    try {
      await cleanupUnixEndpoint(endpoint);
    } catch {
      // Rollback preserves the original startup/runtime failure.
    }
  }
}

/** Binds one endpoint and records Node's actual address plus Unix ownership evidence. */
async function bindEndpoint(endpoint: ListenerEndpoint): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      endpoint.server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      endpoint.server.off("error", onError);
      resolve();
    };
    endpoint.server.once("error", onError);
    endpoint.server.once("listening", onListening);
    if (endpoint.target.kind === "tcp") {
      endpoint.server.listen(endpoint.target.port, endpoint.target.host);
    } else {
      endpoint.server.listen(endpoint.target.path);
    }
  });
  endpoint.address = boundAddress(endpoint);
  try {
    await captureUnixIdentity(endpoint);
  } catch (error) {
    if (endpoint.target.kind === "unix") endpoint.unverifiedUnixPath = endpoint.target.path;
    throw error;
  }
}

/** Starts a validated multi-bind HTTP listener behind one shared dispatch barrier. */
export async function startHttpListener(options: {
  /** Fixed protocol mounts compiled as one request dispatcher. */
  readonly mounts: readonly HttpMount[];
  /** Serial bind plan for all desired endpoints. */
  readonly targets: readonly HttpListenTarget[];
}): Promise<HttpListenerHandle> {
  const compiled = compileMounts(options.mounts);
  const targets = normalizeTargets(options.targets);
  const barrier = deferred();
  void barrier.promise.catch(() => {});
  const terminal = deferred();
  const activeRequests = new Set<ActiveRequest>();
  const endpoints: ListenerEndpoint[] = [];
  let state: HttpListenerState = "running";
  let stopTimer: NodeJS.Timeout | undefined;
  let stopStarted = false;
  let failureStarted = false;
  let completionStarted = false;

  const notifyRequestSettlement = (): void => {
    if (!stopStarted || completionStarted || state === "failed") return;
    if (activeRequests.size > 0) return;
    for (const endpoint of endpoints) endpoint.server.closeIdleConnections?.();
    if (endpoints.some((endpoint) => endpoint.closePromise === undefined)) return;
    completionStarted = true;
    if (stopTimer !== undefined) clearTimeout(stopTimer);
    void Promise.all(endpoints.map(closeEndpoint))
      .then(() => Promise.all([...endpoints].reverse().map(cleanupUnixEndpoint)))
      .then(() => {
        state = "closed";
        terminal.resolve();
      })
      .catch((error: unknown) => {
        state = "failed";
        terminal.reject(error);
      });
  };

  const force = (): void => {
    if (!stopStarted || state !== "draining") return;
    state = "forcing";
    const reason = new HttpTransportAbort("HTTP listener stop deadline elapsed");
    for (const active of [...activeRequests]) terminateActive(activeRequests, active, reason);
    for (const endpoint of endpoints) endpoint.server.closeAllConnections?.();
    notifyRequestSettlement();
  };

  const fail = (error: unknown): void => {
    if (failureStarted || state === "closed" || state === "failed") return;
    failureStarted = true;
    state = "failed";
    if (stopTimer !== undefined) clearTimeout(stopTimer);
    const reason = error instanceof Error ? error : new Error("HTTP listener failed");
    for (const active of [...activeRequests]) terminateActive(activeRequests, active, reason);
    void rollbackEndpoints(endpoints).then(
      () => terminal.reject(reason),
      () => terminal.reject(reason),
    );
  };

  const handle: HttpListenerHandle = {
    addresses: Object.freeze([]),
    terminal: terminal.promise,
    get state() {
      return state;
    },
    stop: (stopOptions = {}) => {
      if (stopStarted || state === "closed" || state === "failed") return terminal.promise;
      const forceAfterMs = stopOptions.forceAfterMs ?? DEFAULT_FORCE_AFTER_MS;
      if (!Number.isInteger(forceAfterMs) || forceAfterMs < 0) {
        throw new RangeError("HTTP listener forceAfterMs must be a finite non-negative integer");
      }
      stopStarted = true;
      state = "draining";
      for (const endpoint of endpoints) void closeEndpoint(endpoint).then(notifyRequestSettlement, fail);
      stopTimer = setTimeout(force, forceAfterMs);
      notifyRequestSettlement();
      return terminal.promise;
    },
  };

  try {
    for (const target of targets) {
      const endpoint: ListenerEndpoint = {
        target,
        server: createServer((request, response) => {
          void barrier.promise.then(
            () =>
              dispatchNodeRequest(activeRequests, compiled.mounts, target, request, response, notifyRequestSettlement),
            () => genericNodeResponse(response, 503, "Service Unavailable"),
          );
        }),
        address: Object.freeze({ kind: "unix", path: "" }),
      };
      endpoints.push(endpoint);
      await bindEndpoint(endpoint);
    }
    for (const endpoint of endpoints) {
      endpoint.server.on("error", fail);
      endpoint.server.on("close", () => {
        if (!stopStarted && state === "running") fail(new Error("HTTP listener endpoint closed unexpectedly"));
      });
    }
    const addresses = Object.freeze(endpoints.map((endpoint) => endpoint.address));
    Object.defineProperty(handle, "addresses", { value: addresses, enumerable: true });
    barrier.resolve();
    return handle;
  } catch (error) {
    barrier.reject(error);
    await rollbackEndpoints(endpoints);
    throw error;
  }
}

/*
Focused listener tests for mount ownership, Web/Node streaming, backpressure-facing I/O,
disconnect cancellation, bind rollback, Unix identity cleanup, and bounded lifecycle state.
*/

import assert from "node:assert/strict";
import { unlinkSync, writeFileSync } from "node:fs";
import { lstat, mkdtemp, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { get as httpGet, ServerResponse as NodeServerResponse } from "node:http";
import { createConnection, Server as NodeServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  type HttpBoundAddress,
  type HttpListenerHandle,
  type HttpListenTarget,
  type HttpMount,
  startHttpListener,
} from "./listener.ts";

/** One accepted loopback target using an ephemeral TCP port. */
const LOOPBACK: HttpListenTarget = { kind: "tcp", host: "127.0.0.1", port: 0 };

/** Creates one promise with a retained zero-argument resolver. */
function resolvable(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolvePromise: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: () => resolvePromise() };
}

/** Extracts the first TCP address from a started listener. */
function firstTcp(handle: HttpListenerHandle): Extract<HttpBoundAddress, { kind: "tcp" }> {
  const address = handle.addresses[0];
  if (address === undefined || address.kind !== "tcp") throw new Error("Expected a TCP listener address");
  return address;
}

/** Starts one listener with a caller-supplied prefix mount. */
async function startMount(mount: HttpMount, targets: readonly HttpListenTarget[] = [LOOPBACK]) {
  return startHttpListener({ mounts: [mount], targets });
}

/** Returns a one-line exact mount registration. */
function exactMount(path: string, handle: HttpMount["handle"]): HttpMount {
  return { claims: [{ kind: "exact", path }], handle };
}

/** Waits until a caller-supplied condition becomes true. */
async function waitUntil(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for listener state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Opens a raw loopback socket against one bound TCP address. */
function openSocket(address: Extract<HttpBoundAddress, { kind: "tcp" }>): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(address.port, address.host);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

/** Waits for raw socket text to contain the requested marker. */
function waitForSocketText(socket: Socket, marker: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${JSON.stringify(marker)} in raw response`));
    }, 2_000);
    const cleanup = (): void => {
      clearTimeout(timeout);
      socket.off("data", onData);
      socket.off("error", onError);
    };
    const onData = (chunk: Buffer): void => {
      text += chunk.toString("utf8");
      if (text.includes(marker)) {
        cleanup();
        resolve(text);
      }
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    socket.on("data", onData);
    socket.on("error", onError);
  });
}

/** Waits for a raw socket to finish and returns its complete response text. */
function socketEnd(socket: Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      text += chunk;
    });
    socket.once("end", () => resolve(text));
    socket.once("error", reject);
  });
}

/** Returns whether a path exists without treating ENOENT as an error. */
async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

describe("listener mount dispatcher", () => {
  test("dispatches exact before prefix and returns a generic 404 without fallback", async () => {
    const calls: string[] = [];
    const handle = await startHttpListener({
      mounts: [
        {
          claims: [
            { kind: "prefix", path: "/api" },
            { kind: "exact", path: "/health/liveness" },
          ],
          handle: (request) => {
            calls.push(`rest:${new URL(request.url).pathname}`);
            return new Response("rest");
          },
        },
        exactMount("/exact", () => {
          calls.push("exact");
          return new Response("exact");
        }),
      ],
      targets: [LOOPBACK],
    });
    const address = firstTcp(handle);
    assert.equal(await (await fetch(`${address.url}/api/report`)).text(), "rest");
    assert.equal(await (await fetch(`${address.url}/health/liveness`)).text(), "rest");
    assert.equal(await (await fetch(`${address.url}/exact`)).text(), "exact");
    const missing = await fetch(`${address.url}/missing`);
    assert.equal(missing.status, 404);
    assert.equal(await missing.text(), "Not found");
    assert.deepEqual(calls, ["rest:/api/report", "rest:/health/liveness", "exact"]);
    await handle.stop({ forceAfterMs: 0 });
  });

  test("rejects invalid, duplicate, and overlapping claims before binding", async () => {
    await assert.rejects(
      startHttpListener({
        mounts: [exactMount("relative", () => new Response())],
        targets: [LOOPBACK],
      }),
      /absolute normalized pathname/,
    );
    await assert.rejects(
      startHttpListener({
        mounts: [exactMount("/api//reports", () => new Response())],
        targets: [LOOPBACK],
      }),
      /empty segments/,
    );
    await assert.rejects(
      startHttpListener({
        mounts: [exactMount("/same", () => new Response()), exactMount("/same", () => new Response())],
        targets: [LOOPBACK],
      }),
      /Overlapping HTTP mount claim/,
    );
    await assert.rejects(
      startHttpListener({
        mounts: [
          { claims: [{ kind: "prefix", path: "/api" }], handle: () => new Response() },
          exactMount("/api/reports", () => new Response()),
        ],
        targets: [LOOPBACK],
      }),
      /Overlapping HTTP mount claim/,
    );
    await assert.doesNotReject(
      startHttpListener({
        mounts: [
          { claims: [{ kind: "prefix", path: "/api" }], handle: () => new Response() },
          { claims: [{ kind: "prefix", path: "/rpc" }], handle: () => new Response() },
        ],
        targets: [],
      }).then(
        () => assert.fail("empty targets should fail"),
        (error) => assert.match(String(error), /at least one target/),
      ),
    );
  });

  test("validates targets and actual addresses without binding duplicates", async () => {
    await assert.rejects(
      startHttpListener({
        mounts: [exactMount("/", () => new Response())],
        targets: [{ kind: "tcp", host: "127.0.0.1", port: 1.5 }],
      }),
      /integer from 0 through 65535/,
    );
    await assert.rejects(
      startHttpListener({
        mounts: [exactMount("/", () => new Response())],
        targets: [LOOPBACK, LOOPBACK],
      }),
      /Duplicate HTTP listen target/,
    );
    const handle = await startMount(exactMount("/", () => new Response("ok")));
    const address = firstTcp(handle);
    assert.ok(address.port > 0);
    assert.equal(address.url, `http://${address.host}:${address.port}`);
    assert.equal(Object.isFrozen(handle.addresses), true);
    assert.equal(Object.isFrozen(address), true);
    await handle.stop({ forceAfterMs: 0 });
  });
});

describe("listener Web and Node streaming bridge", () => {
  test("delivers the first request chunk before the upload ends", async () => {
    let firstChunk = "";
    const handle = await startMount(
      exactMount("/stream", async (request) => {
        const reader = request.body?.getReader();
        assert.ok(reader);
        const read = await reader.read();
        firstChunk = new TextDecoder().decode(read.value);
        return new Response(firstChunk);
      }),
    );
    const address = firstTcp(handle);
    const socket = await openSocket(address);
    socket.write(
      [
        "POST /stream HTTP/1.1",
        `Host: ${address.host}:${address.port}`,
        "Transfer-Encoding: chunked",
        "Connection: close",
        "",
        "1",
        "a",
        "",
      ].join("\r\n"),
    );
    const response = await waitForSocketText(socket, "HTTP/1.1 200");
    assert.match(response, /\r\n1\r\na\r\n/);
    assert.equal(firstChunk, "a");
    socket.destroy();
    await handle.stop({ forceAfterMs: 0 });
  });

  test("streams response chunks pull-by-pull and observes only incremental reads", async () => {
    let pulls = 0;
    let release: (() => void) | undefined;
    const handle = await startMount(
      exactMount("/stream", () => {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("first"));
              return new Promise<void>((resolve) => {
                release = () => {
                  pulls += 1;
                  controller.enqueue(new TextEncoder().encode("second"));
                  controller.close();
                  resolve();
                };
              });
            },
          }),
        );
      }),
    );
    const address = firstTcp(handle);
    const response = await fetch(`${address.url}/stream`);
    const reader = response.body?.getReader();
    assert.ok(reader);
    assert.equal(new TextDecoder().decode((await reader.read()).value), "first");
    assert.equal(pulls, 0);
    await waitUntil(() => release !== undefined);
    release?.();
    assert.equal(new TextDecoder().decode((await reader.read()).value), "second");
    assert.equal((await reader.read()).done, true);
    await handle.stop({ forceAfterMs: 0 });
  });

  test("does not pull after a false response write until drain releases backpressure", async () => {
    const prototype = NodeServerResponse.prototype as unknown as {
      write: (this: NodeServerResponse, ...args: unknown[]) => boolean;
    };
    const originalWrite = prototype.write;
    let blocked: NodeServerResponse | undefined;
    let forced = false;
    let pulls = 0;
    prototype.write = function (...args: unknown[]): boolean {
      const accepted = originalWrite.apply(this, args);
      if (!forced) {
        forced = true;
        blocked = this;
        return false;
      }
      return accepted;
    };

    try {
      const handle = await startMount(
        exactMount("/backpressure", () => {
          return new Response(
            new ReadableStream<Uint8Array>(
              {
                pull(controller) {
                  pulls += 1;
                  controller.enqueue(new TextEncoder().encode(`chunk-${pulls}`));
                  if (pulls === 2) controller.close();
                },
              },
              { highWaterMark: 0 },
            ),
          );
        }),
      );
      try {
        const response = await fetch(`${firstTcp(handle).url}/backpressure`);
        await waitUntil(() => blocked !== undefined);
        assert.equal(pulls, 1);
        blocked?.emit("drain");
        assert.equal(await response.text(), "chunk-1chunk-2");
        assert.equal(pulls, 2);
      } finally {
        await handle.stop({ forceAfterMs: 0 });
      }
    } finally {
      prototype.write = originalWrite;
    }
  });

  test("preserves multiple set-cookie values and suppresses HEAD bodies", async () => {
    const handle = await startMount(
      exactMount("/cookies", () => {
        return new Response("ignored", {
          headers: [
            ["set-cookie", "one=1"],
            ["set-cookie", "two=2"],
          ],
        });
      }),
    );
    const address = firstTcp(handle);
    const response = await fetch(`${address.url}/cookies`, { method: "HEAD" });
    assert.deepEqual(response.headers.getSetCookie(), ["one=1", "two=2"]);
    assert.equal(await response.text(), "");
    await handle.stop({ forceAfterMs: 0 });
  });

  test("normal completed close does not abort the Web request signal", async () => {
    let requestSignal: AbortSignal | undefined;
    const responseReleased = resolvable();
    const handle = await startMount(
      exactMount("/", (request, context) => {
        requestSignal = request.signal;
        assert.equal(context.signal, request.signal);
        responseReleased.resolve();
        return new Response("ok");
      }),
    );
    const address = firstTcp(handle);
    const socket = await openSocket(address);
    const ended = socketEnd(socket);
    socket.end(`GET / HTTP/1.1\r\nHost: ${address.host}:${address.port}\r\nConnection: close\r\n\r\n`);
    await responseReleased.promise;
    assert.match(await ended, /HTTP\/1\.1 200/);
    await waitUntil(() => !requestSignal?.aborted);
    assert.equal(requestSignal?.aborted, false);
    await handle.stop({ forceAfterMs: 0 });
  });

  test("client disconnect aborts only that request and cancels its response reader", async () => {
    let requestSignal: AbortSignal | undefined;
    let cancelCount = 0;
    const started = resolvable();
    const cancelled = resolvable();
    const handle = await startMount({
      claims: [{ kind: "prefix", path: "/" }],
      handle: (request) => {
        requestSignal = request.signal;
        started.resolve();
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("partial"));
            },
            cancel() {
              cancelCount += 1;
              cancelled.resolve();
            },
          }),
        );
      },
    });
    const address = firstTcp(handle);
    const socket = await openSocket(address);
    socket.write(`GET /slow HTTP/1.1\r\nHost: ${address.host}:${address.port}\r\nConnection: close\r\n\r\n`);
    await started.promise;
    await waitForSocketText(socket, "partial");
    socket.destroy();
    await cancelled.promise;
    await waitUntil(() => requestSignal?.aborted === true);
    assert.equal(handle.state, "running");
    assert.equal(cancelCount, 1);
    assert.equal(await (await fetch(`${address.url}/other`)).status, 200);
    await handle.stop({ forceAfterMs: 0 });
  });

  test("mount exceptions and committed stream failures terminate without raw errors", async () => {
    const handle = await startHttpListener({
      mounts: [
        exactMount("/throw", () => {
          throw new Error("secret");
        }),
        exactMount("/fail", () => {
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("before"));
                controller.error(new Error("secret stream failure"));
              },
            }),
          );
        }),
      ],
      targets: [LOOPBACK],
    });
    const address = firstTcp(handle);
    const thrown = await fetch(`${address.url}/throw`);
    assert.equal(thrown.status, 500);
    assert.equal(await thrown.text(), "Internal Server Error");
    await assert.rejects(fetch(`${address.url}/fail`));
    await handle.stop({ forceAfterMs: 0 });
  });
});

describe("listener bind and lifecycle", () => {
  test("serves the same dispatcher over TCP and a Unix socket", { skip: process.platform === "win32" }, async () => {
    const directory = await mkdtemp("/tmp/argsbarg-");
    const path = join(directory, "dual.sock");
    try {
      const handle = await startMount(exactMount("/report", () => new Response("report")), [
        LOOPBACK,
        { kind: "unix", path },
      ]);
      try {
        assert.equal(await (await fetch(`${firstTcp(handle).url}/report`)).text(), "report");
        const unix = await new Promise<string>((resolve, reject) => {
          httpGet({ socketPath: path, path: "/report", signal: AbortSignal.timeout(1000) }, async (response) => {
            try {
              let body = "";
              for await (const chunk of response.setEncoding("utf8")) body += chunk;
              resolve(body);
            } catch (error) {
              reject(error);
            }
          }).on("error", reject);
        });
        assert.equal(unix, "report");
      } finally {
        await handle.stop();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("serially rolls back partial Unix binds and preserves a pre-existing path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "argsbarg-listener-"));
    const first = join(directory, "first.sock");
    const foreign = join(directory, "foreign.sock");
    await writeFile(foreign, "foreign");
    try {
      let dispatches = 0;
      await assert.rejects(
        startMount(
          exactMount("/", () => {
            dispatches += 1;
            return new Response();
          }),
          [
            { kind: "unix", path: first },
            { kind: "unix", path: foreign },
          ],
        ),
      );
      assert.equal(dispatches, 0);
      assert.equal(await pathExists(first), false);
      assert.equal(await readFile(foreign, "utf8"), "foreign");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("preserves a foreign replacement when Unix identity capture fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "argsbarg-listener-"));
    const socketPath = join(directory, "race.sock");
    const prototype = NodeServer.prototype as NodeServer & {
      emit(event: string | symbol, ...args: unknown[]): boolean;
    };
    const originalEmit = prototype.emit;
    let replaced = false;
    prototype.emit = function (event: string | symbol, ...args: unknown[]): boolean {
      if (event === "listening" && this.address() === socketPath && !replaced) {
        replaced = true;
        unlinkSync(socketPath);
        writeFileSync(socketPath, "foreign-replacement");
      }
      return originalEmit.call(this, event, ...args);
    };

    try {
      await assert.rejects(
        startMount(
          exactMount("/", () => new Response()),
          [{ kind: "unix", path: socketPath }],
        ),
        /Bound Unix path is not a socket/,
      );
      assert.equal(replaced, true);
      assert.equal(await readFile(socketPath, "utf8"), "foreign-replacement");
    } finally {
      prototype.emit = originalEmit;
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("publishes Unix facts and unlinks only an identity-matching owned socket", async () => {
    const directory = await mkdtemp(join(tmpdir(), "argsbarg-listener-"));
    const socketPath = join(directory, "owned.sock");
    try {
      const handle = await startMount(
        exactMount("/", () => new Response("unix")),
        [{ kind: "unix", path: socketPath }],
      );
      assert.deepEqual(handle.addresses, [{ kind: "unix", path: socketPath }]);
      const replacement = join(directory, "replacement");
      await writeFile(replacement, "replacement");
      await unlink(socketPath);
      await rename(replacement, socketPath);
      await handle.stop({ forceAfterMs: 0 });
      assert.equal(await readFile(socketPath, "utf8"), "replacement");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("cleans an unchanged owned Unix socket on normal stop", async () => {
    const directory = await mkdtemp(join(tmpdir(), "argsbarg-listener-"));
    const socketPath = join(directory, "owned.sock");
    try {
      const handle = await startMount(
        exactMount("/", () => new Response()),
        [{ kind: "unix", path: socketPath }],
      );
      assert.equal(await pathExists(socketPath), true);
      await handle.stop({ forceAfterMs: 0 });
      assert.equal(await pathExists(socketPath), false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("shares one idempotent stop and forces only active transport work after the deadline", async () => {
    const started = resolvable();
    const cancelled = resolvable();
    const handle = await startMount(
      exactMount("/slow", () => {
        started.resolve();
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("partial"));
            },
            cancel() {
              cancelled.resolve();
            },
          }),
        );
      }),
    );
    const address = firstTcp(handle);
    const responsePromise = fetch(`${address.url}/slow`);
    await started.promise;
    const clientResponse = await responsePromise;
    const reader = clientResponse.body?.getReader();
    assert.ok(reader);
    assert.equal(new TextDecoder().decode((await reader.read()).value), "partial");
    assert.equal(handle.state, "running");
    const stopping = handle.stop({ forceAfterMs: 10 });
    assert.equal(stopping, handle.terminal);
    assert.equal(handle.state, "draining");
    assert.equal(handle.stop({ forceAfterMs: 100_000 }), stopping);
    await stopping;
    assert.equal(handle.state, "closed");
    await cancelled.promise;
    await assert.rejects(reader.read());
  });

  test("drains a completed active response without entering force state", async () => {
    let release: (() => void) | undefined;
    const handle = await startMount(
      exactMount("/drain", () => {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              release = () => {
                controller.enqueue(new TextEncoder().encode("done"));
                controller.close();
              };
            },
          }),
        );
      }),
    );
    const address = firstTcp(handle);
    const response = fetch(`${address.url}/drain`);
    await waitUntil(() => release !== undefined);
    const stopping = handle.stop({ forceAfterMs: 500 });
    assert.equal(handle.state, "draining");
    release?.();
    assert.equal(await (await response).text(), "done");
    await stopping;
    assert.equal(handle.state, "closed");
  });

  test("keeps separate listener runtimes independent", async () => {
    const first = await startMount(exactMount("/", () => new Response("first")));
    const second = await startMount(exactMount("/", () => new Response("second")));
    await first.stop({ forceAfterMs: 0 });
    assert.equal(first.state, "closed");
    assert.equal(second.state, "running");
    assert.equal(await (await fetch(`${firstTcp(second).url}/`)).text(), "second");
    await second.stop({ forceAfterMs: 0 });
  });
});

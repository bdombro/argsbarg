/*
Focused tests for generated CLI presentation.
They cover compact native values, REST streams, relay failures, and abort exit mapping.
*/

import assert from "node:assert/strict";
import test from "node:test";
import { type CliCallWriter, presentCliCall } from "./encode.ts";

/** Collects terminal writes for compact assertions. */
function writer(): {
  readonly sink: CliCallWriter;
  readonly stdout: string[];
  readonly stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    sink: {
      async stdout(chunk) {
        stdout.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      },
      async stderr(chunk) {
        stderr.push(chunk);
      },
    },
  };
}

test("presentCliCall writes captured streams before a native REST stream", async () => {
  const writes = writer();
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("first"));
        controller.enqueue(new TextEncoder().encode("second"));
        controller.close();
      },
    }),
    { status: 206 },
  );
  const result = await presentCliCall(
    "rest",
    { kind: "native", value: response, stdout: "captured\n", stderr: "warning\n" },
    writes.sink,
    new AbortController().signal,
  );
  assert.deepEqual(writes.stdout, ["captured\n", "first", "second"]);
  assert.deepEqual(writes.stderr, ["warning\n"]);
  assert.equal(result.exitCode, 0);
});

test("presentCliCall maps failures and authoritative aborts to 1 or 130", async () => {
  const failed = writer();
  const signal = new AbortController();
  signal.abort();
  const ordinary = await presentCliCall(
    "rpc",
    { kind: "failure", category: "transport", code: "BROKEN", message: "Remote failed", stdout: "", stderr: "" },
    failed.sink,
    new AbortController().signal,
  );
  const aborted = await presentCliCall(
    "mcp",
    { kind: "failure", category: "transport", code: "CALL_ABORTED", message: "Aborted", stdout: "", stderr: "" },
    writer().sink,
    signal.signal,
  );
  assert.equal(ordinary.exitCode, 1);
  assert.equal(aborted.exitCode, 130);
  assert.equal(failed.stderr[0], "BROKEN: Remote failed\n");
});

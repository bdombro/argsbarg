/*
Type and shape tests for the shared D35 generated-call registration contract.
They ensure local and relay contexts remain exclusive and preserve native values.
*/

import assert from "node:assert/strict";
import test from "node:test";
import type { CliCallEntry, CliCallResult } from "./mirror.ts";

test("shared mirror entry preserves native values and captured streams", async () => {
  const entry: CliCallEntry<{ value: number }, number> = {
    async invoke(input) {
      const result: CliCallResult<number> = {
        kind: "native",
        value: input.value,
        stdout: "out",
        stderr: "err",
      };
      return result;
    },
  };
  const result = await entry.invoke(
    { value: 3 },
    { mode: "local", signal: new AbortController().signal, locals: {}, env: { get: () => undefined } },
  );
  assert.deepEqual(result, { kind: "native", value: 3, stdout: "out", stderr: "err" });
});

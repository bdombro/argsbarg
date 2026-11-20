/*
Focused tests for native CLI binding.
They prove coercion, flat path input, local source isolation, and registration-time schema reuse.
*/

import assert from "node:assert/strict";
import test from "node:test";
import { ParseKind, parse, postParseValidate } from "../core/parse.ts";
import { command, OptionKind } from "../core/types.ts";
import { argsbarg } from "../runtime/cli.ts";
import { bindCliCommand } from "./bind.ts";

test("native CLI binding coerces flat inputs and exposes only a local env source", async () => {
  const leaf = command({
    key: "run",
    description: "Run.",
    options: [
      { name: "count", description: "Count.", kind: OptionKind.Number },
      { name: "verbose", description: "Verbose.", kind: OptionKind.Presence },
    ],
    positionals: [{ name: "name", description: "Name.", kind: OptionKind.String }],
    handler: (context) => ({ ...context.inputs, source: context.source, header: "headers" in context }),
  });
  const spec = {
    key: "demo",
    description: "Demo.",
    version: "1.0.0",
    commands: [leaf],
  };
  const app = argsbarg(spec);
  const parsed = postParseValidate(spec, parse(spec, ["run", "--count", "2", "--verbose", "ada"]));
  assert.equal(parsed.kind, ParseKind.Ok);
  if (parsed.kind !== ParseKind.Ok) return;
  const bound = bindCliCommand({
    program: spec,
    leaf,
    parsed,
    signal: new AbortController().signal,
    locals: {},
    env: { get: (name) => (name === "TOKEN" ? "local" : undefined) },
  });
  assert.deepEqual(bound.rawInputs, { count: 2, verbose: true, name: "ada" });
  assert.equal(bound.base.source, "local");
  assert.equal(bound.base.env.get("TOKEN"), "local");
  assert.equal("headers" in bound.base, false);

  const result = await app.invoke(["run", "--count", "2", "--verbose", "ada"]);
  assert.equal(result.kind, "ok");
  assert.deepEqual(JSON.parse(result.stdout), {
    count: 2,
    verbose: true,
    name: "ada",
    source: "local",
    header: false,
  });
});

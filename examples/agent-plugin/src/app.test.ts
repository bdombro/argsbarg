/* App-level schema checks: every input and config object rejects unknown keys (z.strictObject). */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { schemaStrictnessWarnings } from "argsbarg";
import { app } from "./app.ts";

describe("mcpPlugin schemas", () => {
  test("input and config schemas are strict", () => {
    assert.deepEqual(schemaStrictnessWarnings(app.spec), []);
  });

  test("public MCP calls remain available without a configured token", async () => {
    const result = await app.invoke(["mcp", "call", "status"], { stdin: "{}" });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /"version":"1\.0\.0"/);
  });
});

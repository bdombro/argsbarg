/* App-level schema checks: every input and config object rejects unknown keys (z.strictObject). */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { schemaStrictnessWarnings } from "argsbarg";
import { app } from "./app.ts";

describe("fullExampleJson schemas", () => {
  test("input and config schemas are strict", () => {
    assert.deepEqual(schemaStrictnessWarnings(app.spec), []);
  });

  test("seeds a caller from the MCP HTTP header-only source", async () => {
    const middleware = app.spec.mcp?.http?.middleware;
    assert.notEqual(middleware, undefined);
    assert.equal(typeof middleware, "function");
    if (middleware === undefined) return;

    const result = await middleware(new Request("http://localhost/mcp"), {
      method: "tools/call",
      name: "echo",
      headers: {
        get: (name) => (name.toLowerCase() === "x-example-api-caller" ? "Ada" : undefined),
      },
    });

    assert.equal(result.kind, "next");
    if (result.kind === "next") assert.equal(result.locals.caller, "Ada");
  });
});

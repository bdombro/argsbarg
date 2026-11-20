import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type AppSpec, argsbarg } from "argsbarg";
import { statusCommand } from "./command.ts";

const app = argsbarg({
  key: "status-test",
  description: "Status command test.",
  version: "1.0.0",
  commands: [statusCommand],
} satisfies AppSpec);

describe("status command", () => {
  test("exports outputSchema and json option", () => {
    assert.equal(statusCommand.key, "status");
    assert.notEqual(statusCommand.outputSchema, undefined);
    assert.equal(
      statusCommand.options?.some((o) => o.name === "json"),
      true,
    );
  });

  test("prints plain text by default and an object with --json", async () => {
    const plain = await app.invoke(["status"]);
    assert.equal(plain.kind, "ok");
    assert.equal(plain.stdout.trim(), "version=1.0.0");

    const json = await app.invoke(["status", "--json"]);
    assert.equal(json.kind, "ok");
    assert.deepEqual(JSON.parse(json.stdout), { version: "1.0.0" });
  });
});

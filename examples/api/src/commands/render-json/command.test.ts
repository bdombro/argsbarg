import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type AppSpec, argsbarg, command } from "argsbarg";
import { renderJsonCommand, renderJsonTestSpec } from "./command.ts";

const baseSpec: AppSpec = {
  key: "example-api",
  version: "1.0.0",
  description: "Demo.",
  commands: [],
};

describe("render-json command", () => {
  const spec = renderJsonTestSpec(baseSpec);
  const cli = argsbarg(spec);

  test("returns the echoed document", async () => {
    const result = await cli.invoke(["render-json", JSON.stringify({ message: "hello" })]);
    assert.equal(result.kind, "ok");
    assert.deepEqual(JSON.parse(result.stdout), { message: "hello" });
  });

  test("rejects invalid input before handler via inputSchema", async () => {
    let handlerCalled = false;
    const badProgram = renderJsonTestSpec({
      ...baseSpec,
      commands: [
        command({
          ...renderJsonCommand,
          handler: () => {
            handlerCalled = true;
          },
        }),
      ],
    });
    const result = await argsbarg(badProgram).invoke(["render-json", JSON.stringify({ message: 123 })]);
    assert.equal(result.kind, "error");
    assert.equal(handlerCalled, false);
  });
});

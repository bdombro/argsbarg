/*
Regression tests for the v9 Zod adapter and direct CLI declaration boundary.
They verify one schema emission, parsed defaults, strict typing, and flat path inputs.
*/

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { z } from "zod";
import { argsbarg } from "../index.ts";
import { type AppSpec, command, SchemaValidationError } from "./types.ts";
import { cliValidateProgram, schemaStrictnessWarnings } from "./validate.ts";
import { isZodObjectSchema, isZodSchema, toJsonSchema, validateWithSchema } from "./zod-schema.ts";

/** Discriminated union used for direct command inference checks. */
const Shape = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("circle"), radius: z.number() }),
  z.strictObject({ kind: z.literal("rect"), width: z.number(), height: z.number() }),
]);

/** Wraps one leaf declaration as a minimal app. */
function programWith(leaf: object): AppSpec {
  return { key: "zapp", version: "1.0.0", description: "Zod tests.", commands: [leaf] } as AppSpec;
}

describe("schema adapter", () => {
  test("emits draft 2020-12 and memoizes per input/output side", () => {
    const schema = z.strictObject({ n: z.number().default(1).describe("A number.") });
    const input = toJsonSchema(schema, "input");
    assert.equal(input.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.equal(input.required, undefined);
    assert.equal(toJsonSchema(schema, "input"), input);
    assert.deepEqual(toJsonSchema(schema, "output").required, ["n"]);
    assert.equal(Object.isFrozen(input), true);
  });

  test("returns parsed Zod values and identifies schemas", () => {
    assert.deepEqual(validateWithSchema(z.strictObject({ n: z.number().default(7) }), {}), {
      valid: true,
      value: { n: 7 },
      errors: [],
    });
    assert.equal(isZodSchema(z.string()), true);
    assert.equal(isZodSchema({ type: "object" }), false);
    assert.equal(isZodObjectSchema(z.object({})), true);
    assert.equal(isZodObjectSchema(z.string()), false);
  });
});

describe("command", () => {
  test("types inputs from a schema and applies defaults", async () => {
    const area = command({
      key: "area",
      description: "Area.",
      kind: "document",
      inputSchema: Shape,
      outputSchema: z.strictObject({ area: z.number() }),
      handler: (ctx) => {
        const shape = ctx.inputs;
        if (shape.kind === "circle") return { area: Math.PI * shape.radius ** 2 };
        // @ts-expect-error radius exists only on the circle branch.
        void shape.radius;
        return { area: shape.width * shape.height };
      },
    });
    command({
      key: "bad",
      description: "Bad.",
      outputSchema: z.strictObject({ area: z.number() }),
      // @ts-expect-error the handler return must match outputSchema.
      handler: () => ({ area: "x" }),
    });
    const result = await argsbarg(programWith(area)).invoke([
      "area",
      JSON.stringify({ kind: "rect", width: 2, height: 3 }),
    ]);
    assert.equal(result.kind, "ok");
    assert.deepEqual(JSON.parse(result.stdout), { area: 6 });
  });

  test("merges CLI path captures into flat inputs", async () => {
    const get = command({
      key: "get",
      description: "Get one.",
      handler: (ctx) => ({ id: (ctx.inputs as Record<string, string>).id }),
    });
    const app = argsbarg({
      key: "paths",
      version: "1.0.0",
      description: "Paths.",
      commands: [{ key: "items", description: "Items.", commands: [{ key: ":id", description: "One.", commands: [get] }] }],
    });
    const result = await app.invoke(["items", "i-7", "get"]);
    assert.equal(result.kind, "ok");
    assert.deepEqual(JSON.parse(result.stdout), { id: "i-7" });
  });
});

test("startup emits and reports schemas without mutating them", () => {
  const strict = z.strictObject({});
  const loose = z.object({});
  const app = {
    key: "schemas",
    version: "1.0.0",
    description: "Schemas.",
    commands: [
      command({ key: "strict", description: "Strict.", inputSchema: strict, handler: () => {} }),
      command({ key: "loose", description: "Loose.", inputSchema: loose, handler: () => {} }),
    ],
  } satisfies AppSpec;
  cliValidateProgram(app);
  assert.match(schemaStrictnessWarnings(app)[0] ?? "", /loose/);
  assert.throws(
    () => cliValidateProgram({ ...app, version: "", commands: [] }),
    (error) => error instanceof SchemaValidationError,
  );
});

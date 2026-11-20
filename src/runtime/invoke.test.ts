/*
Domain-specific regression tests (split from index.test.ts).
*/

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { AppError } from "../core/errors.ts";
import {
  allow,
  type BoundDeclaration,
  type Denial,
  deny,
  type InvocationBase,
  type InvocationContext,
} from "../core/invocation.ts";
import { ParseKind, parse, postParseValidate } from "../core/parse.ts";
import type { Locals, RunnableCommand } from "../core/types.ts";
import { hasSubcommands } from "../core/types.ts";
import { cliValidateProgram } from "../core/validate.ts";
import { argsbarg, OptionKind } from "../index.ts";
import { runNode, testProgram, varargsReadFixture } from "../test/fixtures.ts";
import { invocationScopeState } from "./invocation-scope.ts";
import { compileGuardPlan, invokeBound } from "./invoke.ts";

/** Tests that ctx.invocation is cli via app.run. */
test("ctx.invocation is cli via app.run", async () => {
  const indexPath = join(import.meta.dirname, "../index.ts");
  const { stdout } = runNode([
    "--input-type=module",
    "-e",
    `
import { argsbarg } from ${JSON.stringify(indexPath)};
const program = {
  key: "t",
  description: "d",
  version: "0.0.0",
  handler: (ctx) => console.log(ctx.surface),
};
await argsbarg(program).run([]);
  `,
  ]);
  assert.equal(stdout.toString().trim(), "cli");
});

/** Verifies app.run runs beforeInvoke/afterInvoke around the handler and routes failures through formatError/onError. */
test("app.run runs app hooks", () => {
  const indexPath = join(import.meta.dirname, "../index.ts");
  const script = (fail: boolean) => `
import { argsbarg } from ${JSON.stringify(indexPath)};
await argsbarg({
  key: "t",
  description: "d",
  version: "0.0.0",
  hooks: {
    beforeInvoke: (ctx) => { ctx.locals.user = "ada"; console.log("before"); },
    afterInvoke: () => console.log("after"),
    formatError: () => ({ message: "formatted", exitCode: 3 }),
    onError: () => console.log("onError"),
  },
  handler: (ctx) => { if (${fail}) throw new Error("boom"); console.log(ctx.locals.user); },
}).run([]);
`;
  const ok = runNode(["--input-type=module", "-e", script(false)]);
  assert.equal(ok.stdout.toString().trim(), "before\nada\nafter");
  const bad = runNode(["--input-type=module", "-e", script(true)]);
  assert.equal(bad.exitCode, 3);
  assert.equal(bad.stdout.toString().trim(), "before\nonError");
  assert.equal(bad.stderr.toString().trim(), "formatted");
});

/** Verifies a disabled built-in name routes to the app's own command, with hooks. */
test("app command named after a disabled built-in runs with hooks", async () => {
  const seen: string[] = [];
  const root = testProgram({
    key: "app",
    description: "",
    hooks: { beforeInvoke: () => void seen.push("hook") },
    commands: [{ key: "http", description: "App's own http.", handler: () => void seen.push("handler") }],
  });
  const result = await argsbarg(root).invoke(["http"]);
  assert.equal(result.kind, "ok");
  assert.deepEqual(seen, ["hook", "handler"]);
});

/** Overlapping invocations each capture only their own output. */
test("overlapping App.invoke calls keep their output separate", async () => {
  const root = testProgram({
    key: "app",
    description: "",
    options: [{ name: "label", description: "Label to print.", kind: OptionKind.String, required: true }],
    handler: async (ctx: InvocationContext<Record<string, unknown>, object>) => {
      const label = String(ctx.inputs.label);
      console.log(`${label} start`);
      await new Promise((resolve) => setTimeout(resolve, 10));
      process.stdout.write(`${label} end\n`);
      console.error(`${label} err`);
    },
  });
  const app = argsbarg(root);
  const [a, b] = await Promise.all([app.invoke(["--label", "a"]), app.invoke(["--label", "b"])]);
  assert.equal(a.stdout, "a start\na end\n");
  assert.equal(b.stdout, "b start\nb end\n");
  assert.equal(a.stderr, "a err\n");
  assert.equal(b.stderr, "b err\n");
});

/** Tests that App.invoke defaults to the native CLI surface. */
test("ctx.invocation is cli via App.invoke by default", async () => {
  let seen = "";
  const root = testProgram({
    key: "app",
    description: "",
    handler: (ctx: InvocationContext<Record<string, unknown>, object>) => {
      seen = ctx.surface;
    },
  });
  cliValidateProgram(root);
  const result = await argsbarg(root).invoke([]);
  assert.equal(result.kind, "ok");
  assert.equal(seen, "cli");
});

/** Tests that ctx.locals.requestId is seeded before handler on invoke. */
test("App.invoke seeds ctx.locals.requestId", async () => {
  let requestId = "";
  const root = testProgram({
    key: "app",
    description: "",
    hooks: {
      beforeInvoke: (ctx: { readonly locals: Locals }) => {
        requestId = String(ctx.locals.requestId ?? "");
      },
    },
    handler: () => {},
  });
  cliValidateProgram(root);
  const result = await argsbarg(root).invoke([]);
  assert.equal(result.kind, "ok");
  assert.notEqual(requestId, "");
});

test("native App.invoke retains the exact caller signal and direct context once", async () => {
  const controller = new AbortController();
  let calls = 0;
  let seenSignal: AbortSignal | undefined;
  const root = testProgram({
    key: "app",
    description: "",
    handler: (ctx: InvocationContext<Record<string, unknown>, object>) => {
      calls += 1;
      seenSignal = ctx.signal;
      return { source: ctx.source, signal: ctx.signal.aborted };
    },
  });
  const result = await argsbarg(root).invoke([], { signal: controller.signal });
  assert.equal(result.kind, "ok");
  assert.equal(calls, 1);
  assert.equal(seenSignal, controller.signal);
  assert.equal(result.stdout, '{\n  "source": "local",\n  "signal": false\n}\n');
});

/** App.invoke rejects invalid Enum value. */
test("App.invoke rejects invalid Enum value", async () => {
  const root = testProgram({
    key: "app",
    description: "",
    handler: () => {},
    options: [
      {
        name: "mode",
        description: "Mode.",
        kind: OptionKind.Enum,
        choices: ["dev", "prod"],
        required: true,
      },
    ],
  });
  cliValidateProgram(root);
  const result = await argsbarg(root).invoke(["--mode", "staging"]);
  assert.equal(result.kind, "error");
  assert.ok((result.errorMsg ?? "").includes("not one of"));
});

/** App.invoke accepts valid Enum value. */
test("App.invoke accepts valid Enum value", async () => {
  const root = testProgram({
    key: "app",
    description: "",
    handler: (ctx: InvocationContext<Record<string, unknown>, object>) => {
      console.log(String(ctx.inputs.mode));
    },
    options: [
      {
        name: "mode",
        description: "Mode.",
        kind: OptionKind.Enum,
        choices: ["dev", "prod"],
        required: true,
      },
    ],
  });
  cliValidateProgram(root);
  const result = await argsbarg(root).invoke(["--mode", "dev"]);
  assert.equal(result.kind, "ok");
  assert.equal(result.stdout.trim(), "dev");
});

test("varargs trailing option after positionals via App.invoke", async () => {
  const root = varargsReadFixture();
  cliValidateProgram(root);
  const pr = postParseValidate(root, parse(root, ["read", "file.txt", "--json"]));
  assert.equal(pr.kind, ParseKind.Ok);
  assert.deepEqual(pr.args, ["file.txt"]);
  assert.equal(pr.opts.json, "1");
});

test("varargs option before positionals", () => {
  const root = varargsReadFixture();
  cliValidateProgram(root);
  const pr = postParseValidate(root, parse(root, ["read", "--json", "file.txt"]));
  assert.equal(pr.kind, ParseKind.Ok);
  assert.deepEqual(pr.args, ["file.txt"]);
  assert.equal(pr.opts.json, "1");
});

test("varargs multiple files then trailing option", () => {
  const root = varargsReadFixture();
  cliValidateProgram(root);
  const pr = postParseValidate(root, parse(root, ["read", "a.txt", "b.txt", "--json"]));
  assert.equal(pr.kind, ParseKind.Ok);
  assert.deepEqual(pr.args, ["a.txt", "b.txt"]);
  assert.equal(pr.opts.json, "1");
});

test("varargs double dash forces positional", () => {
  const root = varargsReadFixture();
  cliValidateProgram(root);
  const pr = postParseValidate(root, parse(root, ["read", "file.txt", "--", "--json"]));
  assert.equal(pr.kind, ParseKind.Ok);
  assert.deepEqual(pr.args, ["file.txt", "--json"]);
  assert.equal(pr.opts.json, undefined);
});

test("varargs unknown flag errors", async () => {
  const root = varargsReadFixture();
  cliValidateProgram(root);
  const result = await argsbarg(root).invoke(["read", "--unknown"]);
  assert.equal(result.kind, "error");
  assert.ok(result.stderr.includes("--unknown"));
});

test("varargs scoped help in tail", () => {
  const root = varargsReadFixture();
  cliValidateProgram(root);
  const pr = parse(root, ["read", "file.txt", "--help"]);
  assert.equal(pr.kind, ParseKind.Help);
  assert.ok(pr.helpPath.includes("read"));
  assert.equal(pr.helpExplicit, true);
});

/** Tests that ctx.positional returns single slot value. */
test("ctx.positional returns single slot value", async () => {
  const root = testProgram({
    key: "app",
    description: "",
    commands: [
      {
        key: "x",
        description: "",
        positionals: [{ name: "path", description: "", kind: OptionKind.String }],
        handler: (ctx: InvocationContext<Record<string, unknown>, object>) => {
          captured = ctx.inputs.path as string | undefined;
        },
      },
    ],
  });
  let captured: string | string[] | undefined;
  cliValidateProgram(root);
  await argsbarg(root).invoke(["x", "./file"]);
  assert.equal(captured, "./file");
});

test("ctx.positional returns varargs array", async () => {
  const root = varargsReadFixture();
  let captured: string | string[] | undefined;
  if (hasSubcommands(root)) {
    (root.commands[0] as RunnableCommand).handler = (ctx) => {
      captured = ctx.inputs.files as string[] | undefined;
    };
  }
  cliValidateProgram(root);
  await argsbarg(root).invoke(["read", "a.txt", "b.txt"]);
  assert.deepEqual(captured, ["a.txt", "b.txt"]);
});

/** Tests that ctx.positional returns undefined for absent optional slot. */
test("ctx.positional returns undefined for absent optional slot", async () => {
  const root = testProgram({
    key: "app",
    description: "",
    commands: [
      {
        key: "x",
        description: "",
        positionals: [{ name: "opt", description: "", kind: OptionKind.String, argMin: 0, argMax: 1 }],
        handler: (ctx: InvocationContext<Record<string, unknown>, object>) => {
          captured = ctx.inputs.opt as string | undefined;
        },
      },
    ],
  });
  let captured: string | string[] | undefined;
  cliValidateProgram(root);
  await argsbarg(root).invoke(["x"]);
  assert.equal(captured, undefined);
});

/** Tests that ctx.positional varargs matches ctx.args. */
test("ctx.positional varargs matches ctx.args", async () => {
  const root = varargsReadFixture();
  let positional: string | string[] | undefined;
  let args: string[] = [];
  if (hasSubcommands(root)) {
    (root.commands[0] as RunnableCommand).handler = (ctx) => {
      positional = ctx.inputs.files as string[];
      args = ctx.inputs.files as string[];
    };
  }
  cliValidateProgram(root);
  await argsbarg(root).invoke(["read", "a.txt", "b.txt"]);
  assert.deepEqual(positional, args);
});

/** A handler result larger than a pipe buffer (64 KB) reaches a piped stdout in full. */
test("app.run flushes a large result to a piped stdout before exiting", () => {
  const indexPath = join(import.meta.dirname, "../index.ts");
  const { stdout, exitCode } = runNode([
    "--input-type=module",
    "-e",
    `
import { argsbarg } from ${JSON.stringify(indexPath)};
await argsbarg({ key: "t", description: "d", version: "0.0.0", handler: () => ({ big: "x".repeat(200_000) }) }).run([]);
`,
  ]);
  assert.equal(exitCode, 0);
  assert.equal((JSON.parse(stdout) as { big: string }).big.length, 200_000);
});

/** Creates a local invocation base whose only credential view is `env`. */
const localSource = (entries: Readonly<Record<string, string>> = {}): InvocationBase<object> => ({
  env: { get: (name) => entries[name] },
  locals: {},
  signal: new AbortController().signal,
  source: "local",
  surface: "cli",
});

/** Creates an HTTP invocation base whose only credential view is `headers`. */
const httpSource = (entries: Readonly<Record<string, string>> = {}): InvocationBase<object> => ({
  headers: { get: (name) => entries[name.toLowerCase()] },
  locals: {},
  signal: new AbortController().signal,
  source: "http",
  surface: "http",
});

/** Input schema shared by direct invokeBound behavior tests. */
const directInput = z.object({ count: z.number().default(2), name: z.string() });

/** Parsed input type shared by direct invokeBound guards. */
type DirectInput = z.output<typeof directInput>;

/** Compiled no-op plan shared by direct tests. */
const noGuards = compileGuardPlan<DirectInput, object>()({});

/** Validates and transforms once, preserves the original ZodError, and captures parsing output. */
test("invokeBound validates once, applies transforms, and preserves invalid Zod errors", async () => {
  let parses = 0;
  let guarded = 0;
  let handled = 0;
  const schema = z.preprocess(
    (value) => {
      parses++;
      console.log("parse");
      return value;
    },
    z.object({ count: z.number().default(2), name: z.string().transform((name) => name.toUpperCase()) }),
  );
  const declaration = {
    inputSchema: schema,
    guardPlan: compileGuardPlan<z.output<typeof schema>, object>()({
      surface: (ctx) => {
        guarded++;
        assert.deepEqual(ctx.inputs, { count: 2, name: "ADA" });
        return true;
      },
    }),
    handler: (ctx: InvocationContext<z.output<typeof schema>, object>) => {
      handled++;
      return ctx.inputs;
    },
  } satisfies BoundDeclaration<typeof schema, z.output<typeof schema>, object>;

  const valid = await invokeBound({ base: localSource(), declaration, rawInputs: { name: "ada" } });
  assert.equal(valid.kind, "ok");
  assert.deepEqual(valid.kind === "ok" ? valid.result : undefined, { count: 2, name: "ADA" });
  assert.equal(valid.stdout, "parse\n");

  const invalid = await invokeBound({ base: localSource(), declaration, rawInputs: { name: 7 } });
  assert.equal(invalid.kind, "invalid");
  assert.ok(invalid.kind === "invalid" && invalid.error instanceof z.ZodError);
  assert.equal(invalid.stdout, "parse\n");
  assert.equal(parses, 2);
  assert.equal(guarded, 1);
  assert.equal(handled, 1);
});

/** Package-internal forbidChdir defaults off and blocks cwd mutation only when requested. */
test("invokeBound conditionally forbids process.chdir", async () => {
  const declaration: BoundDeclaration<typeof directInput, string, object> = {
    inputSchema: directInput,
    guardPlan: noGuards,
    handler: () => {
      const cwd = process.cwd();
      process.chdir(cwd);
      return cwd;
    },
  };
  const allowed = await invokeBound({ base: localSource(), declaration, rawInputs: { name: "item" } });
  assert.equal(allowed.kind, "ok");
  const forbidden = await invokeBound({
    base: localSource(),
    declaration,
    forbidChdir: true,
    rawInputs: { name: "item" },
  });
  assert.equal(forbidden.kind, "error");
  assert.match(forbidden.kind === "error" ? String(forbidden.error) : "", /process\.chdir isn't allowed/);
});

/** Guards run in order and shallow-merge additions into the same fresh locals object. */
test("compiled guards merge ordered locals into one callback-visible object", async () => {
  type Seed = { requestId: string };
  type Final = Seed & { caller: "ada"; workspace: "/workspace" };
  let operationContext: object | undefined;
  let handlerContext: object | undefined;
  const plan = compileGuardPlan<DirectInput, Seed>()({
    surface: (ctx) => {
      assert.equal(ctx.locals.requestId, "request");
      return allow({ caller: "ada" });
    },
    operation: (ctx) => {
      operationContext = ctx;
      assert.equal(ctx.locals.caller, "ada");
      return allow({ workspace: "/workspace" });
    },
  });
  const declaration: BoundDeclaration<typeof directInput, string, Final, Seed> = {
    guardPlan: plan,
    handler: (ctx) => {
      handlerContext = ctx;
      assert.deepEqual(ctx.locals, { caller: "ada", requestId: "request", workspace: "/workspace" });
      return ctx.locals.workspace;
    },
    inputSchema: directInput,
  };
  const seed = { requestId: "request" };
  const result = await invokeBound({
    base: { ...localSource(), locals: seed } as InvocationBase<Seed>,
    declaration,
    rawInputs: { name: "item" },
  });
  assert.equal(result.kind, "ok");
  assert.equal(result.kind === "ok" ? result.result : undefined, "/workspace");
  assert.equal(handlerContext, operationContext);
  assert.deepEqual(seed, { requestId: "request" });
});

/** Override replaces and public removes only the surface default guard. */
test("override replaces and public removes only the surface default", async () => {
  const seen: string[] = [];
  type Seed = { requestId: string };
  const surface = () => {
    seen.push("surface");
    return allow({ caller: "surface" });
  };
  const override = compileGuardPlan<DirectInput, Seed>()({
    surface,
    operation: {
      mode: "override",
      run: () => {
        seen.push("override");
        return allow({ caller: "override" });
      },
    },
  });
  const publicPlan = compileGuardPlan<DirectInput, Seed>()({ surface, operation: "public" });

  await invokeBound({
    base: { ...localSource(), locals: { requestId: "request" } },
    declaration: {
      guardPlan: override,
      handler: (ctx) => {
        seen.push(ctx.locals.caller);
        return undefined;
      },
      inputSchema: directInput,
    },
    rawInputs: { name: "override" },
  });
  await invokeBound({
    base: { ...localSource(), locals: { requestId: "request" } },
    declaration: {
      guardPlan: publicPlan,
      handler: () => {
        seen.push("handler");
        return undefined;
      },
      inputSchema: directInput,
    },
    rawInputs: { name: "public" },
  });
  assert.deepEqual(seen, ["override", "override", "handler"]);
});

/** False and deny produce terminal denials without running later guards or handlers. */
test("false and deny preserve output and short-circuit later work", async () => {
  const denial: Denial = {
    challenge: { error: "invalid_token", scheme: "bearer", scopes: ["read"] },
    code: "TOKEN",
    http: { headers: { "www-authenticate": "Bearer" }, status: 401 },
    message: "Token required",
  };
  for (const [label, guardResult, expected] of [
    ["false", false, { code: "DENIED", message: "Access denied" }],
    ["deny", deny(denial), denial],
  ] as const) {
    let later = 0;
    let handler = 0;
    const result = await invokeBound({
      base: localSource(),
      declaration: {
        guardPlan: compileGuardPlan<DirectInput, object>()({
          surface: () => {
            console.log(label);
            return guardResult;
          },
          operation: () => {
            later++;
            return true;
          },
        }),
        handler: () => {
          handler++;
          return undefined;
        },
        inputSchema: directInput,
      },
      rawInputs: { name: label },
    });
    assert.equal(result.kind, "denied");
    if (result.kind === "denied") assert.deepEqual(result.denial, expected);
    assert.equal(result.stdout, `${label}\n`);
    assert.equal(later, 0);
    assert.equal(handler, 0);
  }
});

/** Local and HTTP bases expose mutually exclusive name views with no fallback. */
test("source views expose only env locally and only headers over HTTP", async () => {
  for (const [base, env, header] of [
    [localSource({ TOKEN: "local" }), "local", undefined],
    [httpSource({ authorization: "http" }), undefined, "http"],
  ] as const) {
    const result = await invokeBound({
      base,
      declaration: {
        guardPlan: noGuards,
        handler: (ctx) => {
          assert.equal(ctx.env?.get("TOKEN"), env);
          assert.equal(ctx.headers?.get("authorization"), header);
          return ctx.source;
        },
        inputSchema: directInput,
      },
      rawInputs: { name: "source" },
    });
    assert.equal(result.kind, "ok");
    assert.equal(result.kind === "ok" ? result.result : undefined, base.source);
  }
});

/** Thrown values remain inspectable while ordinary returned values, including AppError, stay ok. */
test("thrown values become errors while ordinary returns remain ok", async () => {
  for (const thrown of ["guard string", { message: "guard object" }] as const) {
    const result = await invokeBound({
      base: localSource(),
      declaration: {
        guardPlan: compileGuardPlan<DirectInput, object>()({
          surface: () => {
            console.error("before throw");
            throw thrown;
          },
        }),
        handler: () => "unreachable",
        inputSchema: directInput,
      },
      rawInputs: { name: "throw" },
    });
    assert.equal(result.kind, "error");
    if (result.kind === "error") assert.equal(result.error, thrown);
    assert.equal(result.stderr, "before throw\n");
  }

  const cause = new Error("root");
  const domain = new AppError("known", { cause, code: "KNOWN", details: { retry: false }, httpStatus: 409 });
  for (const value of [undefined, domain]) {
    const result = await invokeBound({
      base: localSource(),
      declaration: {
        guardPlan: noGuards,
        handler: () => value,
        inputSchema: directInput,
      },
      rawInputs: { name: "return" },
    });
    assert.equal(result.kind, "ok");
    if (result.kind === "ok") assert.equal(result.result, value);
  }
  assert.equal(domain.name, "AppError");
  assert.equal(domain.code, "KNOWN");
  assert.equal(domain.httpStatus, 409);
  assert.deepEqual(domain.details, { retry: false });
  assert.equal(domain.cause, cause);
});

/** A handler-thrown AppError remains the exact unexpected error value. */
test("handler-thrown AppError is preserved as the error value", async () => {
  const domain = new AppError("unavailable", { code: "UNAVAILABLE" });
  const result = await invokeBound({
    base: localSource(),
    declaration: {
      guardPlan: noGuards,
      handler: () => {
        console.log("before error");
        throw domain;
      },
      inputSchema: directInput,
    },
    rawInputs: { name: "error" },
  });
  assert.equal(result.kind, "error");
  if (result.kind === "error") assert.equal(result.error, domain);
  assert.equal(result.stdout, "before error\n");
});

/** Non-Error handler throws and synchronous schema throws remain exact error outcomes. */
test("non-Error handler and schema throws remain error values", async () => {
  for (const thrown of ["handler string", { reason: "handler object" }] as const) {
    const result = await invokeBound({
      base: localSource(),
      declaration: {
        guardPlan: noGuards,
        handler: () => {
          throw thrown;
        },
        inputSchema: directInput,
      },
      rawInputs: { name: "throw" },
    });
    assert.equal(result.kind, "error");
    if (result.kind === "error") assert.equal(result.error, thrown);
  }

  const thrown = new Error("schema transform failed");
  const result = await invokeBound({
    base: localSource(),
    declaration: {
      guardPlan: compileGuardPlan<DirectInput, object>()({
        surface: () => assert.fail("guard must not run after a schema throw"),
      }),
      handler: () => assert.fail("handler must not run after a schema throw"),
      inputSchema: directInput.superRefine(() => {
        throw thrown;
      }),
    },
    rawInputs: { name: "schema" },
  });
  assert.equal(result.kind, "error");
  if (result.kind === "error") assert.equal(result.error, thrown);
});

/** Concurrent calls retain independent locals, signals, stdout, and stderr. */
test("overlapping invocations isolate locals, signals, stdout and stderr", async () => {
  type Seed = { label: string };
  const plan = compileGuardPlan<DirectInput, Seed>()({});
  const run = (label: string, signal: AbortSignal) =>
    invokeBound({
      base: { ...localSource(), locals: { label }, signal } as InvocationBase<Seed>,
      declaration: {
        guardPlan: plan,
        handler: async (ctx) => {
          assert.equal(ctx.signal, signal);
          const scope = invocationScopeState().storage.getStore();
          assert.equal(scope?.signal, signal);
          assert.equal(scope?.metadata.source, "local");
          assert.equal(scope?.metadata.surface, "cli");
          console.log(`${ctx.locals.label} start`);
          await new Promise((resolve) => setTimeout(resolve, 5));
          process.stderr.write(`${ctx.locals.label} end\n`);
          return ctx.locals.label;
        },
        inputSchema: directInput,
      },
      rawInputs: { name: label },
    });
  const signalA = new AbortController().signal;
  const signalB = new AbortController().signal;
  const [a, b] = await Promise.all([run("a", signalA), run("b", signalB)]);
  assert.equal(a.stdout, "a start\n");
  assert.equal(a.stderr, "a end\n");
  assert.equal(b.stdout, "b start\n");
  assert.equal(b.stderr, "b end\n");
});

/** Pre-abort is checked inside ALS and closes the scope before parsing or invoking anything. */
test("pre-aborted calls enter and close ALS before parse, guard, or handler", async () => {
  const controller = new AbortController();
  controller.abort("stop");
  let entered = false;
  let closedAfter = false;
  Object.defineProperty(controller.signal, "throwIfAborted", {
    configurable: true,
    value: () => {
      const scope = invocationScopeState().storage.getStore();
      entered = scope?.closed === false;
      setImmediate(() => {
        closedAfter = invocationScopeState().storage.getStore()?.closed === true;
      });
      throw controller.signal.reason;
    },
  });
  let parsed = 0;
  let guarded = 0;
  let handled = 0;
  const schema = directInput.transform((value) => {
    parsed++;
    return value;
  });
  const result = await invokeBound({
    base: { ...localSource(), signal: controller.signal },
    declaration: {
      guardPlan: compileGuardPlan<DirectInput, object>()({
        surface: () => {
          guarded++;
          return true;
        },
      }),
      handler: () => {
        handled++;
        return undefined;
      },
      inputSchema: schema,
    },
    rawInputs: { name: "aborted" },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(result.kind, "error");
  assert.equal(entered, true);
  assert.equal(closedAfter, true);
  assert.equal(parsed, 0);
  assert.equal(guarded, 0);
  assert.equal(handled, 0);
});

/** Abort while an async guard is pending prevents all later guards and the handler. */
test("abort during an async guard prevents later guard and handler work", async () => {
  const controller = new AbortController();
  let later = 0;
  let handled = 0;
  const resultPromise = invokeBound({
    base: { ...localSource(), signal: controller.signal },
    declaration: {
      guardPlan: compileGuardPlan<DirectInput, object>()({
        surface: async (ctx) => {
          console.log("guard pending");
          await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve(), { once: true }));
          return true;
        },
        operation: () => {
          later++;
          return true;
        },
      }),
      handler: () => {
        handled++;
        return undefined;
      },
      inputSchema: directInput,
    },
    rawInputs: { name: "abort guard" },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort("guard cancelled");
  const result = await resultPromise;
  assert.equal(result.kind, "error");
  assert.equal(result.stdout, "guard pending\n");
  if (result.kind === "error") assert.equal(result.error, "guard cancelled");
  assert.equal(later, 0);
  assert.equal(handled, 0);
});

/** A cooperative handler abort becomes error and scheduled writes follow the closed outside path. */
test("cooperative handler abort closes ALS and prevents late output capture", async () => {
  const controller = new AbortController();
  let closedLate = false;
  const resultPromise = invokeBound({
    base: { ...localSource(), signal: controller.signal },
    declaration: {
      guardPlan: noGuards,
      handler: async (ctx) => {
        console.log("handler waiting");
        setTimeout(() => {
          closedLate = invocationScopeState().storage.getStore()?.closed === true;
        }, 0);
        await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve(), { once: true }));
        ctx.signal.throwIfAborted();
      },
      inputSchema: directInput,
    },
    rawInputs: { name: "abort handler" },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();
  const result = await resultPromise;
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  assert.equal(result.kind, "error");
  assert.equal(result.stdout, "handler waiting\n");
  assert.equal(closedLate, true);
});

/** The compiler infers supplement locals and rejects missing or any-valued additions. */
test("strict compiled guard locals reject missing and widened additions", () => {
  type Seed = { requestId: string };
  const plan = compileGuardPlan<DirectInput, Seed>()({
    surface: () => allow({ caller: "ada" }),
    operation: (ctx) => allow({ workspace: ctx.locals.caller }),
  });
  const declaration: BoundDeclaration<typeof directInput, string, Seed & { caller: "ada"; workspace: "ada" }, Seed> = {
    guardPlan: plan,
    handler: (ctx) => ctx.locals.workspace,
    inputSchema: directInput,
  };
  assert.ok(declaration.guardPlan);

  const missingPlan = compileGuardPlan<DirectInput, Seed>()({ surface: () => allow({ caller: "ada" }) });
  const missing: BoundDeclaration<typeof directInput, string, Seed & { missing: string }, Seed> = {
    // @ts-expect-error the handler requires a local the guard plan does not add
    guardPlan: missingPlan,
    handler: (ctx) => ctx.locals.missing,
    inputSchema: directInput,
  };
  assert.ok(missing.guardPlan);

  const widened = JSON.parse('{"caller":"ada"}') as ReturnType<(typeof JSON)["parse"]>;
  const badGuard = () => allow(widened);
  // @ts-expect-error an any-valued locals addition must not widen the compiled final locals
  compileGuardPlan<DirectInput, Seed>()({ surface: badGuard });
});

test("BoundDeclaration rejects any and unknown handler contexts", () => {
  type Context = InvocationContext<DirectInput, { caller: "ada" }>;
  type Handler = (ctx: Context) => string;
  const exact: BoundDeclaration<typeof directInput, string, { caller: "ada" }, object, Handler> = {
    guardPlan: compileGuardPlan<DirectInput, object>()({ surface: () => allow({ caller: "ada" }) }),
    handler: (ctx) => ctx.locals.caller,
    inputSchema: directInput,
  };
  assert.equal(typeof exact.handler, "function");

  const unknownHandler = (context: unknown) => String(context);
  const unknownDeclaration: BoundDeclaration<
    typeof directInput,
    string,
    { caller: "ada" },
    object,
    typeof unknownHandler
  > = {
    guardPlan: compileGuardPlan<DirectInput, object>()({ surface: () => allow({ caller: "ada" }) }),
    // @ts-expect-error unknown handler contexts must not pass the production declaration boundary
    handler: unknownHandler,
    inputSchema: directInput,
  };
  assert.ok(unknownDeclaration.guardPlan);

  const anyHandler = (context: ReturnType<(typeof JSON)["parse"]>) => String(context);
  const anyDeclaration: BoundDeclaration<typeof directInput, string, { caller: "ada" }, object, typeof anyHandler> = {
    guardPlan: compileGuardPlan<DirectInput, object>()({ surface: () => allow({ caller: "ada" }) }),
    // @ts-expect-error any handler contexts must not pass the production declaration boundary
    handler: anyHandler,
    inputSchema: directInput,
  };
  assert.ok(anyDeclaration.guardPlan);
});

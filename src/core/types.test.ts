/*
Compile-only checks that invalid schema shapes fail type-checking.
*/

import type { AppSpec, Command, CommandGroup, Locals, RunnableCommand } from "./types.ts";
import { command } from "./types.ts";
import { allow } from "./invocation.ts";
import { z } from "zod";

const _routerOnly: CommandGroup = {
  key: "app",
  description: "",
  commands: [],
};

const _leafOnly: RunnableCommand = {
  key: "run",
  description: "",
  handler: () => {},
};

const _program: AppSpec = {
  key: "app",
  version: "0.0.0",
  description: "",
  mcp: { tools: [] },
  commands: [],
};

const _badMcpOnNode = {
  key: "x",
  description: "",
  // @ts-expect-error mcp is program-root only
  mcp: { tools: [] },
  commands: [],
} satisfies Command;

const _badInstallOnNode = {
  key: "x",
  description: "",
  // @ts-expect-error install is program-root only
  install: { enabled: false },
  handler: () => {},
} satisfies Command;

const guardedInput = z.strictObject({ value: z.string() });
const guardedPath = z.strictObject({ workspace: z.string() });

const _typedGuardedCommand: RunnableCommand<typeof guardedInput, undefined, typeof guardedPath> = command({
  key: "typed",
  description: "",
  inputSchema: guardedInput,
  pathParams: guardedPath,
  guard: (ctx) => {
    const inputs: { value: string; workspace: string } = ctx.inputs;
    const locals: Locals = ctx.locals;
    void inputs;
    void locals;
    // @ts-expect-error command guards retain only parsed document and path fields
    ctx.inputs.missing;
    return allow();
  },
  handler: () => {},
});

const _extractedGuardedCommand = command<{ readonly requestId: string }>()({
  key: "guarded",
  description: "",
  inputSchema: guardedInput,
  guard: (ctx) => allow({ caller: ctx.source === "local" ? (ctx.env.get("USER") ?? "local") : "http" }),
  handler: ({ locals, inputs }) => `${locals.requestId}:${locals.caller}:${inputs.value}`,
});

const _overrideGuardedCommand = command<{ readonly requestId: string }>()({
  key: "override",
  description: "",
  guard: {
    mode: "override",
    run: () => allow({ caller: "operator" as const }),
  },
  handler: ({ locals }) => locals.caller,
});

const _extractedGuardedProgram = {
  key: "extracted",
  version: "0.0.0",
  description: "",
  commands: [_extractedGuardedCommand],
} satisfies AppSpec;

const _cliGuardedProgram = {
  key: "app",
  version: "0.0.0",
  description: "",
  commands: [
    command({
      key: "public",
      description: "",
      guard: "public",
      handler: () => {},
    }),
  ],
  cli: {
    guard: (ctx) => {
      const token = ctx.source === "local" ? ctx.env.get("TOKEN") : undefined;
      return token === undefined ? false : allow({ principal: token });
    },
  },
} satisfies AppSpec;

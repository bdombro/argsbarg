#!/usr/bin/env node
/*
MCP integration test fixture for subprocess tests (not a public example).
*/

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { type AppSpec, argsbarg, OptionKind } from "../index.ts";

/** Runs a child CLI with piped output while a tool invocation is active. */
const execFileAsync = promisify(execFile);
/** Cwd observed before an application-specific override. */
let hookCwd = process.cwd();
/** Active workspace handlers, used to detect accidental concurrent dispatch. */
let activeWorkspaceCalls = 0;
/** Resolves the pending `wait-release` call; set while one is waiting. */
let release: (() => void) | undefined;

/** Includes regular commands plus deliberately invalid output for protocol checks. */
const program = {
  commands: [
    {
      description: "Wait until the release tool runs (concurrency handshake).",
      /** Prints, then blocks until `release` is called, proving another call ran meanwhile. */
      handler: async () => {
        console.log("waiting");
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return "released";
      },
      key: "wait-release",
    },
    {
      description: "Release the waiting call.",
      /** Unblocks `wait-release`; reports whether one was waiting. */
      handler: () => {
        const waiting = release !== undefined;
        release?.();
        release = undefined;
        return { waiting };
      },
      key: "release",
    },
    {
      description: "Try to change the working directory.",
      /** Calls process.chdir to its own cwd and reports what happened. */
      handler: () => {
        try {
          process.chdir(process.cwd());
          return "changed";
        } catch (err) {
          return (err as Error).message;
        }
      },
      key: "try-chdir",
    },
    {
      description: "Run a child until the request is cancelled.",
      /** Reports the child PID before awaiting cooperative cancellation. */
      handler: async (ctx) => {
        const child = execFileAsync(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
          signal: ctx.mcp?.signal,
        });
        ctx.mcp?.reportProgress?.(0, 1, String(child.child.pid));
        await child;
        return "finished";
      },
      key: "wait-child",
    },
    {
      description: "Report handler and child cwd.",
      /** Reports cwd after an asynchronous child process without allowing overlapping tools. */
      handler: async () => {
        activeWorkspaceCalls++;
        const overlap = activeWorkspaceCalls > 1;
        const { stdout } = await execFileAsync(process.execPath, ["-p", "process.cwd()"]);
        activeWorkspaceCalls--;
        return { childCwd: stdout.trim(), cwd: process.cwd(), hookCwd, overlap };
      },
      key: "workspace-cwd",
      mcpTool: { annotations: { openWorldHint: false, readOnlyHint: true, title: "Inspect workspace" } },
    },
    {
      description: "Return a typed string via respond.",
      /** Exercises raw string schema validation and JSON text fallback. */
      handler: (ctx) => {
        ctx.mcp?.reportProgress?.(0, 1);
        ctx.mcp?.reportProgress?.(1, 1);
        setImmediate(() => ctx.mcp?.reportProgress?.(2, 2));
        ctx.respond({ body: "hello" });
      },
      key: "typed-output",
      outputSchema: z.string(),
    },
    {
      description: "Return a deliberately invalid typed result.",
      /** Exercises the tool error path for a malformed handler result. */
      handler: (ctx) => ctx.respond({ body: { wrong: true } }),
      key: "broken-output",
      outputSchema: z.strictObject({ ok: z.boolean() }),
    },
    {
      key: "echo-env",
      description: "Echo an env var.",
      options: [
        {
          name: "name",
          description: "Env var name to read.",
          kind: OptionKind.String,
          required: true,
        },
      ],
      handler: (ctx) => {
        const name = ctx.stringOpt("name") ?? "";
        const value = process.env[name] ?? "";
        if (ctx.invocation === "cli") {
          console.log(value);
          return;
        }
        return value;
      },
    },
    {
      key: "set-mode",
      description: "Set mode enum.",
      options: [
        {
          name: "mode",
          description: "Operating mode.",
          kind: OptionKind.Enum,
          choices: ["dev", "prod"],
          required: true,
        },
      ],
      handler: (ctx) => {
        const mode = ctx.stringOpt("mode") ?? "";
        const text = `mode=${mode}`;
        if (ctx.invocation === "cli") {
          console.log(text);
          return;
        }
        return text;
      },
    },
  ],
  description: "MCP integration test fixture.",
  hooks: {
    /** Records cwd before each tool and optionally applies the fixture's application override. */
    beforeInvoke: () => {
      hookCwd = process.cwd();
      if (process.env.MCP_TEST_CWD) process.chdir(process.env.MCP_TEST_CWD);
    },
  },
  key: "mcp-test",
  mcpServer: {
    enabled: true,
    instructions: "Read the fixture skill.",
    resources: [
      {
        uri: "test://hello",
        name: "hello",
        load: () => "hello resource",
      },
    ],
    validateOutputs: true,
    ...(process.env.MCP_TEST_CONCURRENT ? { concurrent: true } : {}),
  },
  version: "0.0.0-test",
} satisfies AppSpec;

const cli = argsbarg(program);
await cli.run();

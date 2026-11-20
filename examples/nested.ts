#!/usr/bin/env node
/*
This example shows nested routing with groups and fallback behavior.
It adds a deeper command tree so readers can see how grouped routing, leaf handlers,
and fallback commands fit together in one schema.

It demonstrates how the schema scales beyond one command.
*/

import { readFile } from "node:fs/promises";
import pkg from "../package.json" with { type: "json" };
import { FallbackMode, OptionKind, command, argsbarg, tool } from "../src/index.ts";
import { z } from "zod";

const statApp = argsbarg({
  commands: [
    command({
      key: "owner",
      description: "Ownership helpers.",
      commands: [
        command({
          key: "lookup",
          description: "Resolve owner info.",
          options: [
            {
              name: "json",
              description: "Emit handler output as JSON.",
              kind: OptionKind.Presence,
            },
            {
              name: "user-name",
              description: "User to look up.",
              kind: OptionKind.String,
              shortName: "u",
            },
          ],
          positionals: [
            {
              name: "path",
              description: "File or directory.",
              kind: OptionKind.String,
            },
          ],
          handler: (ctx) => {
            const user = ctx.inputs["user-name"] ?? "?";
            const path = ctx.inputs.path;
            if (!path) {
              console.error("Missing path.");
              process.exit(1);
            }
            if (ctx.inputs.json) {
              const payload = { user, path };
              console.log(JSON.stringify(payload));
              return;
            }
            const text = `lookup user=${user} path=${path}`;
            console.log(text);
          },
        }),
      ],
    }),
  ],
  description: "File metadata.",
  key: "nested-stat.ts",
  version: pkg.version,
});

const app = argsbarg({
  children: {
    stat: { app: statApp, expose: ["cli"] },
  },
  commands: [
    command({
      key: "read",
      description: "Print the first line of each file.",
      notes: "Pass one or more file paths. The program prints the first line of each.",
      positionals: [
        {
          name: "files",
          description: "Paths to read.",
          kind: OptionKind.String,
          argMax: 0,
        },
      ],
      handler: async (ctx) => {
        const files = ctx.inputs.files;
        if (files.length === 0) {
          console.error("Missing file path.");
          process.exit(1);
        }
        for (const path of files) {
          try {
            const text = await readFile(path, "utf8");
            const firstLine = text.split("\n")[0];
            console.log(`${path}: ${firstLine}`);
          } catch {
            console.error(`Cannot open: ${path}`);
          }
        }
      },
    }),
  ],
  description: "Nested groups demo.",
  fallbackCommand: "read",
  fallbackMode: FallbackMode.MissingOrUnknown,
  key: "nested.ts",
  mcp: {
    tools: [
      tool()({
        name: "stat_owner_lookup",
        description: "Resolve owner info for a file or directory.",
        inputSchema: z.strictObject({
          json: z.boolean().optional(),
          path: z.string(),
          "user-name": z.string().optional(),
        }),
        handler: ({ inputs }) => {
          const user = inputs["user-name"] ?? "?";
          return inputs.json
            ? { user, path: inputs.path }
            : `lookup user=${user} path=${inputs.path}`;
        },
      }),
      tool()({
        name: "read",
        description: "Print the first line of each file.",
        inputSchema: z.strictObject({
          files: z.union([z.string(), z.array(z.string())]),
        }),
        handler: async ({ inputs }) => {
          const files = typeof inputs.files === "string" ? [inputs.files] : inputs.files;
          const lines: string[] = [];
          for (const path of files) {
            try {
              const text = await readFile(path, "utf8");
              lines.push(`${path}: ${text.split("\n")[0]}`);
            } catch {
              lines.push(`Cannot open: ${path}`);
            }
          }
          return lines.join("\n");
        },
      }),
    ],
  },
  version: pkg.version,
});

await app.run();

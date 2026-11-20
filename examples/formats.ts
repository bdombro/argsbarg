#!/usr/bin/env node
/*
 * Value formats demo: duration, comma-list, date, default, and ctx.inputs.
 * Run: node ./examples/formats.ts run --tags alpha,beta --on 2026-06-22
 * MCP: pass comma-list as string or array; varargs N/A on this leaf.
 */

import pkg from "../package.json" with { type: "json" };
import { FallbackMode, OptionKind, ValueFormat, command, argsbarg } from "../src/index.ts";

const app = argsbarg({
  commands: [
    command({
      key: "run",
      description: "Print coerced option values from ctx.inputs.",
      options: [
        {
          name: "timeout",
          description: "Wait budget (default 30s).",
          kind: OptionKind.String,
          format: ValueFormat.Duration,
          default: "30s",
        },
        {
          name: "tags",
          description: "Comma-separated labels.",
          kind: OptionKind.String,
          format: ValueFormat.CommaList,
        },
        {
          name: "on",
          description: "Calendar day (YYYY-MM-DD).",
          kind: OptionKind.String,
          format: ValueFormat.Date,
        },
        {
          name: "verbose",
          description: "Also print raw ctx.opts strings.",
          kind: OptionKind.Presence,
          shortName: "v",
        },
      ],
      handler: (ctx) => {
        const inputs = ctx.inputs;
        const out = {
          inputs,
          durationMs: inputs.timeout,
          tags: inputs.tags,
          on: inputs.on,
        };
        if (inputs.verbose) {
          const rawOpts: Record<string, string> = {};
          const argv = process.argv.slice(2);
          for (let index = 0; index < argv.length; index++) {
            const token = argv[index] ?? "";
            if (token === "-v" || token === "--verbose" || token.startsWith("--verbose=")) {
              rawOpts.verbose = "1";
              continue;
            }
            const match = token.match(/^--(timeout|tags|on)(?:=(.*))?$/);
            if (!match) continue;
            rawOpts[match[1]] = match[2] ?? argv[++index] ?? "";
          }
          rawOpts.timeout ??= "30s";
          Object.assign(out, { rawOpts });
        }
        process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
      },
    }),
  ],
  description: "Value formats and ctx.inputs demo.",
  fallbackCommand: "run",
  fallbackMode: FallbackMode.MissingOnly,
  key: "formats.ts",
  version: pkg.version,
});

await app.run();

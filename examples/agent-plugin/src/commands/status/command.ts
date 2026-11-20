/*
Status leaf — demonstrates outputSchema.
*/

import { command, OptionKind } from "argsbarg";
import { z } from "zod";
import pkg from "../../../package.json" with { type: "json" };

/** JSON stdout for `example-agent-plugin status --json`. */
export const StatusJsonOutput = z.strictObject({
  version: z.string().describe("App version from program root."),
});

/** `status --json` payload. */
export type StatusJsonOutput = z.infer<typeof StatusJsonOutput>;

/** Prints the app version (JSON with `--json`). */
export const statusCommand = command({
  key: "status",
  description: "Show app version.",
  options: [
    {
      name: "json",
      description: "Emit JSON.",
      kind: OptionKind.Presence,
    },
  ],
  outputSchema: StatusJsonOutput,
  handler: () => ({ version: pkg.version }),
});

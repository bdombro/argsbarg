/*
Status leaf — version with optional JSON stdout (no schemas).
*/

import { command, OptionKind } from "argsbarg";
import pkg from "../../../package.json" with { type: "json" };

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
  handler: (ctx) => {
    const out = { version: pkg.version };
    return ctx.inputs.json ? out : `version=${out.version}`;
  },
});

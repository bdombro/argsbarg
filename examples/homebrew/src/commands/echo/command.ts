/*
Echo leaf — minimal MCP-friendly command; `ctx.inputs` is typed from the option literal (command).
*/

import { command, OptionKind } from "argsbarg";

/** Returns the `message` option for CLI output. */
export const echoCommand = command({
  key: "echo",
  description: "Echo a message (MCP-friendly leaf).",
  options: [
    {
      name: "message",
      description: "Text to print.",
      kind: OptionKind.String,
      required: true,
    },
  ],
  handler: (ctx) => {
    const { message } = ctx.inputs;
    return message;
  },
});

/*
Defines MCP help and bundle commands without a bare MCP service-start alias.
The framework starts MCP only through the accepted `serve` grammar.
*/

import {
  type AppSpec,
  type CommandGroup,
  type CommandOption,
  OptionKind,
  type RunnableCommand,
} from "../core/types.ts";

/** Supported CLI overrides for explicit MCP service launch paths. */
const MCP_SERVE_OPTIONS: readonly CommandOption[] = [
  { name: "obscure-errors", description: "Hide unexpected errors from clients.", kind: OptionKind.Presence },
  {
    name: "log-format",
    description: "Log format: json (ECS Logging) or text.",
    kind: OptionKind.Enum,
    choices: ["json", "text"],
  },
  {
    name: "log-file",
    description: "Append logs to this file (relative → app config dir).",
    kind: OptionKind.String,
  },
  { name: "dev", description: "Print full stacks to stderr on errors.", kind: OptionKind.Presence },
];

/** Built-in `mcp` router with explicit service and bundle subcommands. */
export function cliBuiltinMcpCommand(_program: AppSpec): CommandGroup {
  const lines = [
    "Stdio MCP server. Add to Cursor, Claude Code, or Claude Desktop:",
    "",
    "  command: {argsbarg:program}",
    "  args: serve mcp --stdio",
    "",
  ];

  const bundle: RunnableCommand = {
    key: "bundle",
    description: "Pack dist MCP artifacts (`.mcpb`, Claude Code plugin zip, Cursor plugin zip) from dist/<key>.",
    handler: () => {},
  };

  return {
    key: "mcp",
    description: "MCP server and bundle tools.",
    notes: lines.join("\n"),
    options: [...MCP_SERVE_OPTIONS],
    commands: [bundle],
  };
}

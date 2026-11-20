/*
Defines the capability-gated HTTP help node without registering a service-start alias.
Its options are shared by the accepted `serve http` launcher grammar.
*/

import {
  type AppSpec,
  type CommandGroup,
  type CommandOption,
  OptionKind,
} from "../core/types.ts";
import { resolveHttpServeConfig } from "../server/overrides.ts";

/** Supported CLI overrides for the explicit `serve http` launcher. */
const HTTP_SERVE_OPTIONS: readonly CommandOption[] = [
  { name: "host", description: "Listen host.", kind: OptionKind.String },
  { name: "port", description: "Listen port.", kind: OptionKind.Number },
  { name: "trust-proxy", description: "Honor X-Forwarded-For for client IP.", kind: OptionKind.Presence },
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
  { name: "no-access-log", description: "Disable HTTP access logs.", kind: OptionKind.Presence },
  { name: "dev", description: "Print full stacks to stderr on errors.", kind: OptionKind.Presence },
];

/** Built-in `http` router retained for accepted service help and compatibility validation. */
export function cliBuiltinHttpCommand(program: AppSpec): CommandGroup {
  const target = resolveHttpServeConfig(program).targets[0];
  const address = target.kind === "tcp" ? `http://${target.host}:${target.port}` : "configured HTTP listener";
  const lines = [
    `HTTP service on ${address}.`,
    "",
    "REST: /api/openapi.json and /api/*; JSON-RPC: /rpc/openrpc.json and /rpc; MCP: /mcp.",
    "",
  ];

  return {
    key: "http",
    description: "HTTP API server for tools.",
    notes: lines.join("\n"),
    options: [...HTTP_SERVE_OPTIONS],
    commands: [],
  };
}

export { HTTP_SERVE_OPTIONS };

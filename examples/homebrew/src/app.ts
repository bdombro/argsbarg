/*
Reference AppSpec for the Homebrew template — builtins on, with explicit native
surface declarations and package.json as the runtime/release version source.
*/

import { argsbarg, method, route, tool } from "argsbarg";
import { z } from "zod";
import pkg from "../package.json" with { type: "json" };
import { echoCommand } from "./commands/echo/command.ts";
import { statusCommand } from "./commands/status/command.ts";
import { createIdentity } from "./create-identity.ts";

/** Shared native-surface input for echo. */
const EchoInput = z.strictObject({ message: z.string() });
/** Shared status result. */
const StatusOutput = z.strictObject({ version: z.string() });

/** Composed Homebrew example with independently declared CLI and wire surfaces. */
export const app = argsbarg({
  commands: [echoCommand, statusCommand],
  description: createIdentity.desc,
  http: {
    routes: [
      route()({
        body: EchoInput,
        description: "Echo a message.",
        handler: ({ inputs }) => inputs.message,
        id: "echo",
        method: "POST",
        outputSchema: z.string(),
        path: "/echo",
      }),
      route()({
        description: "Show app version.",
        handler: () => ({ version: pkg.version }),
        id: "status",
        method: "GET",
        outputSchema: StatusOutput,
        path: "/status",
      }),
    ],
  },
  jsonRpc: {
    methods: [
      method()({ name: "echo", description: "Echo a message.", inputSchema: EchoInput, handler: ({ inputs }) => inputs.message }),
      method()({
        name: "status",
        description: "Show app version.",
        inputSchema: z.strictObject({}),
        outputSchema: StatusOutput,
        handler: () => ({ version: pkg.version }),
      }),
    ],
  },
  key: createIdentity.key,
  mcp: {
    tools: [
      tool()({ name: "echo", description: "Echo a message.", inputSchema: EchoInput, handler: ({ inputs }) => inputs.message }),
      tool()({
        name: "status",
        description: "Show app version.",
        inputSchema: z.strictObject({}),
        outputSchema: StatusOutput,
        handler: () => ({ version: pkg.version }),
      }),
    ],
  },
  version: pkg.version,
});

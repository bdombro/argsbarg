/*
Reference AppSpec — builtins on with independent CLI, REST, JSON-RPC, and MCP declarations.
The version is read from `package.json` at runtime, so the same code runs from
`src/` (`node src/index.ts`) and from the compiled `dist/` (`npx example-cli`).
*/

import { readFileSync } from "node:fs";
import { argsbarg, method, route, tool } from "argsbarg";
import { z } from "zod";
import { echoCommand } from "./commands/echo/command.ts";
import { statusCommand } from "./commands/status/command.ts";
import { createIdentity } from "./create-identity.ts";

/** Reads a file from the package root (one level above `src/` or `dist/`). */
function packageFile(
  /** Path relative to the package root. */
  rel: string,
): string {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

/** Package version from `package.json` (bumped by `npm run release`). */
const version = (JSON.parse(packageFile("package.json")) as { version: string }).version;

/** Input shared by the CLI-independent echo surfaces. */
const EchoInput = z.strictObject({ message: z.string() });

/** Version payload returned by status surfaces that expose schemas. */
const StatusOutput = z.strictObject({ version: z.string() });

/** REST declaration for echoing a message. */
const echoRoute = route()({
  body: EchoInput,
  description: "Echo a message.",
  handler: ({ inputs }) => inputs.message,
  id: "echo",
  method: "POST",
  outputSchema: z.string(),
  path: "/echo",
});

/** REST declaration for reporting the package version. */
const statusRoute = route()({
  description: "Show app version.",
  handler: () => ({ version }),
  id: "status",
  method: "GET",
  outputSchema: StatusOutput,
  path: "/status",
});

/** JSON-RPC declaration for echoing a message. */
const echoMethod = method()({
  name: "echo",
  description: "Echo a message.",
  inputSchema: EchoInput,
  handler: ({ inputs }) => inputs.message,
});

/** JSON-RPC declaration for reporting the package version. */
const statusMethod = method()({
  name: "status",
  description: "Show app version.",
  inputSchema: z.strictObject({}),
  outputSchema: StatusOutput,
  handler: () => ({ version }),
});

/** Example application with completion, version, MCP, and HTTP capabilities enabled. */
export const app = argsbarg({
  commands: [echoCommand, statusCommand],
  description: createIdentity.desc,
  http: { routes: [echoRoute, statusRoute] },
  jsonRpc: { methods: [echoMethod, statusMethod] },
  key: createIdentity.key,
  mcp: {
    tools: [
      tool()({ name: "echo", description: "Echo a message.", inputSchema: EchoInput, handler: ({ inputs }) => inputs.message }),
      tool()({
        name: "status",
        description: "Show app version.",
        inputSchema: z.strictObject({}),
        outputSchema: StatusOutput,
        handler: () => ({ version }),
      }),
    ],
  },
  version,
});

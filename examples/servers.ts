#!/usr/bin/env node
/*
This example shows the smallest end-to-end CLI+MCP+API setup.
It includes one command, a couple of options, and a direct call to the runtime so
readers can copy the pattern into their own scripts quickly.

Demonstrates: `app.ts hello`, MCP tool `hello`, and `POST /hello`.

Ex API Call:
curl -s -X POST http://127.0.0.1:3000/hello \
  -H 'content-type: application/json' \
  -d '{"name":"alice"}'
Ex API Response:
{ "greeting": "hello alice" }


*/

import pkg from "../package.json" with { type: "json" };
import { method, OptionKind, allow, route, tool, command, argsbarg } from "../src/index.ts";
import { z } from "zod";

declare module "../src/index.ts" {
  interface Locals {
    /** Verified caller label established by the active demo entry point. */
    readonly caller?: string;
  }
}

/** Native wire input shared by the explicit service declarations. */
const HelloInput = z.strictObject({
  name: z.string().optional(),
  verbose: z.boolean().optional(),
});

const app = argsbarg({
  cli: {
    guard: (ctx) =>
      allow({
        caller: ctx.source === "local" ? (ctx.env.get("DEMO_CALLER") ?? "local-demo") : "unknown-demo",
      }),
  },
  commands: [
    command({
      key: "hello",
      description: "Say hello.",
      guard: () => allow(),
      positionals: [
        {
          name: "name",
          description: "Who to greet.",
          kind: OptionKind.String,
          argMin: 0,
          argMax: 1,
        },
      ],
      options: [
        {
          name: "verbose",
          description: "Enable extra logging.",
          kind: OptionKind.Presence,
          shortName: "v",
        },
      ],
      handler: (ctx) => {
        const name = ctx.inputs.name ?? "world";
        if (ctx.inputs.verbose && ctx.surface === "cli") {
          console.log("verbose mode");
        }
        const greeting = `hello ${name}`;
        if (ctx.surface === "cli") {
          console.log(greeting);
          return;
        }
        return { greeting, verbose: ctx.inputs.verbose };
      },
    }),
  ],
  description: "Tiny demo.",
  http: {
    routes: [
      route()({
        body: HelloInput,
        description: "Say hello.",
        handler: ({ inputs }) => ({ greeting: `hello ${inputs.name ?? "world"}`, verbose: inputs.verbose ?? false }),
        id: "hello",
        method: "POST",
        outputSchema: z.strictObject({ greeting: z.string(), verbose: z.boolean() }),
        path: "/hello",
      }),
    ],
  },
  jsonRpc: {
    methods: [
      method()({
        name: "hello",
        description: "Say hello.",
        inputSchema: HelloInput,
        handler: ({ inputs }) => ({ greeting: `hello ${inputs.name ?? "world"}`, verbose: inputs.verbose ?? false }),
      }),
    ],
  },
  key: "servers.ts",
  mcp: {
    guard: ({ locals }) => allow({ caller: locals.caller ?? "local-demo" }),
    http: {
      middleware: (_request, { headers }) => ({
        kind: "next",
        locals: {
          caller: headers.get("X-Demo-Caller") ?? "http-demo",
        },
      }),
    },
    tools: [
      tool()({
        name: "hello",
        description: "Say hello.",
        guard: () => allow(),
        inputSchema: HelloInput,
        handler: ({ inputs }) => ({ greeting: `hello ${inputs.name ?? "world"}`, verbose: inputs.verbose ?? false }),
      }),
    ],
  },
  version: pkg.version,
});

await app.run();

```
                          ___.
_____ _______  ____  _____\_ |__ _____ _______  ____
\__  \\_  __ \/ ___\/  ___/| __ \\__  \\_  __ \/ ___\
 / __ \|  | \/ /_/  >___ \ | \_\ \/ __ \|  | \/ /_/>
(____  /__|  \___  /____  >|___  (____  /__|  \___  /
     \/     /_____/     \/     \/     \/     \/____/
```

[GitHub](https://github.com/bdombro/argsbarg) · [npm](https://www.npmjs.com/package/argsbarg) · MIT

Argsbarg builds a CLI, REST API, JSON-RPC server, and MCP server from explicit declarations. One package and one executable own the surfaces; declarations share business logic without pretending every CLI command is a wire endpoint.

Requirements: Node 20+, Zod 4 peer dependency.

## Start

```bash
npm install argsbarg zod
```

```typescript
import { argsbarg, command, method, route, tool } from "argsbarg";
import { z } from "zod";

const Input = z.strictObject({ name: z.string() });
const app = argsbarg({
  cli: {
    guard: requireLocalCaller,
  },
  commands: [
    command({
      key: "greet",
      description: "Greet someone.",
      guard: "public",
      inputSchema: Input,
      kind: "document",
      handler: ({ inputs }) => `hello ${inputs.name}`,
    }),
  ],
  description: "Greeting tools.",
  http: {
    routes: [
      route()({
        id: "greet",
        method: "POST",
        path: "/greet",
        description: "Greet someone.",
        body: Input,
        outputSchema: z.string(),
        handler: ({ inputs }) => `hello ${inputs.name}`,
      }),
    ],
  },
  jsonRpc: {
    methods: [
      method()({
        name: "greet",
        description: "Greet someone.",
        inputSchema: Input,
        outputSchema: z.string(),
        handler: ({ inputs }) => `hello ${inputs.name}`,
      }),
    ],
  },
  key: "hello",
  mcp: {
    guard: requireMcpCaller,
    http: {
      middleware: async (_request, { headers }) => {
        const token = headers.get("Authorization");
        return token
          ? { kind: "next", locals: { caller: await verifyToken(token) } }
          : { kind: "respond", response: new Response(null, { status: 401 }) };
      },
    },
    tools: [
      tool()({
        name: "greet",
        description: "Greet someone.",
        guard: requireReportScope,
        inputSchema: Input,
        outputSchema: z.string(),
        handler: ({ inputs }) => `hello ${inputs.name}`,
      }),
    ],
  },
  version: "1.0.0",
});

await app.run();
```

Handlers receive `ctx.inputs`, `ctx.locals`, `ctx.signal`, `ctx.surface`, and exactly one credential source (`ctx.env` or `ctx.headers`). They return values or a native Web `Response`.

```bash
hello greet '{"name":"Ada"}'
hello serve                  # all configured HTTP mounts
hello serve http
hello serve rpc
hello serve mcp --stdio
printf '%s\n' '{"name":"Ada"}' | hello api POST /api/greet
printf '%s\n' '{"name":"Ada"}' | hello rpc greet
printf '%s\n' '{"name":"Ada"}' | hello mcp call greet
```

Bare `serve` starts every configured HTTP mount. Name a surface, such as `serve http`, to start only that HTTP mount; `serve mcp --stdio` is the separate stdio transport.

`api`, `rpc`, and `mcp call` execute locally and read an optional JSON document from stdin. Add `--yaml` for YAML input and structured output, or `--relay <url>` for one explicit request. A relay never falls back to local execution.

## Composition and policy

`cli.guard` protects user-authored commands, and `mcp.guard` protects MCP tool calls. An operation `guard` supplements its surface default; `{ mode: "override", run }` replaces only that default, while `"public"` removes only that default. Generated `api`, `rpc`, and `mcp call` commands run the target surface policy, never a synthetic CLI guard.

For MCP over HTTP, `mcp.http.middleware` alone owns transport admission and request seeding. It returns either `{ kind: "respond", response }` or `{ kind: "next", locals }`. Those locals feed the MCP guard and tool guard. Stdio and local `mcp call` have no HTTP shortcut: guards derive callers from the exclusive local environment source.

Standalone apps can be composed by exact mount key:

```typescript
const suite = argsbarg({
  ...suiteMetadata,
  children: {
    billing: { app: billingApp },
    reports: { app: reportsApp, expose: ["cli", "mcp"] },
  },
});
```

Children are immutable build-time snapshots under parent-owned transports. Keys namespace CLI paths, REST paths and operation IDs, RPC methods, MCP tools, MCP task IDs, and scoped `ENV_`/header credential names. Child guards and hooks stay attached; parent surface defaults and hooks do not apply to child declarations. A child MCP Tasks provider owns follow-ups for its exact mounted path; no ancestor or parent provider fallback occurs. This does not merge child processes, listeners, lifecycle, OAuth configuration, stores, or runtime bundles.

## Templates

```bash
npx argsbarg@latest create my-app
npx argsbarg@latest create my-app --template api --yes
```

The package includes `cli`, `api`, `agent-plugin`, and `homebrew` templates plus single-file examples.

The package also ships two authoring skills. `argsbarg-bootstrap` creates a new app from an intent-first scaffold request; `argsbarg-upsert` adds, removes, pivots, or upgrades independent CLI, REST, JSON-RPC, and MCP capabilities in scaffolded or external apps. All four templates include `argsbarg-upsert`.

## Documentation

- [Authoring CLI, guards, and invocation](docs/cli-program.md)
- [Zod schemas](docs/schemas.md)
- [REST](docs/http-server.md)
- [MCP](docs/mcp.md)
- [Server logging](docs/logging.md)
- [Use cases](docs/use-cases/README.md)
- [Development](docs/developing.md)
- [Design decisions](docs/decisions.md)

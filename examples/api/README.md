# example-api

Argsbarg schema-first npm template (Zod schemas, typed commands, REST CRUD).

## Installation

```bash
npx example-api --help
# or
npm install -g example-api
```

Requires Node ≥ 22.13 (`node:sqlite`). Shell completions: `example-api completion zsh --help` (also bash and fish).

## Commands

- `example-api echo` — Echo text back to stdout or inspect flags.
- `example-api render-json` — Process structured JSON payloads with schema validation.
- `example-api shape-area` — Discriminated-union JSON input (MCP clients see it wrapped as `{ input }`).
- `example-api status` — Show application version with a Zod output schema (`--json`).
- `example-api workspaces` — Manage workspace resources (REST CRUD with in-memory SQLite).

### Built-in commands

- `example-api completion` — Print shell tab-completion scripts (bash, zsh, fish).
- `example-api serve http` — Start the shared HTTP listener.
- `example-api serve mcp --stdio` — Start the MCP stdio server.
- `example-api version` — Display version information.

## Usage

```bash
# Print a message
example-api echo "Hello, world!"

# Inspect JSON status
example-api status --json

# Workspaces over HTTP (the in-memory database lives in the server process)
example-api serve http &
curl -s localhost:3000/api/workspaces

# Start the MCP server for AI agents
example-api serve mcp --stdio
```

## AI Agent & MCP Integration

`example-api` includes an MCP server and an agent skill:

The example enables completion, version, and independent REST, JSON-RPC, and MCP declarations.

- **MCP server**: add `{ "command": "npx", "args": ["-y", "example-api", "serve", "mcp", "--stdio"] }` to your client's MCP config.
- **Agent skill**: See `skills/example-api/SKILL.md` for agent command group instructions.
- **MCP Tasks demo**: call `taskProbe` from a task-capable client. The template owns
  its in-memory task state and exposes guarded `get`, `update`, and `cancel` callbacks;
  replace that store with the application's real queue or job service.

CLI and local MCP calls may set `EXAMPLE_API_CALLER`; MCP HTTP requests may set
`X-Example-Api-Caller`. The template's guards seed this non-security caller label
only. Replace the demonstration policy with real credential verification before
protecting an application.

The template stays standalone rather than mounting a child app merely to
demonstrate composition. Apps that need it use keyed `children` mounts and keep
each child declaration's own guards and hooks.


## Development

Requires Node ≥ 22.18 and [just](https://just.systems):

```bash
just setup             # npm install
just test              # Biome, tsc, node --test
just run --help        # from source
just build             # tsc → dist/ (+ SQL migrations)
just release patch --dry-run
```

# example-cli

Argsbarg npm CLI template (npx, MCP, HTTP; options and flags only).

## Installation

Run without installing:

```bash
npx example-cli --help
```

Or install globally:

```bash
npm install -g example-cli
```

Shell completions: `example-cli completion zsh --help` (also bash and fish).

## Commands

- `example-cli echo` — Echo text back to stdout or inspect flags.
- `example-cli status` — Show application version with optional `--json`.

### Built-in commands

- `example-cli completion` — Print shell tab-completion scripts (bash, zsh, fish).
- `example-cli serve` — Start every configured HTTP mount.
- `example-cli serve http` — Start only the REST HTTP mount.
- `example-cli serve mcp --stdio` — Start the MCP stdio server.
- `example-cli version` — Display version information.

## Usage

```bash
example-cli echo --message "Hello, world!"
example-cli status --json
example-cli serve
example-cli serve mcp --stdio
```

## AI Agent & MCP Integration

The example enables completion, version, independent MCP, REST, and JSON-RPC declarations.

- **MCP server**: add `{ "command": "npx", "args": ["-y", "example-cli", "serve", "mcp", "--stdio"] }` to your client's MCP config.
- **Agent skill**: `skills/example-cli/SKILL.md`; copy it into your agent's skill directory.


## Development

Requires Node ≥ 22.18 and [just](https://just.systems):

```bash
just setup             # npm install
just test              # Biome, tsc, node --test
just run --help        # from source
just build             # tsc → dist/
just release patch --dry-run
```

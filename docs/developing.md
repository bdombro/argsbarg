# Developing argsbarg

## Prerequisites

- Node 22.18+ for type-stripped source tests
- npm
- just
- zsh; the repository and template `justfile` recipes use `zsh -eu -o pipefail`
- Bun only for the Homebrew template

## Checks

```bash
just test
just example-full-check
just examples-test
just build
npm pack --dry-run --json
git diff --check
```

`just build` replaces `dist/`. The release recipe is the only version-bump path; do not edit package versions manually.

## Structure

- `src/core/` — invocation, errors, Zod, CLI declarations, config directory
- `src/cli/` — native CLI bind/encode and mirror calls
- `src/http/` — explicit route catalog, REST dispatch, OpenAPI, local/relay mirror
- `src/json-rpc/` — explicit method catalog, JSON-RPC dispatch, OpenRPC, mirror
- `src/mcp/` — tool registry, dispatcher, stdio/HTTP adapters, mirrors, package builders
- `src/server/` — shared listener and bind lifecycle
- `src/runtime/` — `argsbarg()` factory, guarded invocation, startup
- `src/cli-tool/` — the package scaffold command

The package has one public entry point: `src/index.ts`. Cross-module `src/` imports are relative `.ts` paths. Every changed `src/` or `scripts/` file and symbol follows the repository JSDoc/file-header rules.

## Templates

`examples/cli`, `examples/api`, `examples/agent-plugin`, and `examples/homebrew` are copy templates or distribution examples. CLI and API must keep completion, version, REST, and MCP enabled.

The package ships `skills/argsbarg-bootstrap/` for intent-first new-app creation and `skills/argsbarg-upsert/` for changes to existing or external apps. Every template contains an identical copy of the upsert skill; the template-specific operation skill remains separate. Keep the copies identical and verify `argsbarg create` includes both app-specific and shared skills.

After framework, capability, or schema-guide changes:

```bash
just example-full-check
just examples-test
just test
```

Refresh installed template copies with `just examples-install` when validating declaration changes against packaged types.

## Packaging

`package.json.files` includes `dist`, docs, examples, README, license, and changelog. The npm package has one library export and one `argsbarg` scaffold executable. Plugin and bundle configs launch the consumer's own executable with `serve mcp --stdio`.

## Release

Only an explicitly requested `just release <level>` may bump version, promote the changelog, commit, tag, or publish. Integration work keeps the current version unchanged and records changes under `[Unreleased]`.

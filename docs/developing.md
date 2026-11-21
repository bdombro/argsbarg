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

### MCP Tasks smoke test

Run `just mcp-tasks-smoke` on v9 and again after the SDK migration. It launches
the built server over stdio and checks discovery, listing, the no-Tasks fallback
(no job starts), and a Tasks-capable client's native task handle, push updates,
and final `tasks/get` result. The synthetic client advances the fixture through
a private IPC channel only after subscription acknowledgment. It uses no
network, model, or credentials and is not published in the npm package.

For an opt-in real-host run, build first and point the existing `mcp-client-smoke`
skill at `node /absolute/path/to/argsbarg/scripts/mcp-tasks-smoke-fixture.ts serve mcp --stdio`.
Call only `start_synthetic_mining` with `{}`. Without the fixture's test IPC
channel, the job progresses on its own. Inspect `server/discover` and the
per-request Tasks capability separately from the tool result. If the host
declares Tasks, look for a subscription acknowledgment, working and completed
snapshots, and the final result `{ "rows": 3 }`. A normal tool call or a local
smoke pass does not prove host push delivery, cancellation, or idle-agent wake-up.

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

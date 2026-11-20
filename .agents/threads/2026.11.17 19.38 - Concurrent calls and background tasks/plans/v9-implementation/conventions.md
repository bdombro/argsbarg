---
rev: 1
---
# v9 conventions and verification

Explicitly load repo `AGENTS.md`, `README.md`, relevant `docs/` and the nearest example instructions when applicable. [Workspace](../../workspace.md) records evidence and restrictions; [state](../../state.md) records host provenance and authorization. An assignment names required sources and verifies instruction compliance separately from automatic inheritance. Resolve unavailable required sources before affected substantive work. Do not load, call or substitute for `thread-memory` recall in this swarm.

## Editing and review

- Use human-readable file purpose headers and required JSDoc on new/changed `src/` and `scripts/` symbols. Follow repo exceptions for short test callbacks/pure re-exports. Sort imports and explicit re-exports by module path; use relative `.ts` specifiers and explicit `index.ts` for directory barrels. Change importers when moving a symbol; no obsolete barrel shim. Keep helpers local unless reuse or readability justifies extraction.
- Review against one public root entry, no speculative layers or production deps, Zod as peer, native boundary errors, no credential fallback or leaks, and no server setup on import. User-facing instructions belong in the authoritative guide, not duplicated in example instructions. Do not edit the seed or create a migration guide.
- Feature changes require an Unreleased changelog entry. Hand changelog and overlapping docs/examples to their owner; never overwrite existing dirty hunks. Built-in, capability or schemagen doc changes require CLI/API template sync and the repo-mandated checks in `AGENTS.md`. Include packaging and authoring paths when the new startup/public contracts land. Explicitly load the user justfile guidance before editing a justfile.

## Verification reference absorbed from the seed

Use the cheapest meaningful local test for each accepted behavior and retain sanitized commands/exit codes. At integration, verify:

- **Packaging and startup:** fresh-install CLI, REST-only, RPC-only, MCP HTTP-only, combined HTTP surfaces and stdio via manifest/bundle; CLI/help/stdio never open HTTP listeners. Invalid config and collisions fail without partial readiness; rollback/drain, separate runtimes and borrowed resource ownership. If socket binds are selected, test socket-only, same dispatcher across binds and ownership-safe cleanup.
- **Invocation and guards:** compare native and mirrored inputs/denials/results for route, method and tool; route key collision and bad input stop before effects. Confirm env/header separation, guard composition and per-invocation caller isolation; test child standalone/mounted names, scoped credentials, collision errors, unchanged transport visibility, and curated gateway registration from public API.
- **HTTP and RPC:** verify discovery/dispatch match, absent cross-generated endpoints, preserved native responses, independent batch failures/notifications, and incremental download/NDJSON/SSE under backpressure and disconnect.
- **MCP tools and mirrors:** local mirror no listener, relay hits only the remote MCP wire, two standalone processes select different transports, combined launch rejects before either starts. Assert discovery/cache ordering and metadata, version rejection, progress/cancellation and a blocked call unblocked by a second call without stdout contamination.
- **Hosted OAuth and upstream sign-in:** exercise metadata/challenge/scope separation and no sibling or local leakage with controlled fixtures. Real harness/issuer discovery, refresh, scope step-up, URL-mode continuation compatibility and consent flows remain unverified under current authority. No host smoke tests, credential acquisition or external calls; record gaps without adding legacy fallback.
- **Task providers:** capability absent vs negotiated; terminal get, pending input update, cancellation and ownership in both in-memory and durable recipes; reconnect/restart where applicable, no cancellation from transport loss. No protocol admin operations.
- **Authoring/config:** platform defaults and explicit override validation, creation/reuse, restart consistency for configured startup omissions; deterministic examples, intent clarification, idempotent upsert and unchanged unrelated packaging.

## Repository checks (documented, not run in B0)

From the repo root, `just test`, `just examples-test`, `just example-full-check`, and `just build` are the integration checks named in `AGENTS.md`, `docs/developing.md`, `justfile` and the seed. Verify the relevant recipe and its write footprint before use: `just test` runs formatting; `just build` replaces `dist`. Do not run any mutating recipe on unowned files, invoke setup/install as a default, or use CI. A local wire suite does not establish real host compatibility.

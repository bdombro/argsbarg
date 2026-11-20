# Workspace — Argsbarg v9

Argsbarg is a TypeScript framework and CLI tool that turns Zod-backed declarations into callable interfaces, documentation and distributable apps. The v9 work replaces CLI-derived network exposure with explicitly declared surfaces; this brief records the current checkout separately from that target.

## Scope and locations

- Effective analysis root: current Argsbarg workspace, as specified by B0. Cwd and containing repository root independently coincide with it (`.`).
- Thread/artifact storage: `.agents/threads/2026.11.17 19.38 - Concurrent calls and background tasks/`; [implementation map](plans/v9-implementation/map.md). Source pointers are repo-relative; thread links are file-relative.
- Scope: repository-wide orientation with focused v9 evidence; no source writes. No existing workspace brief to reuse. The supplied [design seed](plans/2026.11.18%20-%20Argsbarg%20next%20major%20design%20decisions.md) is reused and kept unchanged.

## Coverage and layout

| Area | Role and evidence | Depth / limits |
| --- | --- | --- |
| `README.md`, `docs/`, `AGENTS.md`, `CLAUDE.md` | Public authoring/maintainer guide and repo instructions; use cases distinguish 8.x from previews; harness notes are desk evidence | `AGENTS.md`, README and relevant guides/sections explicitly read; `CLAUDE.md` inventoried, not a required Copilot source. No comprehensive doc audit or external link check |
| `src/index.ts`, `src/core/`, `src/runtime/`, `src/builtins/` | Single public entry; schema, argv, validation, invocation, help and built-ins | Targeted symbol checks of factory, argv and invocation scope; full internals and tests deferred |
| `src/headless/`, `src/http/`, `src/mcp/`, `src/server/`, `src/log/` | Wire bindings and helpers, REST/OpenAPI, MCP/stdout protocol and packaging, server config, structured stderr logs | Key dispatch seams and protocol constants checked; full streaming, auth and lifecycle trace deferred to refinement |
| `src/cli-tool/`, `examples/`, `src/test/`, colocated `*.test.ts` | Scaffold/legacy gateway, templates and demos, fixtures and tests | Public workflow and recipe pointers only; example-level instructions and detailed fixture coverage deferred to relevant assignments |
| `package.json`, lockfile, `tsconfig*.json`, `biome.json`, `justfile`, ignore files | Packaging, compilation, local quality and packaging boundaries | Manifest and key recipes inspected; transitive dependencies/generated outputs not traversed |
| `scripts/`, `.github/`, `.cursor/`, `LICENSE`, `CHANGELOG.md` | Release machinery, external workflow/editor configuration, license and history | Inventory only; no release, CI, or editor hooks invoked; changelog is dirty |
| `.agents/` | Thread history, seed and plan artifacts | Reused nominated thread; sibling artifacts not edited. Other threads, generated output, dependencies, other checkouts and git internals excluded from deep discovery |

## Observed architecture and flows

- `package.json` and `src/index.ts` expose one root library entry plus the scaffold CLI bin. README documents Node 20+ for built output and Zod as a peer; `docs/developing.md` requires newer Node for type-stripped source tests. No production dependency was added.
- `src/runtime/cli.ts` (`argsbarg`, `run`, `invoke`) builds a validated command spec and dispatches CLI work; current `run` has hard-exit paths. `src/core/` owns argv parsing, typed input and Zod conversion; `src/builtins/` wires capabilities and completions.
- HTTP route matching and MCP tool lookup use the command tree. `src/headless/tool-call.ts` bridges `httpRequestToArgv` (`src/http/routes.ts`) and `mcpToolCallToArgv` (`src/mcp/tools.ts`) into the CLI invocation path. `src/http/server.ts` is the current REST listener; `src/mcp/server.ts` is the current concurrent stdio loop and advertises older revisions, not v9. `src/log/` and `docs/logging.md` cover stderr vs protocol output.
- `src/runtime/invocation-scope.ts` uses async-local state for output isolation. Preserve behavior worth carrying forward (concurrent progress and cancellation, no handler output on MCP stdout), not the legacy argv bridge, process-exit API, stdio initialization or gateway registry. Review `src/mcp/pack/` for bundle reuse and `src/cli-tool/create.ts` for scaffold reuse.
- The [v9 contract](plans/v9-implementation/architecture.md) is intended behavior, not implemented behavior. Existing use-case examples marked “next-major” and harness/version notes are not runtime verification. Prototypes in adjacent repositories are historical evidence only and not build inputs.

## Validation and conventions

See [conventions](plans/v9-implementation/conventions.md) for instruction sources, review checks and exact documented local recipes. B0 ran read-only Git inventory with `git --no-pager --no-optional-locks status --short --branch` and `git --no-pager worktree list --porcelain`, examined source anchors with `rg`, and verified Node (`node --version`: `v26.13.1`) for the bootstrap scripts. No build, product suite or host smoke test was run.

## Risks and gaps

- Current CLI-centered code and 8.x docs conflict with the *target by design*. Refine by checking both native and mirrored behavior against the new contract, not by mechanically moving 8.x entry points.
- Dirty docs/README, changelog, justfiles and thread history are lead-owned input. New worktrees based on HEAD will not initialize from those edits; contracts must explicitly plan clean handoffs.
- `just test` invokes a formatter, `just build` replaces `dist`, and install recipes write dependency trees. Use isolated ownership or separately reviewed read-only validation before running mutating recipes.
- B0 did not trace all implementation internals or test the host matrix. Open signatures must be settled against the consumer scenarios; external evidence remains unavailable under this run's limits.

## Direct external context consulted

Outside-root reads were limited to `swarm-mode` role/host/reference/template/script files, `thread-memory` guidance and the host checkpoint “Next-Major Surface Pivots and Harness Docs” for design continuity. The current seed remains authoritative. No adjacent prototypes, external services, raw session logs or installed dependency trees were inspected.

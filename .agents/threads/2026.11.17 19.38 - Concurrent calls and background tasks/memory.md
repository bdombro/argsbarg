<!-- Generated from the swarm-mode skill template: templates/memory.md -->
<!-- Never include secrets or other sensitive information; sanitize before writing. -->
# Argsbarg v9 thread memory

<!-- Dense, durable facts only: decisions, preferences, gotchas and open items.
One line each, with a source pointer and date. No narrative or routine status. -->

- Argsbarg v9 is complete and released as `argsbarg@9.0.0`; commit `89fdf1d`, tag and GitHub release `v9.0.0`, npm publish succeeded. (`state.md`; `plans/v9-implementation/tasks/106.md`, 2026-11-20)
- Final validation passed 346/346 core tests, 32/32 template tests, all four create checks, build, 451-file package dry-run, 110/110 public-symbol parity, stale-artifact scan, and `git diff --check`. (`plans/v9-implementation/tasks/105.md`, 2026-11-20)
- The release commit excluded `.agents/**`; release automation now stages all product paths while excluding `.agents/`. (`scripts/release.ts`; `CHANGELOG.md`, 2026-11-20)
- v9 keeps one package and one executable, with independent CLI, REST, JSON-RPC and MCP declarations; native binding uses one D2 `invokeBound` path, isolated locals/output/signal, and no 8.x compatibility bridge. (`plans/v9-implementation/architecture.md`, 2026-11-20)
- D90 added public CLI/MCP guard and caller-seed APIs; MCP HTTP middleware uses an exact `next/respond` result and no ambient env/header fallback. (`plans/v9-implementation/decisions/D90.md`, 2026-11-20)
- D91 added build-time keyed child composition with composed identities, scoped env/header prefixes, preserved child guards/hooks, collision checks and parent-owned transport lifecycle; runtime gateway loading is removed. (`plans/v9-implementation/decisions/D91.md`, 2026-11-20)
- Each independently released Argsbarg app uses its own `package.json` version as canonical source; a root or per-example `VERSION` mirror was rejected as unnecessary drift. (`examples/homebrew/package.json`; `scripts/release.ts`, 2026-11-20)
- Biome is intentionally minimal: error-only `noUnsafeFinally` and `noGlobalEval`; formatter, recommended/style presets, import organization, secret heuristics and redundant TypeScript-overlap rules are not release gates. Narrow exact-rule inline suppressions are allowed with reasons. (`biome.json`; `CHANGELOG.md`, 2026-11-20)
- Bootstrap and upsert authoring skills ship for new and existing apps; unrelated surface preservation and intent clarification are required. (`skills/argsbarg-bootstrap/SKILL.md`; `skills/argsbarg-upsert/SKILL.md`, 2026-11-20)
- MCP Tasks, hosted OAuth, upstream browser sign-in and real-host compatibility remain deferred or unverified in v9; future work requires a new plan. (`docs/mcp.md`; `docs/use-cases/tasks.md`; `plans/v9-implementation/map.md`, 2026-11-20)
- The seed decision record remains historical provenance; task 39 is dropped and superseded by 39.1, and task 78 is dropped and superseded by narrower review tasks 116–121. (`plans/v9-implementation/tasks/39.md`; `tasks/78.md`; map, 2026-11-20)
- No v9 task remains active: 134 tasks are accepted and two are dropped; final task rollups 103/104/108 are accepted. (`plans/v9-implementation/map.md`, 2026-11-20)
- Disposable local `toolbarg`, `clibarg` and `httpbarg` experiment repositories were deleted after their evidence was preserved; `mcpbarg` did not exist. (thread closeout, 2026-11-20)
- Swarm review work is fastest when split to the same disjoint file sets as implementation; broad final reviews repeatedly delayed findings and should be rollups only. (`swarm-mode` feedback report, 2026-11-20)
- Launch, running-state update, agent metadata and map render must become one atomic lifecycle operation; otherwise the map lags agent completion and launch state. (`swarm-mode` feedback report, 2026-11-20)
- Full-tree validation should run once at integration; workers should retain focused proof, reviewers should read durable evidence, and only stale/missing evidence should trigger reruns. (`swarm-mode` feedback report, 2026-11-20)
- Release tasks, public integration, final validation and publish must be represented in the map from planning time rather than left as implicit gates. (`swarm-mode` feedback report, 2026-11-20)
- Parent implementation/review tasks should be rollups when children own disjoint work; rollups must not appear as executable `ready` or `running` rows. (`swarm-mode` feedback report, 2026-11-20)
- Future `.agents/` closeout should update plan state and Status immediately after release, mark dropped/superseded history explicitly, and keep these artifacts outside release commits. (`state.md`; `plans/v9-implementation/map.md`, 2026-11-20)

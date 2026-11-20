---
rev: 2
---
# v9 implementation rules

Read [architecture](architecture.md), [conventions](conventions.md) and the assignment. [State](../../state.md) owns authorizations, runtime defaults and worktree limits; [workspace](../../workspace.md) describes the checkout; [map](map.md) is provisional.

## Ownership and dispatch

- Full mode. Lead accepts bootstrap and merges independent evidence before forming the graph. Use a distinct author/refiner, an authorized decider for consequential technical choices, and independent review for nontrivial changes. Do not dispatch source work before the relevant contract, decision and prerequisite gates are met.
- Do not load, call or substitute for `thread-memory` recall. The user explicitly waived it for this swarm; verify repository evidence through the explicitly named local paths instead.
- One writer per path and one explicit owner for shared root exports/types, dispatcher and launch seams, integration fixtures, docs/examples and changelog. Serialize overlaps and hand off by artifact pointer; isolate disjoint work only if it can be integrated without history changes. Preserve all pre-existing dirty edits. Extra worktrees are unlimited by user authorization, subject to a measured capacity check and cleanup contract; no worker creates one without an assigned slot and owner. Pre-existing trees are not available by default. Isolate ports, socket paths, config/data and test stores per owner or serialize.
- Lead owns Overview/Goal, permission, launches, plan-doc revisions and acceptance. Milestone scribe owns Status and rendering when assigned; use official task/map tooling. Once dispatched, contracts get append-only revisions. Workers edit only assigned paths via host file-edit tools; no shell file writers. Report collisions instead of overwriting.

## Authority and safety

- Commits, pushes and dependency installs after an actual missing-dependency failure are authorized on the current branch. No version bump, tag, release, deploy, external services, privileged changes, CI or host smoke tests. Do not install speculatively. Stop an affected branch when it needs ungranted permissions or a user-owned decision. Use isolated local fakes and fixtures; disclose untranslated external acceptance gaps.
- Sanitize every artifact, including temporary files, maps and bus. No secrets, sensitive personal data, confidential source bodies or raw transcripts. Use generic descriptions or `[REDACTED]`. Log intent and results, not private reasoning. Do not enable a watcher that would persist unsanitized output; report attribution or sanitization limitations to the lead rather than bypassing them.
- Bus: [thread bus.db](../../bus.db), official `scripts/bus.mjs` only. Log intent and obey mail before the next step. Write the artifact first, then send a pointer. Report unexpected blockers, ownership conflicts or evidence risks promptly to `lead` (or the contract's `coord` route); if unavailable, return a blocker. If a swarm script fails, report command, exit code and sanitized error; never substitute, hand-render the generated blocks or skip the gate.

## Scope and sequencing

Settled v9 behavior is firm; draft examples are not API commitments. Accept the shared invocation, source/guard and startup/mount contracts before dependent wiring; accept the MCP caller/transport seam before dependent OAuth or task dispatch. Set graph edges from real prerequisites and write conflicts, not list order. Do not hold independent work behind unrelated uncertainties. Verify native and mirrored paths before handing off integration docs, templates and public examples that depend on them.

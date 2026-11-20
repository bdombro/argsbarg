# State — Concurrent calls and background tasks

The existing Argsbarg thread now has a separate v9 implementation plan. B0 is a bootstrap handoff; the lead accepts it, merges independent evidence and owns dispatch.

## Completed plans

- [v9 implementation](plans/v9-implementation/map.md): completed and released as
  `argsbarg@9.0.0` from commit `89fdf1d`, tag `v9.0.0`.

## Runtime setup

- Workspace: [workspace.md](workspace.md); analysis root, cwd and repository root are the Argsbarg workspace (`.`).
- Mode: Full under the user's pragmatic workflow authorization (2026-11-19 UTC); shared contracts and open API decisions warrant independent refinement.
- Model chain:
  - coordinator/scribe/helper/brief-author/executor/refiner/reviewer `mai-code-2` medium
  - decider `mai-code-2` high
  - lead = current chat configuration (host cannot switch it mid-session)
  - User selected this delegated-role chain (2026-11-19 UTC); launch verification is pending.
- Bus: [bus.db](bus.db); use `scripts/bus.mjs` only. B0 sender: `brief-bootstrap`; handoff recipient: `lead`. Lead owns its listener and verified launch attribution. B0 starts no listeners or watchers.
- Helpers: lead assigns independent plan-doc refinement, a Full-mode coordinator when parallel work is active, and short milestone scribes. No ownership transfers are implied by this draft.
- Workspace trees: unlimited by user authorization (2026-11-19 UTC), subject to measured capacity and cleanup contracts, and not a parallelism target. B0 made none; an existing detached checkout was observed and is not authorized for reuse. Lead counts live trees, checks capacity when assigning one and gives each tree an owner and cleanup contract.
- Estimate: B0, 6 minutes; checkpoint at the six Markdown files and bus. Use B0 bus timestamps for observed activity; no phase-wide estimate or task launches recorded here.
- Instruction loading: host provenance identified repository `AGENTS.md` in this context only; global directives were visible here, but inheritance in later workers is unverified. B0 explicitly read role/host guidance, scoped swarm reference and templates, repo `AGENTS.md` and `README.md`, relevant `docs/` sections and the seed. Repeat the provenance check if the host/context changes. The user explicitly waived and prohibited `thread-memory` recall for this swarm (2026-11-19 UTC); workers must not load, call or substitute for it.

## Authorizations

The user authorized the following workflow (2026-11-19 UTC):

- Branch: use the current branch for swarm work.
- Commit and push: authorized. Tag, version bump, publish, release or deploy: initially no;
  the user later explicitly requested the v9 release, which completed at task 106.
- Installs: authorized after an actual missing-dependency failure; do not install speculatively. No privileged changes or outside services.
- CI and host smoke tests: no. Local, target-specific validation only under explicit task contracts. Live harness/issuer evidence required by the design remains unverified, not waived or a reason to run out-of-scope checks.
- Source work: B0 has none. Lead may assign in-scope local edits after applicable decision, instruction and refinement gates. No scope or permission expansion without authorization.

## Boundaries

B0 owns this state, the workspace brief, the new bus and the four new plan docs only. Preserve the seed, sibling plans and the lead's existing dirty files (including docs, examples, the justfiles, changelog and thread index). No cleanup, checkout, restore or bulk formatter may overwrite them. Serialize shared-file writes; use explicit handoffs and do not assume a worktree contains uncommitted inputs.

## Decisions

- Firmness: settled seed decisions bind v9; open technical choices remain open. Disposition: keep the seed unchanged as design reference (user, 2026-11-19 UTC). [Architecture](plans/v9-implementation/architecture.md) and [conventions](plans/v9-implementation/conventions.md) absorb the worker-facing contract.

## Closeout

- Final validation task 105 passed: 346/346 core tests, 32/32 template tests, all four
  `create --check` runs, build, package audit and public-symbol parity.
- Release task 106 completed at 2026-11-20 with commit `89fdf1d`, tag and GitHub release
  `v9.0.0`, and npm `argsbarg@9.0.0`.
- Tasks 39 and 78 remain `dropped` as superseded historical work. No task remains active.
- Remaining `.agents/` worktree changes are intentionally outside the release commit.

## B0 checkpoint

- Ready for lead review; the six Markdown files and bus were newly created with no collisions. Compared read-only Git status before and after: all pre-existing dirty paths remained, and only the B0 artifacts appeared. No source edits or worktree creation.
- `node <skill>/scripts/bus.mjs --db <thread>/bus.db log B0 brief-bootstrap …` initialized the bus and recorded timestamped intent. Both `node <skill>/scripts/render-map.mjs <map.md>` and its `--check` variant exited 0 with no problems. A read-only local check found all 31 relative link targets. No task/launch gate, build, product suite or host smoke test was run.

## Historical open items at closeout

- Model, evidence, refinement and launch issues were resolved during execution and are retained
  in accepted task evidence; no closeout action remains.
- Technical choices and blocked external verification: see [architecture](plans/v9-implementation/architecture.md) and [conventions](plans/v9-implementation/conventions.md).

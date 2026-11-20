# Threads

Progress: ⬜ not started · 🔄 active · ⏸️ paused · ✅ done · 🚫 abandoned

## ✅ 2026.11.17 19.38 - Concurrent calls and background tasks

Argsbarg v9 implementation completed and released as `9.0.0` from commit `89fdf1d`.
The plan replaced 8.x adapter coupling with native CLI, REST, JSON-RPC, and MCP
declarations, local mirrors, guarded invocation, and build-time child composition.

- [Implementation map](./2026.11.17%2019.38%20-%20Concurrent%20calls%20and%20background%20tasks/plans/v9-implementation/map.md)
- [Thread state and release evidence](./2026.11.17%2019.38%20-%20Concurrent%20calls%20and%20background%20tasks/state.md)
- [Durable memory](./2026.11.17%2019.38%20-%20Concurrent%20calls%20and%20background%20tasks/memory.md)
- [Workspace brief](./2026.11.17%2019.38%20-%20Concurrent%20calls%20and%20background%20tasks/workspace.md)

Disposition: v9 is implemented and released. Task 39 was superseded by 39.1; task
78 was superseded by narrower public reviews. The documents below remain historical
design evidence rather than active plans.

### Historical design record

- [Experiment and initial plan](./2026.11.17%2019.38%20-%20Concurrent%20calls%20and%20background%20tasks/plans/2026.11.17%20-%20Concurrent%20calls%20and%20background%20tasks.md)
- [Next-major design decisions](./2026.11.17%2019.38%20-%20Concurrent%20calls%20and%20background%20tasks/plans/2026.11.18%20-%20Argsbarg%20next%20major%20design%20decisions.md)
- [Next-major app preview](./2026.11.17%2019.38%20-%20Concurrent%20calls%20and%20background%20tasks/plans/2026.11.18%20-%20Argsbarg%20next%20major%20app%20preview.md)
- [8.x gateway bundles vs child mounts](./2026.11.17%2019.38%20-%20Concurrent%20calls%20and%20background%20tasks/plans/2026.11.19%20-%20Gateway%20bundles%20vs%20child%20mounts.md)
- [Guard composition and caller handoff](./2026.11.17%2019.38%20-%20Concurrent%20calls%20and%20background%20tasks/plans/2026.11.19%20-%20Guard%20composition%20and%20caller%20handoff.md)

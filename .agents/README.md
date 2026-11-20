# Agent workspace

`.agents/` contains local planning and durable execution evidence. It is not product
documentation, is not packaged, and must stay out of release commits.

Start with [threads/README.md](threads/README.md) for active and completed thread
outcomes. Open a thread's `state.md` only after its status and objective match the task.

## Layout

- `threads/<date HH.MM - title>/state.md`: resume state, authorizations, disposition
- `threads/<date HH.MM - title>/memory.md`: dense durable facts and decisions
- `threads/<date HH.MM - title>/workspace.md`: workspace and checkout facts
- `threads/<date HH.MM - title>/plans/<plan>/map.md`: current plan status surface
- `plans/<plan>/`: local planning documents that have not been assigned to a thread

## Maintenance

- Keep thread and plan status current with the same terminal state: done, paused,
  abandoned, or superseded.
- Link the map, state, memory, workspace, and historical decision docs from the
  thread index; do not make future agents infer the thread's outcome.
- Record superseded or skipped work with its replacement pointer instead of deleting
  the history.
- Store only sanitized facts. Never put secrets, credentials, private transcripts,
  or confidential source content in `.agents/`.

# Durable work (design note)

**Not implemented.** This is a proposed design, not a shipped MCP Tasks API. Argsbarg does not provide task callbacks, a queue, worker, scheduler, retry engine, or store.

If task support is implemented later, the app would supply caller-aware provider callbacks and own:

- job execution and storage,
- status/result lookup,
- pending input,
- cancellation policy,
- terminal cleanup,
- caller and upstream authorization.

A dropped request connection currently aborts only that invocation. A future Tasks integration would need follow-ups to establish the caller again and recheck ownership and grants.

Administration would remain explicit REST, RPC, or CLI declarations. Do not rely on this note as protocol support or auto-promote an inline call into a task.

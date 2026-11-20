# Durable MCP work

Argsbarg supports the MCP `2026-07-28` Tasks extension without providing a queue,
worker, scheduler, retry engine, or store. Configure `mcp.tasks` with app-owned
`get`, `update`, and `cancel` callbacks.

The app owns:

- job execution and storage,
- status/result lookup,
- pending input,
- cancellation policy,
- terminal cleanup,
- caller and upstream authorization.

MCP tool handlers receive `ctx.mcp.tasks`. Check `available` before creating work,
then return `ctx.mcp.tasks.reference(task)` with the app-created snapshot:

```typescript
const exportReport = tool<{ caller: Caller }>()({
  name: "export_report",
  inputSchema: ExportInput,
  async handler({ inputs, locals, mcp, signal }) {
    if (!mcp.tasks.available) return exportInline(inputs, locals.caller, signal);
    const task = await jobs.enqueue(inputs, locals.caller);
    return mcp.tasks.reference(task);
  },
});

const app = argsbarg({
  mcp: {
    tools: [exportReport],
    tasks: {
      get: ({ taskId, locals, signal }) => jobs.get(taskId, locals.caller, signal),
      update: ({ taskId, inputResponses, locals, signal }) =>
        jobs.update(taskId, inputResponses, locals.caller, signal),
      cancel: ({ taskId, locals, signal }) => jobs.cancel(taskId, locals.caller, signal),
    },
  },
});
```

Argsbarg negotiates `io.modelcontextprotocol/tasks`, encodes `resultType: "task"`,
routes `tasks/get`, `tasks/update`, and `tasks/cancel`, validates protocol state, and
re-establishes the MCP caller for every follow-up. A dropped request connection still
aborts only that invocation; provider-owned work and storage decide what continues.
Completed tasks carry the original MCP `tools/call` result, including
`resultType: "complete"`, `content`, and optional `structuredContent`/`isError`.

For keyed child apps, provider ownership is part of task identity. The public id is
`${mountPath.join("__")}__${localTaskId}` and follow-ups always return to that exact
child. A child with no provider remains inline; it does not fall back to a parent or
sibling provider.

The provider must make a task durable enough for its own contract before returning the
reference. Cancellation is cooperative. Administration remains explicit app-owned REST,
RPC, or CLI declarations; Argsbarg never auto-promotes an inline call into a task.

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

Commit the task before returning a reference so the first authorized `tasks/get`
can find it. Use unguessable IDs and authenticate and authorize each follow-up;
knowing the task ID alone does not authorize access. Keep mount paths stable for
live handles. The in-memory examples demonstrate wiring, not durable storage.

Validate the completed result against the originating tool's output schema before
storing it. Argsbarg checks the wire result at readback, not the original app schema.
A tool result with `isError: true` is still `completed`; use `failed` only for
the original operation's JSON-RPC error.
In `update`, match each response to a currently outstanding, lifetime-unique key
in the same authorized mutation. `isMcpTaskInputResponse(response, request)` checks
the response variant; also validate submitted values against the stored request
schema. Ignore stale keys and don't reopen terminal tasks.

Cancellation is cooperative. Administration remains explicit app-owned REST, RPC,
or CLI declarations; Argsbarg never auto-promotes an inline call into a task.

## Push committed status changes

Set `mcp.tasks.watch` if the app can observe committed status changes. Polling
still works for providers without it. For example, with an app-owned job store:

```typescript
watch: async ({ taskId, locals, signal }) => {
  await jobs.requireAccess(taskId, locals.caller, signal); // Before returning.
  return jobs.followCommittedSnapshots(taskId, locals.caller, signal);
},
```

Authorize before returning the async iterable, not in the body of a lazy async
generator. Throw `McpTaskNotFoundError` for a missing or inaccessible task.
Yield full committed snapshots with the provider-local ID, just as `get` would
return. Stop pending reads and release app resources on `signal` abort; never
cancel the job when a watcher ends. A slow consumer needn't see every working
snapshot; the provider can coalesce to the latest state instead of buffering a
history. Keep the final result available to `get`.

The [API example](../../examples/api/src/app.ts) shows this with an in-memory
store. See the [MCP wire guide](../mcp.md#tasks) for subscribing and reconnecting.

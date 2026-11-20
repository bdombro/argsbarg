# MCP

Argsbarg implements the fixed MCP `2026-07-28` surface. Register tools explicitly with `tool()` and one immutable startup registry:

```typescript
import { tool } from "argsbarg";
import { z } from "zod";

const greet = tool()({
  name: "greet",
  description: "Greet someone.",
  inputSchema: z.strictObject({ name: z.string() }),
  outputSchema: z.strictObject({ message: z.string() }),
  handler: ({ inputs }) => ({ message: `hello ${inputs.name}` }),
});
```

Add tools to `mcp.tools`. Discovery and dispatch use that same registry. `server/discover` and `tools/list` expose the deterministic catalog; `tools/call` invokes a registered declaration.

## Guards and caller seeds

`mcp.guard` is the MCP surface policy. A tool `guard` supplements it:

```typescript
const protectedMcp = {
  guard: requireMcpCaller,
  http: {
    middleware: async (request, { method, name, headers }) => {
      const caller = await verifyBearer(headers.get("Authorization"));
      return caller
        ? { kind: "next", locals: { caller } }
        : {
            kind: "respond",
            response: new Response(null, { status: 401 }),
          };
    },
  },
  tools: [
    tool<{ caller: Caller }>()({
      name: "generate_report",
      guard: requireReportScope,
      inputSchema: z.strictObject({ report: z.string() }),
      handler: ({ inputs, locals }) => generateReport(inputs, locals.caller),
    }),
  ],
} satisfies McpAppConfig<{ caller: Caller }>;
```

`tool.guard: { mode: "override", run }` replaces only `mcp.guard`; `tool.guard: "public"` removes only that default. Neither bypasses HTTP middleware. Guards do not run for `server/discover` or `tools/list`; configured HTTP middleware does run for those `/mcp` requests as mount policy.

`mcp.http.middleware` is the one transport admission callback. Before consuming the body, it receives the native `Request`, `Mcp-Method`, optional `Mcp-Name`, and a case-insensitive header-only `NameView`. Return `{ kind: "respond", response }` to finish the HTTP request, or `{ kind: "next", locals }` to seed fresh request-local verified locals. Other return values are treated as internal server errors. The middleware object is not passed to guards or handlers, and app middleware cannot replace framework progress behavior.

The HTTP adapter merges framework locals with middleware locals, keeps the exact linked request signal, and passes the seed into normal guarded dispatch. Middleware may establish a verified caller, but `mcp.guard` still decides whether it is sufficient. A guard denial with HTTP status/header or bearer-challenge metadata completes before progress SSE starts and is returned as an HTTP denial; other denials remain native MCP tool errors.

There are deliberately no stdio or local seed callbacks:

- stdio constructs fresh framework locals and exposes only process-local `env`;
- local `mcp call` does the same;
- `mcp.guard` or a tool guard must verify local credentials and add the caller;
- protected declarations cannot synthesize a caller from the other transport or make it an optional handler precondition.

The MCP guard/tool plan runs identically for HTTP `tools/call`, stdio, and local `mcp call`. Relays perform no local plan; the destination server performs its own middleware, guards, and denial encoding. A relay never falls back locally.

## Launch

```bash
myapp serve mcp --stdio
```

For Streamable HTTP, configure the MCP surface and run it on the shared listener:

```bash
myapp serve mcp
```

HTTP MCP is exactly `/mcp` and requires `Mcp-Method`; `tools/call` also requires `Mcp-Name`. Stdio writes protocol data only to stdout. One process selects one MCP transport.

Client configuration:

```json
{ "command": "myapp", "args": ["serve", "mcp", "--stdio"] }
```

## Results

Tool declarations return ordinary values or errors through `AppError`. Discovery schemas come from Zod. The optional `resultType`, cache metadata, progress notifications, and request cancellation follow the selected protocol.

Concurrent calls overlap by default in the shared dispatcher. Caller, locals, captured output, progress, and cancellation stay request-local. `process.chdir` is forbidden during overlapping MCP work.

## Tasks

Configure `mcp.tasks` to support the MCP `2026-07-28` Tasks extension without giving
Argsbarg a queue, worker, store, or scheduler:

```typescript
const mcp = {
  tools: [exportReport],
  tasks: {
    get: ({ taskId, locals, signal }) =>
      jobs.get(taskId, locals.caller, signal),
    update: ({ taskId, inputResponses, locals, signal }) =>
      jobs.update(taskId, inputResponses, locals.caller, signal),
    cancel: ({ taskId, locals, signal }) =>
      jobs.cancel(taskId, locals.caller, signal),
  },
};
```

An MCP tool handler receives `ctx.mcp.tasks`:

```typescript
handler: async ({ inputs, locals, signal, mcp }) => {
  if (!mcp.tasks.available) return exportInline(inputs, locals.caller, signal);
  const task = await jobs.enqueue(inputs, locals.caller);
  return mcp.tasks.reference(task);
};
```

`available` is true only when the app registered a provider and the current client
declared `io.modelcontextprotocol/tasks`. `reference` validates the app-owned snapshot
and emits `resultType: "task"`. Argsbarg routes `tasks/get`, `tasks/update`, and
`tasks/cancel`, applies the MCP surface guard and app hooks to every follow-up, and
passes fresh request-local `locals` and `signal` to the provider. The provider owns
ownership checks, state, pending input, results, cancellation, persistence, and expiry.

Mounted child apps keep their own Tasks provider. A child task reference is public as
`${mountPath.join("__")}__${localTaskId}`; follow-ups strip that exact prefix before
calling the child provider and run the child's guard, hooks, error reporter, and
scoped credential view. A child without `mcp.tasks` gets `available: false`; Argsbarg
never probes the parent or another child. Parent task IDs stay unprefixed, so each
app-owned provider remains an explicit namespace rather than a fallback chain. App-owned
local IDs that collide with a mounted descendant prefix are rejected by `reference`
instead of becoming ambiguously routeable.

Task snapshots are `working`, `input_required`, `completed`, `failed`, or `cancelled`.
They require `taskId`, `createdAt`, `lastUpdatedAt`, and `ttlMs`; completed tasks add a
`result`, failed tasks add a JSON-RPC `error`, and input-required tasks add
`inputRequests`. `update` and `cancel` acknowledge with an empty complete result.
See [Durable MCP work](use-cases/tasks.md) for the ownership and storage split.

## Local mirror and relay

```bash
printf '%s\n' '{"name":"Ada"}' | myapp mcp call greet
printf '%s\n' '{"name":"Ada"}' | myapp mcp call greet --relay https://service.example/mcp
```

The relay performs exactly one `tools/call` request with protocol metadata and framework-owned routing headers. It never discovers tools, forwards ambient credentials, or falls back locally.

## Packaging

`mcp bundle` packages the same executable, with stdio launch arguments `serve mcp --stdio`. Bundle, Claude plugin, and Cursor plugin manifests therefore use the same runtime path.

OAuth and external issuers are not supplied by this middleware API. Apps own token verification, metadata, challenge policy, sign-in flows, and upstream authorization; those integrations remain unverified by local fixtures. Real host compatibility is also unverified; the [harness notes](mcp/harness/README.md) are configuration guidance, not guarantees.

# Build-time keyed child apps

Use `children` to copy standalone app declarations into one parent-owned executable. Composition happens while `argsbarg(...)` builds its immutable catalogs. The parent owns transports; it never calls a child's `run()`, opens a child listener, or merges running stores and processes.

```typescript
const app = argsbarg({
  ...suiteMetadata,
  children: {
    billing: { app: billingApp },
    reports: { app: reportsApp, expose: ["cli", "mcp"] },
  },
});
```

## Descriptor and exposure

Each entry has `{ app, expose? }`; there is no direct-app shorthand, path form, alias, or prefix override. `ChildSurface` is `"cli" | "http" | "jsonRpc" | "mcp"`.

Keys match `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`. They are exact and case-sensitive; leading/trailing separators, underscores, dots, uppercase letters, and doubled separators are invalid. The same validation applies to JavaScript calls at runtime.

Omitted `expose` means every configured surface in the child's composed snapshot, including valid descendants. Present `expose` means exactly that non-empty, duplicate-free subset. It is an error to request an unconfigured child surface. Nested exposure is an intersection and a parent cannot broaden a child exclusion. Exposure does not filter individual operations or vary by caller. Existing hidden declarations remain hidden but callable, and disabled CLI subtrees remain unregistered.

## Public names

The mount key path, not the child app's root `key`, is the namespace:

| Surface | Composed public identity |
| --- | --- |
| CLI | mount-key path followed by the child's authored command path |
| REST | path `/${keys.join("/")}${path === "/" ? "" : path}` and id `${keys.join("__")}__${id}` |
| JSON-RPC | `${keys.join(".")}.${name}` |
| MCP | `${keys.join("__")}__${name}` |

`billing` mounting route `/invoices` with id `listInvoices` creates `POST /api/billing/invoices` and operation id `billing__listInvoices`. It creates RPC method `billing.reports.get` from `reports.get`, and MCP tool `billing__list_invoices` from `list_invoices`. Nesting `billing` under `operations` produces MCP tool `operations__billing__retry`.

A runnable child root becomes the final mount-key CLI leaf. A grouped root becomes that group and preserves its description, options, group metadata, and paths. Registration is flat after composition; adapters do not retain child routers at request time. Parent `api`, `rpc`, and `mcp call` mirrors target composed catalogs, so they create no second child-specific mirror.

## Scoped credentials

For mount path `billing/reports`:

- environment prefix: `BILLING_REPORTS_`
- header prefix: `billing-reports-`

`ctx.env.get("TOKEN")` reads exactly `BILLING_REPORTS_TOKEN`; `ctx.headers.get("Authorization")` reads exactly `billing-reports-Authorization`. Header lookup remains case-insensitive. The wrapper does not enumerate or copy the backing source.

There is no unprefixed, sibling, HTTP-to-env, or env-to-header fallback. An ancestor's view hides reserved descendant prefixes. Startup rejects overlapping sibling prefixes, such as `billing` and `billing-reports`, regardless of exposed surfaces. Parent/child nesting is valid because descendants are explicitly hidden from their ancestors.

Parent transport admission may seed verified `locals`; a child cannot use that fact to read the suite's raw bearer header. A child conventionally reads `Billing-Authorization` or `BILLING_TOKEN`, or consumes verified mount locals in an app-owned guard. Direct `process.env` reads outside invocation context remain outside prefix scoping.

## Guards, hooks, and callers

Mounted declarations retain their compiled guards and hooks. One child invocation runs:

1. parent transport/mount admission, when configured;
2. the child's own surface guard;
3. the child's operation supplement, override, or public selection;
4. the child's handler.

The parent's surface guard and invocation hooks do not apply. If parent policy must cover every declaration, put it at the transport/mount layer or include it in child policy. There is no child-mount `guard` field.

Mount-seeded values flow into child guards; guard `allow(...)` additions reach the handler. Locals, source views, signals, callers, output capture, guard results, and denials are fresh per invocation and never leak. Child hooks and error reporters run once. Parent middleware and hooks observe only the parent-owned wire transport.

Mounted child apps keep their own `mcp.tasks` provider. A child local task id such as
`job-7` is returned to MCP clients as `${mountPath.join("__")}__job-7`. Every task
follow-up uses that exact namespace to select the child provider, strips the namespace
before calling app-owned `get`, `update`, or `cancel`, and reapplies the child's MCP
guard, hooks, error reporter, source prefixes, and fresh request locals.

A child with no Tasks provider gets `mcp.tasks.available === false`, even when the
parent has one. There is no parent-then-child fallback or provider probing: one public
task id has one deterministic owner. Parent-owned task ids remain unprefixed.

## Startup collisions

`argsbarg(...)` validates the complete snapshot before returning. It rejects:

- invalid mount keys;
- duplicate or overlapping sibling source prefixes;
- duplicate final CLI paths, including parent, built-in, and generated mirror paths;
- duplicate REST operation ids or overlapping method/path claims;
- duplicate JSON-RPC method or MCP tool names;
- duplicate, unsupported, or unconfigured `expose` entries;
- composed RPC/MCP names rejected by their existing profiles.

Hidden declarations still claim dispatch identity. Equal child-local names are valid when mount paths make the final identities unique. A collision names the surface, final public identity, and both owner paths; insertion order never drops, renames, or shadows an entry.

## Ownership and lifecycle

The parent contributes child routes to `/api`, methods to `/rpc`, tools and Tasks providers to `/mcp`, and commands to one CLI tree. The parent owns the listener, service and MCP transport selection, identity, instructions, OAuth admission, discovery, readiness, and shutdown. Child listener settings, host/port, instructions, OAuth configuration, packaging, and lifecycle callbacks are not merged.

There is no dynamic import, startup path loader, global registry, runtime bundle loader, gateway fallback, or separate-process orchestration. Resources captured by child handlers remain owned and closed by the executable that created them.

Keyed composition is same-process declaration composition, not process isolation or protocol federation. Use separate executables and explicit upstream operations when packages need those boundaries; for curated external APIs, see [gateways](gateway.md).

# Author a v9 app

Declare each callable surface independently. CLI declarations, REST routes, JSON-RPC methods, and MCP tools may share schemas and domain functions, but one surface is never inferred from another.

## CLI

Wrap every CLI leaf with `command()`:

```typescript
import { argsbarg, command, OptionKind } from "argsbarg";

const app = argsbarg({
  commands: [
    command({
      key: "echo",
      description: "Echo text.",
      options: [{ name: "loud", description: "Uppercase output.", kind: OptionKind.Presence }],
      positionals: [{ name: "text", description: "Text to echo.", kind: OptionKind.String }],
      handler: ({ inputs }) => inputs.loud ? String(inputs.text).toUpperCase() : String(inputs.text),
    }),
  ],
  description: "Example CLI.",
  key: "example",
  version: "1.0.0",
});
```

`ctx.inputs` is the parsed, flat value object. Options and positionals are coerced before one Zod parse. Path captures also merge into `ctx.inputs`. Do not depend on raw `args`, `opts`, `invocation`, `pathParams`, or response helpers.

A handler sees:

- `inputs` — parsed Zod output or inferred option/positional values.
- `locals` — fresh per-call state, optionally extended by guards.
- `surface` — `cli`, `http`, `jsonRpc`, or `mcp`.
- `signal` — the exact cooperative cancellation signal.
- `source: "local"` with `env`, or `source: "http"` with `headers`.

Return a string, JSON value, or `undefined`. CLI text or JSON is encoded after the handler settles. `app.run()` sets `process.exitCode`, flushes stdio, and resolves so app cleanup runs.

## Schemas

Use `inputSchema` for one parsed document or the combined CLI input shape. Use `outputSchema` for typed discovery and return inference. See [schemas.md](schemas.md).

## Guards

Guards run after validation and before side effects:

```typescript
import { allow, deny } from "argsbarg";

const authenticated = (ctx) =>
  ctx.source === "local" && ctx.env.get("TOKEN")
    ? allow({ caller: "local" })
    : deny({ code: "AUTH_REQUIRED", message: "A token is required." });
```

Every user-authored CLI leaf runs `cli.guard` followed by its command guard supplement:

```typescript
const app = argsbarg({
  cli: { guard: requireLocalCaller },
  commands: [
    command({
      key: "report",
      guard: requireReportScope,
      handler: ({ inputs, locals }) => renderReport(inputs, locals.caller),
    }),
  ],
  // ...
});
```

`command.guard: { mode: "override", run }` replaces only `cli.guard`; `command.guard: "public"` removes only that default. Neither changes another transport's admission. REST, JSON-RPC, and MCP declarations use the same operation-guard shape with their own surface defaults.

The one-call `command(spec)` form uses the app's module-augmented `Locals`. Use the extracted `command<Seed>()(spec)` form when a command needs narrower explicit seed additions.

Guards can return `false`, a structured denial, or `allow({ ...locals })`. The CLI source is always `local`; HTTP callers are never available as an environment/header fallback. Generated `api`, `rpc`, and `mcp call` leaves invoke their target declaration and run its surface/operation plan. They do not run `cli.guard`, have their own operation guard, or fall back from a failed relay to a local declaration.

## Hooks

`beforeInvoke` runs after native binding and before the sole Zod parse. It may mutate only `ctx.locals` and must not reinterpret transport data. `afterInvoke`, `formatError`, and `onError` observe the resulting invocation.

## Launch

```bash
myapp --help
myapp serve                  # every configured HTTP mount
myapp serve http             # REST mount only
myapp serve http rpc         # selected HTTP mounts
myapp serve mcp --stdio      # one selected MCP stdio process
```

Bare `serve` starts all configured REST, RPC, and MCP HTTP mounts on the shared listener. Names select only the corresponding mounts; `serve http`, for example, starts REST without RPC or MCP HTTP. MCP stdio opens no listener. A combined stdio launch is rejected before I/O.

Use [`server.listeners`](http-server.md#listener-settings) for TCP, Unix sockets, or both.

## Local mirrors and relays

Generated calls are available only for configured surfaces:

```bash
printf '%s\n' '{"name":"Ada"}' | myapp api POST /api/greet
printf '%s\n' '{"name":"Ada"}' | myapp rpc greet
printf '%s\n' '{"name":"Ada"}' | myapp mcp call greet
```

Add repeatable `--header name:value` with `--relay <url>` for one explicit remote call. Relay URLs are HTTP(S), never forwarded from ambient headers or environment, and never retried or fallen back to a local declaration.

Add `--yaml` to `api`, `rpc`, or `mcp call` to read YAML from stdin and present structured results as YAML. JSON is the default. REST relays send and request YAML with this flag; JSON-RPC and MCP relay requests still use their normal protocol formats. Native REST response bodies pass through unchanged.

## Keyed child apps

Mount standalone apps as immutable build-time snapshots:

```typescript
const suite = argsbarg({
  ...suiteMetadata,
  children: {
    billing: { app: billingApp },
    reports: { app: reportsApp, expose: ["cli", "mcp"] },
  },
});
```

Keys must match `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$` and are exact, case-sensitive namespaces. `expose` is a non-empty, duplicate-free subset of surfaces configured by the child snapshot; omission exposes every configured child surface. Exposure intersects through nested mounts and never broadens a child's exclusions.

For `billing` mounting a child:

| Child surface | Composed public name |
| --- | --- |
| CLI | `billing <authored path>` |
| REST `/invoices` with id `listInvoices` | `/api/billing/invoices`, `billing__listInvoices` |
| JSON-RPC `reports.get` | `billing.reports.get` |
| MCP `list_invoices` | `billing__list_invoices` |

Nested mount paths prefix every name. The child app's own `key` is not publicized. Parent-generated mirror commands target these composed catalogs without another child-specific mirror.

Child `ctx.env.get("TOKEN")` reads only `BILLING_TOKEN`; child `ctx.headers.get("Authorization")` reads only `Billing-Authorization`. Nested keys use `BILLING_REPORTS_` and `billing-reports-`. Lookup is prefix-only, case-insensitive for headers, never falls back to unprefixed or sibling values, and hides descendant prefixes from an ancestor child. Code that reads `process.env` directly remains outside this invocation boundary.

Parent transport admission can seed fresh `locals`, then the child's own surface and operation guards run. Child hooks and error reporters remain attached and run once. The parent surface guard and hooks do not apply to child declarations. Only the parent starts transports and owns discovery, readiness, shutdown, and listener configuration. The child `run()` and serve methods are never called, and child listeners, OAuth, packaging, lifecycle, stores, Tasks, and resources are not merged.

Startup rejects invalid or unsupported exposure, invalid keys, colliding public identities, overlapping sibling credential prefixes, and exposed surfaces the child does not configure. Disabled CLI subtrees remain unregistered; hidden callable declarations still reserve their dispatch identity and can collide. See [keyed child apps](use-cases/child-apps.md) for the full contract.

## Configuration directory

`resolveConfigDir(appKey, override?)` resolves an explicit absolute override or a native per-user directory and creates it only when called. Apps own config-file formats, storage, and startup policy.

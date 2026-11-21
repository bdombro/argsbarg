# Design decisions

## One factory, independent surfaces

`argsbarg(spec)` owns the process and public package. CLI commands, REST routes, JSON-RPC methods, and MCP tools are optional and independently declared. A command does not silently become every wire operation.

## One guarded invocation model

Native binders produce raw values. `invokeBound` performs one Zod parse, ordered guard evaluation, one handler call, and terminal output capture. Adapters encode native values and errors.

Handlers receive one `InvocationContext`. Local calls expose only environment by name; HTTP calls expose only request headers by name. There is no credential-source fallback.

## CLI and MCP policy

`cli.guard` and `mcp.guard` are surface defaults. A declaration's guard supplements the default; `{ mode: "override", run }` replaces only that default, and `"public"` removes only that default. Generated mirror commands invoke target declarations and do not receive synthetic CLI policy. Relay calls run policy only at the destination.

REST and MCP over HTTP share a configurable Origin check before app admission. `mcp.http.middleware` is the `/mcp` app admission and caller-seed hook. It receives the routing headers and a header-only source before body decode and returns an explicit `{ kind: "respond", response }` or `{ kind: "next", locals }`. HTTP middleware locals flow into MCP surface and tool guards. Stdio and local MCP calls have fresh framework seeds and must derive callers from the exclusive local environment source. Authentication remains app-owned; there is no OAuth implementation or environment/header fallback.

MCP guards finish before progress SSE starts. Denials carrying HTTP/challenge metadata become native HTTP denials; other denials remain MCP tool errors. Discovery/catalog reads do not invoke guards, although configured HTTP middleware still governs the mount.

## Native outcomes

REST handlers may return `Response`, including streams. JSON-RPC and MCP retain their native protocol envelopes. A neutral wire response is not imposed on every surface.

## Fixed discovery catalogs

Discovery and dispatch share immutable startup catalogs. REST uses `/api`, JSON-RPC uses `/rpc`, and MCP uses `/mcp`. There are no generated cross-protocol endpoints.

## Selected service transport

One shared listener owns HTTP mounts across the configured TCP and Unix socket endpoints. `serve mcp --stdio` uses MCP stdio and opens no listener. Combined MCP transport launches fail before bind.

## Build-time keyed child composition

`children` snapshots standalone app declarations by exact mount key while the parent app is constructed. Composed CLI, REST, JSON-RPC, and MCP catalogs have deterministic names; each child receives prefix-only environment or header views. Exposure intersects through nested mounts. Collisions and overlapping sibling source prefixes fail at startup.

Child guards, operation policy, hooks, and error reporters remain attached. Parent transport admission can seed fresh locals, but parent surface defaults and hooks do not apply to child declarations. Only the parent owns listener, transport, discovery, readiness, and shutdown. Child `run()`/serve methods, lifecycles, OAuth, Tasks, stores, listeners, and packaging are never merged.

Children are same-process declarations, not runtime imports, gateways, federated upstreams, or process-isolation boundaries.

## No compatibility line

The major removes `CommandContext`, `ctx.respond`, raw argv converters, auto-derived HTTP/MCP command tools, the runtime gateway, old server loops, and legacy protocol negotiation. There are no aliases, shims, or migration tooling.

## Packaging

One package and one app executable carry every enabled surface. Plugin and bundle manifests launch that executable in selected stdio mode. Zod remains the only peer dependency. The runtime keeps `yaml` for REST and CLI document support; it does not claim zero production dependencies.

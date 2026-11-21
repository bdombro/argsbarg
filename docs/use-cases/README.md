# Use cases

Argsbarg owns declarations, validation, guarded invocation, discovery, encoding, and local serving. Apps own business policy, storage, credentials, durable work, and upstream clients.

| Goal | Argsbarg role | App role |
| --- | --- | --- |
| Small typed CLI | `command()` and completions | Handler and cleanup |
| REST service | Explicit `route()` catalog | Data access and responses |
| JSON-RPC | Explicit `method()` catalog | Method behavior |
| MCP | Explicit `tool()` registry | Tool behavior and auth |
| Auth | Guards and structured denial | Token verification and policy |
| Settings | `resolveConfigDir()` | File format, load, and storage |
| Durable jobs | MCP Tasks polling and optional status push through `mcp.tasks` | Queue, provider, ownership, state |
| Multiple apps | Build-time keyed child snapshots and scoped sources | Child declarations, trust, and resource ownership |
| External API gateway | Native declarations and upstream-agnostic handlers | Curated contracts and clients |

No runtime auto-discovers CLI commands as wire endpoints, imports live upstream schemas, or loads a gateway bundle. Child composition copies declarations into one parent-owned build-time snapshot; it is not runtime federation or a gateway. See [settings](settings.md), [gateways](gateway.md), [keyed child apps](child-apps.md), and [durable MCP work](tasks.md).

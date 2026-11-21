# REST server

Declare REST routes explicitly with `route()`.

```typescript
import { route } from "argsbarg";
import { z } from "zod";

const getReport = route()({
  id: "getReport",
  method: "GET",
  path: "/reports/:id",
  description: "Get a report.",
  pathParams: z.strictObject({ id: z.string() }),
  queryParams: z.strictObject({ format: z.enum(["json", "csv"]).optional() }),
  outputSchema: z.strictObject({ id: z.string() }),
  handler: ({ inputs }) => ({ id: inputs.id }),
});
```

Register routes in `http.routes`. `ctx.inputs` is one flat parsed object, but route path, query, and body keys must be disjoint. Registration rejects collisions.

## Wire

All REST operations are mounted under `/api`:

| Endpoint | Purpose |
| --- | --- |
| `/api/openapi.json` | Fixed OpenAPI 3.1 document |
| `/api/docs` | Swagger UI |
| `/api/...` | Explicit registered routes |

Launch with `myapp serve http` to start only REST. Bare `myapp serve` starts every configured REST, JSON-RPC, and MCP HTTP mount; `myapp serve http rpc` selects only the named HTTP mounts. Add `--host` or `--port` as needed.

### Listener settings

Without `server.listeners`, the shared listener keeps the existing TCP defaults
(`127.0.0.1:3000`) and honors `http.host` and `http.port`. Set `server.listeners`
to choose endpoints explicitly:

```typescript
server: {
  listeners: {
    tcp: { port: 8080 },
    socket: { path: "/var/run/myapp/http.sock" },
  },
},
```

Either key may be omitted, but at least one is required. `{ tcp: {} }` uses the
TCP defaults. Legacy `http.host` and `http.port` do not apply to an explicit set;
`--host` and `--port` override only an enabled TCP endpoint. You can also supply
a synchronous `listeners` callback to parse app-owned environment settings only
when serving HTTP. CLI commands, local mirrors, and MCP stdio do not call it.

On Unix, create the socket's parent directory yourself. Use a real directory
owned by the serving user with mode `0700`, under trusted ancestors. Argsbarg
refuses an existing socket path and does not replace it. The selected mounts are
the same at every endpoint; file permissions do not replace app guards. If any
bind fails, the listener releases earlier binds.

### Browser origins

If a request sends `Origin`, add the browser application's exact HTTP(S) origin
(scheme, host, and port if non-default; no trailing slash) to
`http.allowedOrigins`, for example `["https://app.example.com"]`. The default
rejects supplied origins with `403` and tells you which origin to configure.
Set `http.allowedOrigins: "*"` in app configuration to explicitly skip the check.
Requests without `Origin` still go through normal admission. This policy also
applies to preflight requests, and is separate from REST's CORS headers and auth.
[MCP over HTTP](mcp.md#launch) uses the same setting under `mcp.http`.

Use `Content-Type: application/yaml` to send a YAML mapping, or `Accept: application/yaml` to get YAML for ordinary results and structured errors. The headers are independent. JSON stays the default response format; native `Response` values, including downloads and streams, keep their original body and media type. OpenAPI advertises JSON and YAML, but `/api/openapi.json` itself is always JSON.

YAML input is one document with JSON-compatible values. Duplicate keys, aliases, and custom tags are rejected.

```typescript
handler: async ({ signal }) => new Response(download(signal), {
  headers: { "content-type": "application/octet-stream" },
});
```

REST source data is headers only. Process environment is never a fallback on HTTP. A disconnect aborts the request signal but does not imply durable job cancellation.

## Errors

`AppError` becomes a stable `{ error: { code, message, details? } }` response. Guard denials preserve explicit HTTP status, headers, and bearer challenge metadata. Unknown errors become a generic server response; native `Response` values remain unchanged.

## Local mirror

```bash
myapp api GET /api/reports/42
printf '%s\n' '{"name":"Ada"}' | myapp api POST /api/reports
printf '%s\n' 'name: Ada' | myapp api POST /api/reports --yaml
myapp api GET /api/reports/42 --relay https://reports.example
```

REST relay URLs are origins. The generated command adds the exact full path supplied by the caller and follows no redirects. A REST relay with `--yaml` sends and requests YAML; the remote response body still passes through unchanged.

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

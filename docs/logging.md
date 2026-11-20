# Server logging

Server and lifecycle logs go to stderr; handler stdout remains application output and MCP stdio protocol stays uncontaminated.

```typescript
const app = argsbarg({
  // …
  log: {
    format: "json",
    file: "server.log",
    access: true,
    errors: true,
    enrich: (ctx) => ({ deployment: "local" }),
  },
});
```

JSON mode emits ECS-shaped NDJSON. Set `format: "text"` for local terminal output. `file` tees the same line to disk and resolves relative to the working directory.

`enrich` adds fields. `serialize` replaces formatting and returns one complete line without a trailing newline; it takes precedence over `enrich`.

HTTP access records include safe request method, path, status, duration, trace fields, and request id. Native request bodies, headers, credentials, and locals are not logged by argsbarg.

## Error reporting

```typescript
import { createErrorReporter } from "argsbarg";

const errors = createErrorReporter({
  dsn: "https://key@example.invalid/1",
  env: "MYAPP_ERROR_DSN",
});
```

Unexpected handler failures may be sent to a Sentry-compatible endpoint. Input errors, expected denials, help, unknown routes, cancellation, and deliberate process exits are not reported. The reporter never throws and waits at most ten seconds.

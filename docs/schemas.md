# Schemas

Argsbarg accepts Zod 4 schemas and emits JSON Schema 2020-12 for REST, JSON-RPC, MCP, and help. Zod is the runtime validator and peer dependency.

## Input

Each native declaration owns one input schema:

- CLI: command options, positionals, path captures, and optional `inputSchema`.
- REST: `pathParams`, `queryParams`, and `body`, flattened into `ctx.inputs`.
- JSON-RPC: `inputSchema`, with optional tuple `paramNames`.
- MCP: `inputSchema`.

Use `z.strictObject`. Validate once, then consume `ctx.inputs`. Defaults and transforms appear in the parsed value.

```typescript
const Input = z.strictObject({
  count: z.number().int().positive().describe("Number of rows."),
});
```

REST rejects registration when the three input schemas share any key. RPC and MCP reject malformed native params before handler side effects.

## Output

`outputSchema` types and documents successful handler values. REST and RPC encoders keep their native error paths; MCP emits complete structured protocol results. A REST handler may return `Response` when a route documents native media, streams, status, or headers.

Non-object MCP roots are wrapped under `input` or `result` for protocol object-root requirements. Handlers still receive and return the authored bare value.

## Rules

- Put `.describe()` on agent-visible fields; JSON Schema cannot read JSDoc.
- JSON-friendly values only: no `Date`, `BigInt`, `Map`, or `Set`.
- Prefer finite strict objects for route source schemas.
- Refinements validate at runtime but may not have an exact JSON Schema representation.
- Emitted schemas are immutable and memoized.

See the API template for shared schemas and independently declared routes, methods, and tools.

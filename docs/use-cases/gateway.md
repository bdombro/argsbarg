# Curated gateways

A gateway declares the operations it publishes. For each REST route, RPC method, or MCP tool, write a checked-in Zod contract and an app-owned upstream adapter.

Do not reflect upstream OpenAPI, JSON Schema, MCP `tools/list`, or live catalogs. An upstream change must not silently change discovery. Narrow or rename upstream inputs as needed, and map failures into `AppError` or the native transport outcome.

Authorize each upstream separately. Never forward the inbound bearer token automatically, read credentials from an unrelated source, or fall back to another caller identity. Keep connection references scoped to verified caller and workspace. Durable work stores the acting identity and upstream grant reference, not a request-only token.

For upstream OAuth that needs user interaction, app code owns the sign-in flow and retry continuation. URL-mode elicitation is integration-specific and is not simulated by argsbarg.

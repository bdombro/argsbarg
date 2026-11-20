# Cursor

Cursor MCP configuration uses:

```json
{
  "mcpServers": {
    "myapp": {
      "command": "myapp",
      "args": ["serve", "mcp", "--stdio"]
    }
  }
}
```

Plugin manifests launch the same executable. Tool metadata size and protocol compatibility remain host-specific verification concerns.

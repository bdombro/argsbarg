---
id: argsbarg-bootstrap
name: argsbarg-bootstrap
description: Bootstraps a new Argsbarg app after clarifying the app identity, requested surfaces, and what must stay unchanged
enabled: true
---

# Bootstrap an Argsbarg app

Use this skill when the user wants to create a new Argsbarg app

## Authorization

Advice, comparison, or a scaffold preview does not authorize file edits or package installation. Treat an explicit request to create or implement the app as authorization for the required scaffold work. Keep the generated version unchanged; never release, publish, or manually bump it

## Establish intent

Before choosing a template, determine

- the app key and user-facing description
- the GitHub release repository
- the initial CLI, REST, JSON-RPC, and MCP surfaces
- the intended distribution: npm/npx, agent plugin, or Homebrew
- behavior that is explicitly required or intentionally out of scope

Ask one focused question if these choices materially affect the scaffold. If the request is already precise, proceed

Prefer the existing `argsbarg create` scaffold:

```bash
npx argsbarg@latest create <app-key>
npx argsbarg@latest create <app-key> --template api --yes
```

`create` is deterministic scaffolding, not an app-design inference engine. Do not reinterpret one requested surface as authorization to enable another

## Personalize deliberately

Inspect the generated `src/create-identity.ts`, `src/app.ts`, declarations, tests, packaging, docs, and skills before editing. Use the installed Argsbarg version's `docs/cli-program.md`, `docs/schemas.md`, `docs/http-server.md`, and `docs/mcp.md`; use the use-case guides for policy choices

Keep each surface independent:

- CLI: `command()`
- REST: `route()`
- JSON-RPC: `method()`
- MCP: `tool()`

Share schemas and domain functions, not transport bindings. Do not derive a route, method, or tool from a CLI command

Remove scaffold examples that the app does not own and replace template prose with app-specific instructions. Preserve template packaging and unrelated capabilities unless the requested scope says otherwise

## Verify

Run the generated app's focused typecheck, tests, and build. Exercise one operation on each requested surface and check the app help, README, skill, and package contents agree with the implementation. Report unverified distribution or external-host behavior plainly

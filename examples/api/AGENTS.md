# example-api

Argsbarg schema-first npm CLI: Zod `inputSchema`/`outputSchema` via `command`, REST CRUD over in-memory `node:sqlite`. Users run it with `npx example-api` or `npm install -g example-api` (`bin` → `dist/index.js`).

## Argsbarg authoring

When adding or changing commands, schemas, or MCP exposure:

1. **Read** `node_modules/argsbarg/docs/cli-program.md` first (authoritative).
2. MCP tools, varargs, `inputSchema` → `node_modules/argsbarg/docs/mcp.md`.
3. Zod schemas (`inputSchema`, `outputSchema`, JSON stdout) → `node_modules/argsbarg/docs/schemas.md`.
4. Other templates for reference: `node_modules/argsbarg/examples/` (`cli`, `api`, `agent-plugin`, `homebrew`).

**Rules** (details are in the docs above; don't contradict them):

- Reserved root commands: `completion`, `mcp`, `http`, `version`.
- `argsbarg({ … })` builds the app in `src/app.ts`; `command()`, `route()`, `method()`, and `tool()` declare independent surfaces with typed `ctx.inputs`.
- Do not derive a wire route or tool from a CLI command. Share domain functions, not argv or response shims.
- String options: `format` / `default` / `pattern` per `cli-program.md`; use `ctx.inputs` for multi-flag commands.
- Varargs (`argMax: 0`): space-separated on the CLI, a JSON array over MCP; never comma-split positionals.
- App settings are app code (env vars or your own file); argsbarg doesn't manage them.
- Multi-surface commands (Ink + headless + MCP): one `read*Flags(ctx)` per command and one `resolve*Input(flags)` for cross-field rules, so every path shares one struct.
- `cli.guard` and `mcp.guard` are surface policies. Operation guards supplement them; use `{ mode: "override", run }` or `"public"` only when intentionally replacing that default.
- `mcp.http.middleware` must return `{ kind: "respond", response }` or `{ kind: "next", locals }`. Verify HTTP credentials there; local MCP callers must derive credentials only from the `env` source.
- Keep this template standalone. Mount `children` only for a real app-composition need, with exact keys and intentional exposure.
- Schemas live at the top of the command's `command.ts` (a sibling `schemas.ts` only when shared or large): export the Zod schema and a same-named `z.infer` type. Prefer `z.strictObject`; document every field with `.describe("…")` (agents read it; JSDoc isn't emitted).

## Code conventions

- **JSDoc:** document exported surfaces that aren't obvious from the name (output schemas, public types, non-trivial algorithms). Skip short test callbacks and pure re-export files.
- **Names:** describe the domain role; avoid `data` / `handler`-style placeholders outside tiny scopes.
- **Structure:** after imports, exported symbols first (alphabetical within each kind), then module-private helpers. Relative imports with explicit `.ts` extensions.
- **Abstractions:** keep single-use helpers in the calling file. Split only when reused, when the caller is hard to follow, or when the extraction is a substantial unit.
- **Skill:** when commands are added, renamed, or removed, update `skills/example-api/SKILL.md`.

### Module boundaries

| Path | Owns | Must not |
| --- | --- | --- |
| `src/index.ts` | Entry: `await app.run()` | Command handlers, business logic |
| `src/app.ts` | App spec: `commands: […]` (alphabetical by key) | Command handlers, business logic |
| `src/create-identity.ts` | Key, release repo, description (rewritten by `argsbarg create`) | Anything else |
| `src/types/` | Module augmentations (`argsbarg.d.ts`: `Locals`) | Runtime logic |
| `src/db/` | `AppDb` (SQLite connect, migrate, domain access), `migrations/*.sql` | Command handlers |
| `src/commands/<name>/` | One command: `command.ts` (with its Zod schemas), colocated `*.test.ts` | Shared helpers (lift them out) |
| `scripts/` | Dev tooling (release) | Production command paths |

## Tooling

- Node ≥ 22.18 and npm; no Bun required. [just](https://just.systems) runs the tasks.
- `just setup`, `just check` (Biome + `tsc --noEmit`), `just test` (check + `node --test`), `just build` (`tsc` → `dist/`, plus SQL migrations), `just run …` (from source, type-stripped).
- Release: `just release <major|minor|patch>` → `npm publish` (asks first; `--dry-run` changes nothing).

## Documentation

- `README.md` — install and commands for users
- `docs/architecture.md` — maintainer notes (create when needed)
- `skills/example-api/SKILL.md` — agent skill (customize as needed)

## App conventions

Replace with app-specific bullets.

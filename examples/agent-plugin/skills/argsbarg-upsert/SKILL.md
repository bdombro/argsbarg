---
id: argsbarg-upsert
name: argsbarg-upsert
description: Adds, removes, pivots, or upgrades Argsbarg capabilities in scaffolded or external apps while preserving unrelated surfaces and avoiding duplicates
enabled: true
---

# Upsert an Argsbarg app

Use this skill for an existing Argsbarg app or any repository that should adopt Argsbarg, including apps that were not created from a template

## Establish intent first

Classify the requested outcome for each independent surface: CLI, REST, JSON-RPC, and MCP

- add or expose an operation
- remove or stop exposing an operation
- pivot a name, input, output, transport, distribution, or domain behavior
- upgrade the installed Argsbarg version

Also record what must stay unchanged: other surfaces, operation names, business behavior, guards, packaging, docs, and dependencies

If removal, pivot, or upgrade language is ambiguous, read only enough local context to ask one focused question. A request such as "remove MCP" could mean removing one tool, disabling an HTTP mount, stopping stdio packaging, or removing every MCP declaration. A request for advice alone does not authorize edits

## Inspect the target narrowly

Find the installed Argsbarg version and package manager, then inspect only relevant app declarations, handlers, tests, package manifests, release/package config, docs, and skills. The conventional entry points are `src/app.ts` and `src/index.ts`, but an external app may use another layout

Read the installed package's `docs/cli-program.md`, `docs/schemas.md`, `docs/http-server.md`, and `docs/mcp.md`, plus `docs/use-cases/` when the request concerns policy, settings, gateways, durable work, or children. Match the installed version rather than assuming the current repository API

Before editing, search for the requested command, route, method, tool, packaging target, and documentation. Reuse the existing declaration or implementation when present

## Apply an upsert

- Additions: add exactly one explicit declaration to each requested surface and share only the reusable schema or domain function
- Removals: remove only the requested binding, then remove now-unused local code; preserve shared code and unrelated declarations
- Pivots: keep each surface aligned with the app's intent, without changing unstated names, transports, contracts, or packaging
- Upgrades: compare installed behavior with the target Argsbarg version before changing code; change dependencies or lockfiles only when authorized
- External apps: introduce the smallest compatible declarations and packaging changes; do not rewrite unrelated architecture into a template layout

Never derive REST, RPC, or MCP exposure from a CLI declaration. Validate registration and handler behavior in place

Repeated requests must be idempotent: update an existing declaration instead of adding a duplicate command, route, method, tool, package entry, or doc section

## Version awareness

When the request could benefit from an update, check published npm versions and the official Argsbarg GitHub changelog. Ignore `[Unreleased]` for installed-version guidance. Surface only fixes urgent for the app or relevant to the requested outcome

If the check is unavailable, continue against the installed version where possible. Do not upgrade automatically and do not infer that the latest version is safe for the app

## Verify the changed intent

Run focused declaration, type, and behavior checks for every changed surface plus the relevant package or create check. Confirm

- existing surfaces still behave as before
- additions appear exactly once in declaration, discovery, docs, and skills
- removals no longer dispatch, advertise, or package
- pivots changed every requested boundary and no unrelated boundary
- upgrades remain within the authorized dependency range and use the installed target's API

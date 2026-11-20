# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- Demonstrate D90 MCP policy with one optional token: HTTP middleware verifies
  `Authorization`, while stdio and local calls verify
  `EXAMPLE_AGENT_PLUGIN_TOKEN` through the same MCP guard.
- Build the tracked MCP bundle as a direct Node executable, copy the exact
  extensionless path expected by `mcp bundle`, and make plugin manifests launch
  the `.mjs` artifact without a separate `node` command.

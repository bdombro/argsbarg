# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Demonstrate CLI and MCP guard/caller-seed policy while retaining standalone
  completion, version, HTTP, JSON-RPC, and MCP capability parity.
- Return plain `version=<version>` status text by default and the JSON object only
  when `--json` is requested.

/*
Focused fixtures for the MCP 2026 transport-neutral envelope codec.
The vectors pin metadata, IDs, cache ownership, result metadata, and errors without host or I/O behavior.
*/

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decodeMcpRequest,
  encodeMcpResult,
  MCP_CACHE_POLICY,
  MCP_CLIENT_CAPABILITIES_KEY,
  MCP_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSION_KEY,
  MCP_SERVER_INFO_KEY,
} from "./protocol.ts";

/** Canonical accepted request metadata for every fixture request. */
const META = {
  [MCP_PROTOCOL_VERSION_KEY]: MCP_PROTOCOL_VERSION,
  [MCP_CLIENT_CAPABILITIES_KEY]: {},
  "io.modelcontextprotocol/clientInfo": { name: "fixture-client", version: "1" },
  progressToken: 7,
} as const;

/** Canonical result metadata identity owned by the server adapter. */
const SERVER_INFO = { name: "fixture-app", version: "1.0.0" } as const;

test("protocol accepts exact 2026 metadata, ids, and notifications while rejecting malformed envelopes", () => {
  const accepted = {
    jsonrpc: "2.0",
    id: "discover",
    method: "server/discover",
    params: { _meta: META },
  };
  assert.deepEqual(decodeMcpRequest(JSON.stringify(accepted)), {
    kind: "request",
    request: {
      jsonrpc: "2.0",
      id: "discover",
      method: "server/discover",
      params: { _meta: META },
      meta: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "fixture-client", version: "1" },
        progressToken: 7,
      },
    },
  });
  for (const id of [8, "call"]) {
    const decoded = decodeMcpRequest({
      ...accepted,
      id,
      params: { _meta: { [MCP_PROTOCOL_VERSION_KEY]: MCP_PROTOCOL_VERSION, [MCP_CLIENT_CAPABILITIES_KEY]: {} } },
    });
    assert.equal(decoded.kind, "request");
    if (decoded.kind === "request") assert.equal(decoded.request.id, id);
  }
  assert.equal(
    decodeMcpRequest({ jsonrpc: "2.0", method: "tools/list", params: { _meta: META } }).kind,
    "request",
    "notifications remain decodable but dispatch must not emit or invoke",
  );

  const invalid = [
    { input: "{", id: null, code: -32_700 },
    { input: [], id: null, code: -32_600 },
    { input: { jsonrpc: "1.0", id: 1, method: "tools/list" }, id: 1, code: -32_600 },
    { input: { jsonrpc: "2.0", id: null, method: "tools/list" }, id: null, code: -32_600 },
    { input: { jsonrpc: "2.0", id: true, method: "tools/list" }, id: null, code: -32_600 },
    { input: { jsonrpc: "2.0", id: {}, method: "tools/list" }, id: null, code: -32_600 },
    { input: { jsonrpc: "2.0", id: 1.5, method: "tools/list" }, id: null, code: -32_600 },
    { input: { jsonrpc: "2.0", id: 1, method: 7 }, id: 1, code: -32_600 },
    { input: { jsonrpc: "2.0", id: 1, method: "" }, id: 1, code: -32_600 },
    { input: { jsonrpc: "2.0", id: 1, method: "tools/list", params: [] }, id: 1, code: -32_602 },
    { input: { jsonrpc: "2.0", id: 1, method: "tools/list", params: null }, id: 1, code: -32_602 },
    {
      input: { jsonrpc: "2.0", id: 1, method: "tools/list", result: {} },
      id: 1,
      code: -32_600,
    },
    {
      input: { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: null } },
      id: 1,
      code: -32_602,
    },
    {
      input: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: { _meta: { [MCP_CLIENT_CAPABILITIES_KEY]: {} } },
      },
      id: 1,
      code: -32_602,
    },
    {
      input: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: { _meta: { [MCP_PROTOCOL_VERSION_KEY]: MCP_PROTOCOL_VERSION } },
      },
      id: 1,
      code: -32_602,
    },
    {
      input: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {
          _meta: { [MCP_PROTOCOL_VERSION_KEY]: MCP_PROTOCOL_VERSION, [MCP_CLIENT_CAPABILITIES_KEY]: [] },
        },
      },
      id: 1,
      code: -32_602,
    },
    {
      input: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: { _meta: { [MCP_PROTOCOL_VERSION_KEY]: 2026 } },
      },
      id: 1,
      code: -32_602,
    },
    {
      input: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {
          _meta: {
            [MCP_PROTOCOL_VERSION_KEY]: MCP_PROTOCOL_VERSION,
            [MCP_CLIENT_CAPABILITIES_KEY]: {},
            "io.modelcontextprotocol/clientInfo": { name: 7, version: "1" },
          },
        },
      },
      id: 1,
      code: -32_602,
    },
    {
      input: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {
          _meta: {
            [MCP_PROTOCOL_VERSION_KEY]: MCP_PROTOCOL_VERSION,
            [MCP_CLIENT_CAPABILITIES_KEY]: {},
            progressToken: 1.5,
          },
        },
      },
      id: 1,
      code: -32_602,
    },
  ] as const;
  for (const fixture of invalid) {
    const decoded = decodeMcpRequest(fixture.input);
    assert.equal(decoded.kind, "error");
    if (decoded.kind === "error") {
      assert.equal(decoded.response.id, fixture.id);
      assert.equal(decoded.response.error.code, fixture.code);
    }
  }
});

test("protocol pins unsupported versions, initialize compatibility, complete results, and cache ownership", () => {
  const unsupported = decodeMcpRequest({
    jsonrpc: "2.0",
    id: "old",
    method: "tools/list",
    params: {
      _meta: {
        [MCP_PROTOCOL_VERSION_KEY]: "2025-11-25",
        [MCP_CLIENT_CAPABILITIES_KEY]: {},
      },
    },
  });
  assert.deepEqual(unsupported, {
    kind: "error",
    response: {
      jsonrpc: "2.0",
      id: "old",
      error: {
        code: -32_022,
        message: "Unsupported protocol version: 2025-11-25",
        data: { supported: [MCP_PROTOCOL_VERSION], requested: "2025-11-25" },
      },
    },
  });
  assert.equal(
    decodeMcpRequest({ jsonrpc: "2.0", id: "init", method: "initialize" }).kind,
    "request",
    "initialize reaches its explicit compatibility error before missing metadata validation",
  );

  const discover = encodeMcpResult(
    "discover",
    {
      ...MCP_CACHE_POLICY,
      supportedVersions: [MCP_PROTOCOL_VERSION],
      capabilities: { tools: {} },
      instructions: "Fixture instructions.",
    },
    SERVER_INFO,
  );
  assert.deepEqual(discover, {
    jsonrpc: "2.0",
    id: "discover",
    result: {
      resultType: "complete",
      ttlMs: 3_600_000,
      cacheScope: "public",
      supportedVersions: [MCP_PROTOCOL_VERSION],
      capabilities: { tools: {} },
      instructions: "Fixture instructions.",
      _meta: { [MCP_SERVER_INFO_KEY]: SERVER_INFO },
    },
  });
  const list = encodeMcpResult(8, { ...MCP_CACHE_POLICY, tools: [] }, SERVER_INFO);
  assert.equal((list.result as Record<string, unknown>).ttlMs, 3_600_000);
  assert.equal((list.result as Record<string, unknown>).cacheScope, "public");

  const call = encodeMcpResult(
    "call",
    {
      content: [{ type: "text", text: "hello" }],
      structuredContent: { value: "hello" },
      isError: false,
    },
    SERVER_INFO,
  );
  assert.deepEqual(call, {
    jsonrpc: "2.0",
    id: "call",
    result: {
      resultType: "complete",
      content: [{ type: "text", text: "hello" }],
      structuredContent: { value: "hello" },
      isError: false,
      _meta: { [MCP_SERVER_INFO_KEY]: SERVER_INFO },
    },
  });
  assert.equal("ttlMs" in call.result, false);
  assert.equal("cacheScope" in call.result, false);
});

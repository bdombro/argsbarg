/*
Fixtures for MCP 2026-07-28 Tasks payload guards.
The pinned Tasks and core schemas define the accepted wire variants.
*/

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isJsonValue,
  isMcpContentBlock,
  isMcpTaskInputRequest,
  isMcpTaskInputRequests,
  isMcpTaskInputResponse,
  isMcpTaskInputResponses,
  isMcpTaskToolResult,
  mcpTaskInputUsesSamplingTools,
} from "./task-payloads.ts";

/** Minimal form request with every family of supported property schemas. */
const form = {
  method: "elicitation/create",
  params: {
    message: "Choose options",
    requestedSchema: {
      type: "object",
      properties: {
        email: { type: "string", format: "email", minLength: 1 },
        period: { type: "integer", minimum: 1, default: 3 },
        rate: { type: "number", minimum: 0.5 },
        notify: { type: "boolean", default: false },
        color: { type: "string", enum: ["r"], enumNames: ["Red"] },
        shape: { type: "string", oneOf: [{ const: "square", title: "Square" }] },
        tags: { type: "array", items: { type: "string", enum: ["new"] } },
        themes: { type: "array", items: { anyOf: [{ const: "dark", title: "Dark" }] } },
      },
      required: ["email"],
    },
  },
} as const;

/** URL-mode request corresponding to a bare elicitation action with no content. */
const url = {
  method: "elicitation/create",
  params: { mode: "url", message: "Continue in browser", url: "https://example.test/continue" },
} as const;

/** Ordinary MCP content included both directly and in a sampling tool result. */
const text = { type: "text", text: "Result", annotations: { audience: ["assistant"], priority: 0.5 } };

/** Sampled tool call plus the corresponding message sent back from the user. */
const sampling = {
  method: "sampling/createMessage",
  params: {
    maxTokens: 64,
    temperature: 0.75,
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: "one", name: "read", input: { n: 1 } }] },
      {
        role: "user",
        content: {
          type: "tool_result",
          toolUseId: "one",
          content: [text, { type: "resource_link", name: "report", uri: "urn:example:report" }],
          structuredContent: [1, null],
          isError: false,
        },
      },
    ],
    modelPreferences: { costPriority: 0.4, hints: [{ name: "model", providerHint: true }] },
    tools: [{ name: "read", inputSchema: { type: "object", properties: { n: { type: "number" } } } }],
    toolChoice: { mode: "required" },
  },
} as const;

test("checks form and URL elicitation requests, preserving legitimate variants", () => {
  assert.ok(isMcpTaskInputRequests({ form, url, roots: { method: "roots/list" }, sampling }));
  assert.ok(isMcpTaskInputRequest({ ...form, params: { ...form.params, mode: "form" } }));
  assert.equal(isMcpTaskInputRequest({ ...url, params: { ...url.params, url: "/continue" } }), false);
  assert.equal(isMcpTaskInputRequest({ ...url, params: { message: "Continue", url: "https://example.test" } }), false);
  for (const bad of [
    { type: "object", properties: {} },
    { type: "string", format: "hostname" },
    { type: "string", oneOf: [{ const: "label missing" }] },
    { type: "array", items: { type: "object" } },
    { type: "array", items: { type: "string", enum: [2] } },
  ]) {
    assert.equal(isMcpTaskInputRequest({
      ...form,
      params: { ...form.params, requestedSchema: { type: "object", properties: { bad } } },
    }), false);
  }
});

test("distinguishes elicitation response structure from stored request correspondence", () => {
  assert.ok(isMcpTaskInputResponses({
    form: { action: "accept", content: { rate: 1.25, tags: ["new"], notify: true } },
    url: { action: "accept" },
    declined: { action: "decline" },
  }));
  assert.equal(isMcpTaskInputResponse({ action: "cancel", content: {} }), false);
  assert.equal(isMcpTaskInputResponse({ action: "accept", content: { unknown: null } }), false);
  assert.equal(isMcpTaskInputResponse({ action: "accept", content: { tags: ["new"] } }, url), false);
  assert.ok(isMcpTaskInputResponse({ action: "accept", content: { tags: ["new"] } }, form));
  assert.equal(isMcpTaskInputResponse({ roots: [] }, form), false);
});

test("validates the sampling-only union, options, and tools capability signal", () => {
  assert.ok(isMcpTaskInputRequest(sampling));
  assert.ok(mcpTaskInputUsesSamplingTools(sampling));
  assert.ok(mcpTaskInputUsesSamplingTools({ ...sampling, params: { messages: sampling.params.messages, maxTokens: 1 } }));
  assert.ok(mcpTaskInputUsesSamplingTools({ ...sampling, params: { messages: [], maxTokens: 1, tools: [] } }));
  assert.equal(mcpTaskInputUsesSamplingTools({ ...sampling, params: { messages: [], maxTokens: 1 } }), false);
  assert.equal(mcpTaskInputUsesSamplingTools(form), false);
  assert.ok(isMcpTaskInputResponse({
    role: "assistant",
    model: "model",
    stopReason: "vendor-specific-reason",
    content: [text, { type: "tool_use", id: "one", name: "read", input: {} }],
  }));
  for (const bad of [
    { maxTokens: 1.5 },
    { modelPreferences: { speedPriority: 1.5 } },
    { tools: [{ name: "read", inputSchema: { type: "array" } }] },
    { toolChoice: { mode: "forced" } },
    { messages: [{ role: "user", content: { type: "tool_result", toolUseId: "one", content: [{}] } }] },
  ]) {
    assert.equal(isMcpTaskInputRequest({ ...sampling, params: { ...sampling.params, ...bad } }), false);
  }
  assert.equal(isMcpTaskInputResponse({
    role: "assistant", model: "model", content: { type: "resource_link", uri: "urn:example:doc", name: "doc" },
  }), false);
});

test("accepts roots maps and enforces absolute file URIs and metadata shape", () => {
  assert.ok(isMcpTaskInputRequests({ roots: { method: "roots/list", params: { _meta: { "com.example/hint": 1 } } } }));
  assert.ok(isMcpTaskInputResponses({
    roots: { roots: [{ uri: "file:///project/index", _meta: { "com.example/hint": true } }] },
  }));
  assert.ok(isMcpTaskInputResponses({}));
  assert.equal(isMcpTaskInputResponse({ roots: [{ uri: "https://example.test/" }] }), false);
  assert.equal(isMcpTaskInputResponse({ roots: [{ uri: "file:///project", name: 42 }] }), false);
  assert.equal(isMcpTaskInputRequest({ method: "roots/list", params: { _meta: null } }), false);
  assert.equal(isMcpTaskInputRequests({ unknown: { method: "unknown" } }), false);
});

test("checks every ordinary tool result content variant and preserves JSON extensions", () => {
  const result = {
    resultType: "complete",
    isError: true,
    content: [
      text,
      { type: "image", data: "AA==", mimeType: "image/png" },
      { type: "audio", data: "AAA=", mimeType: "audio/wav" },
      {
        type: "resource_link",
        uri: "urn:example:resource",
        name: "file",
        title: "File",
        description: "File link",
        size: 0,
        icons: [{ src: "https://example.test/icon.png", sizes: ["48x48"], theme: "light" }],
      },
      { type: "resource", resource: { uri: "file:///a", text: "data", _meta: { "com.example/small": true } } },
      { type: "resource", resource: { uri: "file:///b", blob: "AAE=", mimeType: "application/octet-stream" } },
    ],
    _meta: { "io.modelcontextprotocol/serverInfo": { name: "server", version: "1" }, "com.example/result": [1] },
    vendorExtension: { arbitrary: true },
  };
  for (const value of [null, false, "string", [1], { ok: true }, 1.25]) {
    assert.ok(isMcpTaskToolResult({ ...result, structuredContent: value }));
  }
  assert.equal(isMcpTaskToolResult({ content: [] }), false);
  assert.equal(isMcpTaskToolResult({ ...result, resultType: "input_required" }), false);
  assert.equal(isMcpTaskToolResult({ ...result, structuredContent: undefined }), false);
  assert.equal(isMcpTaskToolResult({
    ...result, _meta: { "io.modelcontextprotocol/serverInfo": { name: "server" } },
  }), false);
});

test("rejects malformed content media, annotations, and nested resource fields", () => {
  for (const bad of [
    { ...text, annotations: { audience: ["system"] } },
    { ...text, annotations: { priority: 2 } },
    { ...text, _meta: { "invalid/prefix/key": 1 } },
    { type: "image", data: "not base64", mimeType: "image/png" },
    { type: "audio", data: "AA==", mimeType: 1 },
    { type: "resource_link", uri: "relative/path", name: "file" },
    { type: "resource_link", uri: "file:///path", name: "file", size: -1 },
    { type: "resource_link", uri: "file:///path", name: "file", icons: [{ src: "icon.png" }] },
    { type: "resource", resource: { uri: "file:///a", blob: "z" } },
    { type: "resource", resource: { uri: "file:///a", text: "ok", _meta: [] } },
    { type: "tool_use", id: "one", name: "read", input: {} },
  ]) {
    assert.equal(isMcpContentBlock(bad), false, JSON.stringify(bad));
  }
});

test("rejects JavaScript values JSON serialization would silently change", () => {
  const shared = Object.assign(Object.create(null), { ok: true });
  assert.ok(isJsonValue({ a: shared, b: [shared, null] }));
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const sparse = Array.from({ length: 2 }, () => 1);
  Reflect.deleteProperty(sparse, "0");
  const getter = {
    get value(): never {
      return assert.fail("validation must not invoke a getter");
    },
  };
  for (const bad of [
    { undefined },
    [undefined],
    { invalid: NaN },
    Infinity,
    1n,
    new Date(0),
    new Map(),
    Buffer.from("a"),
    { toJSON: () => null },
    { [Symbol("invisible")]: true },
    Object.assign([1], { extra: true }),
    getter,
    sparse,
    cycle,
  ]) {
    assert.equal(isJsonValue(bad), false);
  }
});

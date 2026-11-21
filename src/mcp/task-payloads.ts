/*
Wire guards for the MCP 2026-07-28 Tasks payloads.
The provider owns input correspondence, application schemas, and task state.
*/

import type {
  McpTaskInputRequest,
  McpTaskInputRequests,
  McpTaskInputResponse,
  McpTaskInputResponses,
  McpTaskToolResult,
} from "./tasks.ts";

/** JSON data that can cross the wire without implicit JavaScript conversions. */
type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** Rejects cycles and values that JSON would drop, replace, or coerce. */
export function isJsonValue(value: unknown): value is JsonValue {
  const active = new Set<object>();
  const pending: { value: unknown; leave?: true }[] = [{ value }];
  while (pending.length > 0) {
    const entry = pending.pop();
    const item = entry?.value;
    if (item === null || isString(item) || isBoolean(item) || isFiniteNumber(item)) continue;
    if (typeof item !== "object" || item === null) return false;
    if (entry?.leave) {
      active.delete(item);
      continue;
    }
    const array = Array.isArray(item);
    const prototype: unknown = Object.getPrototypeOf(item);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return false;
    if (active.has(item)) return false;
    const keys = Reflect.ownKeys(item);
    if (array && keys.length !== item.length + 1) return false;
    active.add(item);
    pending.push({ value: item, leave: true });
    for (const key of keys) {
      if (array && key === "length") continue;
      if (typeof key !== "string" || (array && (!/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= item.length))) {
        return false;
      }
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return false;
      pending.push({ value: descriptor.value });
    }
  }
  return true;
}

/** Checks a map of bare server-to-client requests, not JSON-RPC envelopes. */
export function isMcpTaskInputRequests(value: unknown): value is McpTaskInputRequests {
  return isRecord(value) && isJsonValue(value) && Object.values(value).every(isInputRequestShape);
}

/** Checks one bare input request, including any extension fields as JSON. */
export function isMcpTaskInputRequest(value: unknown): value is McpTaskInputRequest {
  return isJsonValue(value) && isInputRequestShape(value);
}

/** Checks a map of client responses without requiring a matching task snapshot. */
export function isMcpTaskInputResponses(value: unknown): value is McpTaskInputResponses {
  return isRecord(value) && isJsonValue(value) && Object.values(value).every(isInputResponseShape);
}

/** Checks one bare input response, optionally against an outstanding request's variant. */
export function isMcpTaskInputResponse(value: unknown, request?: McpTaskInputRequest): value is McpTaskInputResponse {
  if (!isJsonValue(value) || !isRecord(value) || !optional(value._meta, isMeta)) return false;
  switch (request?.method) {
    case "elicitation/create":
      return isElicitationResponse(value) && (request.params.mode !== "url" || !Object.hasOwn(value, "content"));
    case "roots/list":
      return isRootsResponse(value);
    case "sampling/createMessage":
      return isSamplingResponse(value);
    default:
      return isInputResponseShape(value);
  }
}

/** Identifies requests that require the client's sampling-tools capability. */
export function mcpTaskInputUsesSamplingTools(request: McpTaskInputRequest): boolean {
  if (request.method !== "sampling/createMessage") return false;
  const { messages, tools, toolChoice } = request.params;
  if (tools !== undefined || toolChoice !== undefined) return true;
  return Array.isArray(messages) && messages.some((message) => {
    if (!isRecord(message)) return false;
    return (Array.isArray(message.content) ? message.content : [message.content]).some(
      (block) => isRecord(block) && (block.type === "tool_use" || block.type === "tool_result"),
    );
  });
}

/** Checks the final, ordinary tools/call result embedded in a completed task. */
export function isMcpTaskToolResult(value: unknown): value is McpTaskToolResult {
  if (!isJsonValue(value) || !isRecord(value) || value.resultType !== "complete" || !hasToolResultContent(value)) {
    return false;
  }
  const meta = value._meta;
  if (meta === undefined) return true;
  if (!isMeta(meta)) return false;
  const serverInfo = meta["io.modelcontextprotocol/serverInfo"];
  return serverInfo === undefined || (
    isRecord(serverInfo) &&
    hasBaseMetadata(serverInfo) &&
    isString(serverInfo.version) &&
    optional(serverInfo.websiteUrl, isUri)
  );
}

/** Checks one ordinary tool or prompt content block. */
export function isMcpContentBlock(value: unknown): value is Readonly<Record<string, unknown>> {
  return isJsonValue(value) && isContentBlockShape(value);
}

/** Narrows a non-null JSON object candidate, excluding arrays. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Recognizes a string field. */
function isString(value: unknown): value is string {
  return typeof value === "string";
}

/** Recognizes a boolean field. */
function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

/** Recognizes a JSON number without accepting NaN or infinities. */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Checks a whole list after the JSON guard has ruled out sparse arrays. */
function isArrayOf(value: unknown, check: (item: unknown) => boolean): boolean {
  return Array.isArray(value) && value.every(check);
}

/** Accepts an absent field or a matching value on an already JSON-checked object. */
function optional(value: unknown, check: (item: unknown) => boolean): boolean {
  return value === undefined || check(value);
}

/** Recognizes both protocol roles. */
function isRole(value: unknown): boolean {
  return value === "user" || value === "assistant";
}

/** Checks a numeric preference or priority on the inclusive unit interval. */
function isUnitInterval(value: unknown): boolean {
  return isFiniteNumber(value) && value >= 0 && value <= 1;
}

/** Checks an absolute URI without fetching it or restricting it to web schemes. */
function isUri(value: unknown): value is string {
  return isString(value) &&
    /^[a-z][a-z\d+.-]*:[a-z\d._~:/?#[\]@!$&'()*+,;=%-]*$/i.test(value) &&
    !/%(?![\da-f]{2})/i.test(value) &&
    URL.canParse(value);
}

/** Checks standard RFC 4648 base64 rather than Node's permissive decoding. */
function isBase64(value: unknown): boolean {
  return isString(value) && value.length % 4 === 0 &&
    /^[a-z\d+/]*(?:={1,2})?$/i.test(value) && !/\s/.test(value);
}

/** Checks the core `_meta` key grammar while leaving extension values opaque. */
function isMeta(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).every((key) =>
    /^(?:(?:[a-z](?:[a-z\d-]*[a-z\d])?\.)*[a-z](?:[a-z\d-]*[a-z\d])?\/)?(?:[a-z\d](?:[a-z\d_.-]*[a-z\d])?)?$/i.test(key),
  );
}

/** Checks shared content annotations. ISO 8601 for lastModified is advisory. */
function isAnnotations(value: unknown): boolean {
  return isRecord(value) &&
    optional(value.audience, (audience) => isArrayOf(audience, isRole)) &&
    optional(value.priority, isUnitInterval) &&
    optional(value.lastModified, isString);
}

/** Checks base metadata and icon fields common to resources, tools, and server info. */
function hasBaseMetadata(value: Record<string, unknown>): boolean {
  return isString(value.name) && optional(value.title, isString) && optional(value.description, isString) &&
    optional(value.icons, (icons) => isArrayOf(icons, (icon) =>
      isRecord(icon) && isUri(icon.src) && optional(icon.mimeType, isString) &&
      optional(icon.sizes, (sizes) => isArrayOf(sizes, isString)) &&
      (icon.theme === undefined || icon.theme === "light" || icon.theme === "dark"),
    ));
}

/** Checks the fields common to tool-call results and sampling tool-result blocks. */
function hasToolResultContent(value: Record<string, unknown>): boolean {
  return isArrayOf(value.content, isContentBlockShape) && optional(value.isError, isBoolean);
}

/** Checks text, image, audio, resource link, or embedded resource content. */
function isContentBlockShape(value: unknown): boolean {
  if (!isRecord(value) || !optional(value._meta, isMeta) || !optional(value.annotations, isAnnotations)) {
    return false;
  }
  switch (value.type) {
    case "text":
      return isString(value.text);
    case "image":
    case "audio":
      return isBase64(value.data) && isString(value.mimeType);
    case "resource_link":
      return isUri(value.uri) && hasBaseMetadata(value) && optional(value.mimeType, isString) &&
        optional(value.size, (size) => isFiniteNumber(size) && Number.isInteger(size) && size >= 0);
    case "resource": {
      const { resource } = value;
      return isRecord(resource) && isUri(resource.uri) &&
        optional(resource.mimeType, isString) && optional(resource._meta, isMeta) &&
        (Object.hasOwn(resource, "text") || Object.hasOwn(resource, "blob")) &&
        optional(resource.text, isString) && optional(resource.blob, isBase64);
    }
    default:
      return false;
  }
}

/** Keeps sampling's block union separate from the ordinary tool result union. */
function isSamplingBlock(value: unknown): boolean {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case "tool_use":
      return isString(value.id) && isString(value.name) && isRecord(value.input) && optional(value._meta, isMeta);
    case "tool_result":
      return isString(value.toolUseId) && hasToolResultContent(value) && optional(value._meta, isMeta);
    case "text":
    case "image":
    case "audio":
      return isContentBlockShape(value);
    default:
      return false;
  }
}

/** Checks the role and single-block or multi-block representation. */
function isSamplingMessage(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && isRole(value.role) && optional(value._meta, isMeta) &&
    (Array.isArray(value.content) ? value.content.every(isSamplingBlock) : isSamplingBlock(value.content));
}

/** Checks sampling tool metadata and schema containers without evaluating arbitrary JSON Schema. */
function isSamplingTool(value: unknown): boolean {
  if (!isRecord(value) || !hasBaseMetadata(value) || !optional(value._meta, isMeta)) return false;
  const { annotations, inputSchema, outputSchema } = value;
  return isRecord(inputSchema) && inputSchema.type === "object" && optional(inputSchema.$schema, isString) &&
    optional(outputSchema, (schema) => isRecord(schema) && optional(schema.$schema, isString)) &&
    optional(annotations, (annotation) =>
      isRecord(annotation) && optional(annotation.title, isString) &&
      ["destructiveHint", "idempotentHint", "openWorldHint", "readOnlyHint"].every((key) =>
        optional(annotation[key], isBoolean),
      ),
    );
}

/** Checks sampling-specific request options in addition to the message array. */
function isSamplingRequestParams(value: Record<string, unknown>): boolean {
  const { includeContext, modelPreferences, toolChoice } = value;
  return Number.isInteger(value.maxTokens) && isArrayOf(value.messages, isSamplingMessage) &&
    optional(modelPreferences, (prefs) =>
      isRecord(prefs) &&
      ["costPriority", "speedPriority", "intelligencePriority"].every((key) => optional(prefs[key], isUnitInterval)) &&
      optional(prefs.hints, (hints) => isArrayOf(hints, (hint) => isRecord(hint) && optional(hint.name, isString))),
    ) &&
    optional(value.systemPrompt, isString) &&
    (includeContext === undefined || includeContext === "none" || includeContext === "thisServer" ||
      includeContext === "allServers") &&
    optional(value.temperature, isFiniteNumber) &&
    optional(value.stopSequences, (sequences) => isArrayOf(sequences, isString)) &&
    optional(value.metadata, isRecord) &&
    optional(value.tools, (tools) => isArrayOf(tools, isSamplingTool)) &&
    optional(toolChoice, (choice) => isRecord(choice) &&
      (choice.mode === undefined || choice.mode === "auto" || choice.mode === "required" || choice.mode === "none"),
    );
}

/** Checks a titled choice option. */
function isTitledChoice(value: unknown): boolean {
  return isRecord(value) && isString(value.const) && isString(value.title);
}

/** Checks the flat primitive schemas and the supported single/multi-select forms. */
function isFormProperty(value: unknown): boolean {
  if (!isRecord(value) || !optional(value.title, isString) || !optional(value.description, isString)) return false;
  switch (value.type) {
    case "string":
      return optional(value.default, isString) &&
        optional(value.minLength, isCount) && optional(value.maxLength, isCount) &&
        (value.format === undefined || value.format === "email" || value.format === "uri" ||
          value.format === "date" || value.format === "date-time") &&
        optional(value.enum, (choices) => isArrayOf(choices, isString)) &&
        optional(value.enumNames, (names) => Object.hasOwn(value, "enum") && isArrayOf(names, isString)) &&
        optional(value.oneOf, (choices) => isArrayOf(choices, isTitledChoice));
    case "number":
    case "integer":
      return ["minimum", "maximum", "default"].every((key) => optional(value[key], isFiniteNumber));
    case "boolean":
      return optional(value.default, isBoolean);
    case "array": {
      const { items } = value;
      if (!isRecord(items) || !optional(value.minItems, isCount) || !optional(value.maxItems, isCount) ||
        !optional(value.default, (choices) => isArrayOf(choices, isString))) return false;
      return (items.type === "string" && isArrayOf(items.enum, isString)) ||
        (optional(items.type, (type) => type === "string") && isArrayOf(items.anyOf, isTitledChoice));
    }
    default:
      return false;
  }
}

/** Checks a nonnegative JSON Schema length or count. */
function isCount(value: unknown): boolean {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= 0;
}

/** Checks the elicitation discriminator and only the selected variant's fields. */
function isElicitationRequestParams(value: Record<string, unknown>): boolean {
  const { mode, requestedSchema } = value;
  if (!isString(value.message)) return false;
  if (mode === "url") return isUri(value.url);
  return (mode === undefined || mode === "form") && isRecord(requestedSchema) &&
    requestedSchema.type === "object" &&
    optional(requestedSchema.$schema, isString) &&
    optional(requestedSchema.required, (required) => isArrayOf(required, isString)) &&
    isRecord(requestedSchema.properties) &&
    Object.values(requestedSchema.properties).every(isFormProperty);
}

/** Checks input method-specific shapes after the JSON walk. */
function isInputRequestShape(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const { params } = value;
  if (value.method === "roots/list" && params === undefined) return true;
  if (!isRecord(params) || !optional(params._meta, isMeta)) return false;
  switch (value.method) {
    case "elicitation/create":
      return isElicitationRequestParams(params);
    case "sampling/createMessage":
      return isSamplingRequestParams(params);
    case "roots/list":
      return true;
    default:
      return false;
  }
}

/** Checks submitted primitives, permitting content only on acceptance. */
function isElicitationResponse(value: Record<string, unknown>): boolean {
  if (value.action === "decline" || value.action === "cancel") return !Object.hasOwn(value, "content");
  return value.action === "accept" && optional(value.content, (content) =>
    isRecord(content) && Object.values(content).every((item) =>
      isString(item) || isFiniteNumber(item) || isBoolean(item) || isArrayOf(item, isString),
    ),
  );
}

/** Checks roots and enforces the core schema's file URI requirement. */
function isRootsResponse(value: Record<string, unknown>): boolean {
  return isArrayOf(value.roots, (root) =>
    isRecord(root) && isUri(root.uri) && root.uri.startsWith("file://") &&
    optional(root.name, isString) && optional(root._meta, isMeta),
  );
}

/** Checks a sampled message extended by model identity and an open stop reason. */
function isSamplingResponse(value: Record<string, unknown>): boolean {
  return isSamplingMessage(value) && isString(value.model) && optional(value.stopReason, isString);
}

/** Checks the open MRTR response union after the JSON walk. */
function isInputResponseShape(value: unknown): boolean {
  return isRecord(value) && optional(value._meta, isMeta) &&
    (isElicitationResponse(value) || isSamplingResponse(value) || isRootsResponse(value));
}

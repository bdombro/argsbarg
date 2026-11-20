/*
Shared JSON and YAML document codecs for REST and generated CLI calls.
*/

import { parseDocument, stringify } from "yaml";

/** Structured document formats exposed by REST and the CLI mirrors. */
export type DocumentFormat = "json" | "yaml";

/** Decodes one document without allowing YAML-only values into the invocation pipeline. */
export function decodeDocument(text: string, format: DocumentFormat): unknown {
  if (format === "json") return JSON.parse(text);
  const document = parseDocument(text, {
    version: "1.2",
    schema: "core",
    merge: false,
    resolveKnownTags: false,
    stringKeys: true,
  });
  if (document.errors.length > 0 || document.warnings.length > 0) {
    throw new SyntaxError("Invalid YAML document");
  }
  const value: unknown = document.toJS({ maxAliasCount: 0 });
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const item = pending.pop();
    if (typeof item === "number" && !Number.isFinite(item)) {
      throw new SyntaxError("YAML numbers must be finite");
    }
    if (item !== null && typeof item === "object") {
      for (const child of Object.values(item)) pending.push(child);
    }
  }
  return value;
}

/** Preserves JSON value semantics when serializing either representation. */
export function encodeDocument(value: unknown, format: DocumentFormat): string {
  const json = JSON.stringify(value);
  if (json === undefined) throw new TypeError("Result is not JSON serializable");
  return format === "json" ? json : stringify(JSON.parse(json));
}

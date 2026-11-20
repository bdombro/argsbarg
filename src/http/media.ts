/*
Media-type selection for the REST document boundary.
*/

import type { DocumentFormat } from "../core/document.ts";

/** MIME type used for each generated document format. */
export const documentMediaType: Readonly<Record<DocumentFormat, string>> = {
  json: "application/json",
  yaml: "application/yaml",
};

/** Recognizes UTF-8 request documents, including existing vendor JSON types. */
export function requestDocumentFormat(contentType: string | null): DocumentFormat | undefined {
  const [type, ...parameters] = (contentType ?? "").split(";").map((part) => part.trim()).filter(Boolean);
  if (parameters.length > 1 || (parameters.length === 1 && !/^charset=(?:utf-8|"utf-8")$/i.test(parameters[0] ?? ""))) {
    return undefined;
  }
  const media = type?.toLowerCase();
  if (media === documentMediaType.yaml) return "yaml";
  if (media === documentMediaType.json || (media !== undefined && /^application\/[^/]+\+json$/.test(media))) {
    return "json";
  }
  return undefined;
}

/** Selects explicitly requested YAML when it is at least as preferred as JSON. */
export function responseDocumentFormat(accept: string | null): DocumentFormat {
  const preferences = new Map<string, number>();
  for (const range of (accept ?? "").split(",")) {
    const [media, ...parameters] = range.toLowerCase().split(";").map((part) => part.trim());
    if (!media) continue;
    let quality = 1;
    for (const parameter of parameters) {
      if (parameter.startsWith("q=")) {
        const weight = parameter.slice(2);
        quality = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(weight) ? Number(weight) : 0;
        break;
      }
      if (!/^charset=(?:utf-8|"utf-8")$/.test(parameter)) {
        quality = 0;
        break;
      }
    }
    preferences.set(media, Math.max(preferences.get(media) ?? 0, quality));
  }
  const yaml = preferences.get(documentMediaType.yaml) ?? 0;
  const json = preferences.get(documentMediaType.json) ?? preferences.get("application/*") ?? preferences.get("*/*") ?? 0;
  return yaml > 0 && yaml >= json ? "yaml" : "json";
}

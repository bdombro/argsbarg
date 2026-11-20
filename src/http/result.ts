/*
Maps headless respond payloads to native HTTP Response objects.
*/

/** JSON body for a failed HTTP tool invocation. */
export interface ApiToolCallErrorBody {
  error: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}

/** Strips ANSI escape sequences from CLI-formatted text. */
export function stripAnsi(text: string): string {
  const ansiEscape = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
  return text.replace(ansiEscape, "");
}

/** Returns the first non-empty line of text with ANSI escapes removed. */
export function firstErrorLine(text: string): string {
  const line = stripAnsi(text)
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  return line ?? stripAnsi(text).trim();
}

/** Wide-open CORS headers applied to all API responses. */
export const API_CORS_HEADERS: Readonly<Record<string, string>> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers": "Content-Type, Authorization",
  "access-control-max-age": "86400",
};

/** Builds a 204 OPTIONS preflight response with CORS headers. */
export function apiOptionsResponse(): Response {
  return new Response(null, { status: 204, headers: { ...API_CORS_HEADERS } });
}

/** Builds Swagger UI HTML that loads one exact OpenAPI discovery document. */
export function apiDocsHtml(openApiUrl = "/openapi.json"): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>API Reference</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css" />
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js" crossorigin></script>
  <script>
    SwaggerUIBundle({
      url: ${JSON.stringify(openApiUrl)},
      dom_id: "#swagger-ui",
    });
  </script>
</body>
</html>`;
}

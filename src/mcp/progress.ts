/*
Shares the package-internal marker that starts HTTP MCP progress delivery.
Tool and task handlers call the same arming helper after their guards allow the invocation.
*/

/** Framework-private property used to arm one HTTP MCP progress reporter. */
export const MCP_HANDLER_STARTED = Symbol("argsbarg.mcp-handler-started");

/** Arms buffered HTTP progress only after MCP guard work reaches a provider handler. */
export function markMcpHandlerStarted(locals: object): void {
  const reportProgress = (locals as Record<string, unknown>).reportProgress;
  if (typeof reportProgress !== "function") return;
  const arm = (reportProgress as unknown as Record<PropertyKey, unknown>)[MCP_HANDLER_STARTED];
  if (typeof arm === "function") arm();
}

/*
The package's single public entry point.
It exposes the v9 declaration builders, invocation contracts, configuration helper,
runtime factory, and distribution tools.
*/

export type { SchemaExport } from "./builtins/export.ts";
export { resolveConfigDir } from "./core/config-dir.ts";
export { AppError } from "./core/errors.ts";
export {
  InputError,
  parseDocumentText,
  preloadPipableJson,
} from "./core/leaf-inputs.ts";
export type {
  Denial,
  Guard,
  GuardResult,
  InvocationBase,
  InvocationContext,
  InvocationSource,
  MaybePromise,
  NameView,
  OperationGuard,
  Surface,
} from "./core/invocation.ts";
export { allow, deny } from "./core/invocation.ts";
export type { SchemaRootExport } from "./core/schema.ts";
export type {
  AppHooks,
  AppSpec,
  AppSpecFields,
  ChildAppMount,
  ChildSurface,
  CliAppConfig,
  CliExposureConfig,
  ClientErrorOverride,
  Command,
  CommandBase,
  CommandDef,
  CommandGroup,
  CommandHandlerContext,
  CommandInputs,
  CommandInputsOf,
  CommandKind,
  CommandOption,
  CommandOptionInputs,
  CommandOptionValueOf,
  CommandPathParamsOf,
  CommandPositional,
  CommandPositionalInputs,
  CommandResultOf,
  CompletionConfig,
  ErrorHookContext,
  HttpAppConfig,
  HttpMethod,
  HttpWireContext,
  HttpWireHooks,
  InvokeFailureKind,
  InvokeHookContext,
  InvokeHookResult,
  JsonRpcAppConfig,
  JsonSchema,
  Locals,
  LogConfig,
  McpAppConfig,
  McpBundleConfig,
  RunnableCommand,
} from "./core/types.ts";
export {
  command,
  FallbackMode,
  isDocumentCommand,
  OptionKind,
  SchemaValidationError,
  ValueFormat,
} from "./core/types.ts";
export { isInteractiveTty } from "./core/utils.ts";
export { schemaStrictnessWarnings } from "./core/validate.ts";
export type {
  HttpNativeRouteDeclaration,
  HttpRouteDeclaration,
  HttpRouteResponse,
  HttpRouteResponseDefaults,
  HttpRouteSpec,
} from "./http/routes.ts";
export { route } from "./http/routes.ts";
export type {
  JsonRpcMethod,
  JsonRpcMethodSpec,
  JsonRpcResultOf,
} from "./json-rpc/declaration.ts";
export { method } from "./json-rpc/declaration.ts";
export type {
  McpHttpConfig,
  McpHttpMiddleware,
  McpHttpMiddlewareContext,
  McpHttpMiddlewareResult,
} from "./mcp/http.ts";
export type {
  McpToolSpec,
} from "./mcp/registry.ts";
export { tool } from "./mcp/registry.ts";
export type { McpBundlePaths, PackMcpBundleOpts } from "./mcp/pack/bundle.ts";
export { defaultMcpBundlePaths, generateMcpManifest, packMcpBundle } from "./mcp/pack/bundle.ts";
export {
  defaultClaudePluginPaths,
  generatePluginManifest,
  generatePluginMcpJson,
  packClaudePlugin,
} from "./mcp/pack/claude.ts";
export {
  defaultCursorPluginPaths,
  generateCursorPluginManifest,
  generateCursorPluginMcpJson,
  packCursorPlugin,
} from "./mcp/pack/cursor.ts";
export type {
  EcsLogEvent,
  EcsLogLevel,
  EcsServiceFields,
  FormatEcsLineOpts,
  LogEnrichContext,
} from "./log/ecs.ts";
export { ECS_VERSION, formatEcsLine } from "./log/ecs.ts";
export type { ResolvedLogConfig } from "./log/emitter.ts";
export type { ErrorReporter, ErrorReporterOptions, ErrorReportLevel } from "./log/error-report.ts";
export { createErrorReporter } from "./log/error-report.ts";
export { type App, argsbarg, type CliInvokeResult } from "./runtime/cli.ts";

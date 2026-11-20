/*
This module defines the CLI schema, option kinds, and fallback modes.
It is the shared declarative model that parsing, validation, help, and completion all
read from, so the package has one source of truth.
*/

import type { z } from "zod";
import type { HttpRouteRegistration } from "../http/routes.ts";
import type { JsonRpcMethodMetadata } from "../json-rpc/declaration.ts";
import type { McpHttpConfig } from "../mcp/http.ts";
import type { McpToolRegistration } from "../mcp/registry.ts";
import type { App } from "../runtime/cli.ts";
import type { Guard, InvocationContext, OperationGuard } from "./invocation.ts";
import { toJsonSchema } from "./zod-schema.ts";

/**
 * How a command handler was dispatched.
 */
export type Invocation = "cli" | "mcp" | "http";

/** Coerced command values keyed by authored option and positional names. */
export type CommandInputs = Record<string, boolean | number | string | string[] | unknown | undefined>;

/**
 * Option kinds: presence (boolean flag), string (free-form text), number (strict double), enum (fixed choices), or json (parsed JSON object/array).
 */
export const OptionKind = {
  /** Boolean flag: no value token (may be implicit `"1"` when set). */
  Presence: "presence",
  /** Free-form string value. */
  String: "string",
  /** Strict floating-point value (parsed at validation time). */
  Number: "number",
  /** Fixed set of allowed string values. Requires non-empty `choices` on the option. */
  Enum: "enum",
  /** JSON object or array (parsed from `--name '<json>'`, piped stdin when `pipable`, or MCP/API tool body). */
  Json: "json",
} as const;

/** Union of the `OptionKind` values. */
export type OptionKind = (typeof OptionKind)[keyof typeof OptionKind];

/**
 * Named validation/coercion for string options (`format` on `CommandOption`).
 * Positionals do not use `format`; varargs use space-separated CLI tokens and JSON arrays over MCP.
 */
export const ValueFormat = {
  /** Duration text such as `30s`, `20m`, `1h`, `2d` (default unit minutes when omitted). */
  Duration: "duration",
  /** Comma-separated list on a single option value (`--services a,b`). */
  CommaList: "comma-list",
  /** Calendar date `YYYY-MM-DD`. */
  Date: "date",
  /** RFC 3339 instant with `Z` or numeric offset. */
  DateTime: "date-time",
} as const;

/** Union of the `ValueFormat` values. */
export type ValueFormat = (typeof ValueFormat)[keyof typeof ValueFormat];

/**
 * When `fallbackCommand` is used for missing or unknown subcommand tokens at a routing node.
 */
export const FallbackMode = {
  /**
   * If argv has no next subcommand, route to `fallbackCommand`; if the token is unknown, error.
   */
  MissingOnly: "missingOnly",
  /**
   * If argv has no next subcommand or the token is not a known child, route to `fallbackCommand`.
   */
  MissingOrUnknown: "missingOrUnknown",
  /**
   * If the next token is present but not a known child, route to `fallbackCommand`.
   * When the subcommand token is missing (exhausted argv), do not use fallback (implicit scoped help).
   */
  UnknownOnly: "unknownOnly",
} as const;

/** Union of the `FallbackMode` values. */
export type FallbackMode = (typeof FallbackMode)[keyof typeof FallbackMode];

/**
 * Per-surface CLI exposure (help, completions, cli-schema).
 */
export interface CliExposureConfig {
  /** When `false`, not callable via CLI (cascades to descendants). Default: true. */
  enabled?: boolean;
  /** Callable; omit from help, completions, and schema export. */
  hidden?: boolean;
  completions?: { enabled?: boolean; hidden?: boolean };
  schema?: { enabled?: boolean; hidden?: boolean };
}

/** HTTP method for REST commands. */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * A named flag or value option (`--long`, `-short`), listed on command `options`.
 */
export interface CommandOption {
  /** Option name (e.g., "name", "verbose"). */
  name: string;
  /** Per-surface CLI exposure for this option. */
  cli?: Pick<CliExposureConfig, "hidden">;
  /** Description shown in help. */
  description: string;
  /** Option kind: presence flag, string value, or number value. */
  kind: OptionKind;
  /** Short option character (e.g., 'n' for -n). */
  shortName?: string;
  /** Whether this option must be provided. Cannot be used with Presence kind. */
  required?: boolean;
  /**
   * Allowed values. Required when kind === Enum; ignored otherwise.
   * Must be a non-empty array of distinct non-empty strings.
   */
  choices?: readonly string[];
  /**
   * Named string validation for `kind: String` options. Mutually exclusive with `pattern`.
   * Not supported on positionals.
   */
  format?: ValueFormat;
  /** Default value applied in post-parse when the option is omitted. */
  default?: string;
  /** Regex pattern for string options. Mutually exclusive with `format`. */
  pattern?: string;
  /**
   * When `true` on a `Json` option, CLI may omit `--name` and supply JSON via stdin instead.
   * If `--name` is set, the flag value wins and stdin is not read.
   */
  pipable?: boolean;
}

/**
 * An ordered positional argument slot, listed on command `positionals`.
 */
export interface CommandPositional {
  /** Positional name (used in help and error messages). */
  name: string;
  /** Description shown in help. */
  description: string;
  /** Value kind for each consumed token. */
  kind: OptionKind;
  /**
   * Minimum number of values required (default 1).
   * Use `0` for an optional slot when paired with `argMax: 1`, or a varargs tail with `argMax: 0`.
   */
  argMin?: number;
  /**
   * Maximum number of values (`1` = a single required or optional word; default 1). Use `0` for an
   * unbounded varargs tail (must be the last slot in the command’s `positionals` list).
   */
  argMax?: number;
}

/** MCP bundle and plugin packaging metadata. */
export interface McpBundleConfig {
  author?: {
    name: string;
    email?: string;
    url?: string;
  };
  /** Human-readable display name for plugin manifests. */
  displayName?: string;
  /** Homepage URL for plugin manifests. */
  homepage?: string;
  /** Repo-relative path to a PNG icon copied into the bundle. */
  icon?: string;
  /** Software license identifier (e.g. "MIT", "Apache-2.0"). */
  license?: string;
  /** Manifest `long_description` (defaults to program description). */
  longDescription?: string;
  /** Repository URL for plugin manifests. */
  repository?: string;
  /** Custom relative path to repository skills directory (defaults to `skills/<dirName>`). */
  skillsDir?: string;
}

/** Emitted JSON Schema object (produced from Zod schemas by argsbarg; used by MCP, OpenAPI, help, and export). */
export type JsonSchema = Record<string, unknown>;

/** Wire-level HTTP hooks (observe-only; all requests including health and 404s). */
export interface HttpWireHooks {
  onRequest?: (ctx: HttpWireContext) => void | Promise<void>;
  onResponse?: (ctx: HttpWireContext & { status: number; durationMs: number }) => void | Promise<void>;
  onError?: (ctx: HttpWireContext & { failureKind: InvokeFailureKind; error: unknown }) => void | Promise<void>;
}

/** Per-request HTTP wire context for {@link HttpWireHooks}. */
export interface HttpWireContext {
  request: Request;
  requestId: string;
  clientIp: string;
  path: string;
  method: string;
  /** W3C trace id when `traceparent` is present on the request. */
  traceId?: string;
  /** Span id for this server hop when `traceparent` is present. */
  spanId?: string;
}

/** Opt-out for the `completion` built-in (default: enabled). */
export interface CompletionConfig {
  /** When `false`, hide/disable `completion` (default: enabled). */
  enabled?: boolean;
}

/**
 * Base properties shared by all nodes in the user command tree.
 */
export interface CommandBase {
  /** App or command key (e.g., "myapp", "stat", "owner"). */
  key: string;
  /** Per-surface CLI exposure. */
  cli?: CliExposureConfig;
  /** Short description shown in help. */
  description: string;
  /** Additional notes shown in help (`{argsbarg:program}` → program key). */
  notes?: string;
  /** Global or command-level flags/options. */
  options?: readonly CommandOption[];
}

/** Command input mode: `document` = structured JSON document body (no CLI flags). */
export type CommandKind = "document";

/** Handler `ctx.inputs` type for a command: the schema's parsed output, or coerced option/positional values. */
export type CommandInputsOf<I> = [I] extends [z.ZodType] ? z.output<I> : CommandInputs;

/** Parsed output type for one declared CLI path-parameter schema. */
export type CommandPathParamsOf<P> = [P] extends [z.ZodObject] ? z.output<P> : Record<string, string>;

/** Declared path fields merged into flat handler inputs; undeclared captures are runtime-only. */
type FlatCommandPathInputs<P> = [P] extends [z.ZodObject] ? z.output<P> : Record<never, never>;

/** Handler return type for a command: the output schema's type (or nothing), or `unknown` without an output schema. */
export type CommandResultOf<O> = [O] extends [z.ZodType] ? z.output<O> | void : unknown;

/** Direct transport-neutral context supplied to every command handler. */
export type CommandHandlerContext<Input, Seed extends object = Locals> = InvocationContext<Input, Seed>;

/** Shallow merge preserving command operation-guard additions. */
type MergeCommandLocals<Seed extends object, Added extends object> = {
  [Key in keyof Seed | keyof Added]: Key extends keyof Added
    ? Added[Key]
    : Key extends keyof Seed
      ? Seed[Key]
      : never;
};

/** Contextually typed operation guard accepted by the command builder. */
type CommandBuilderGuard<Input, Seed extends object, Added extends object> =
  | Guard<Input, Seed, Added>
  | {
      /** Selects command-owned replacement of the CLI surface guard. */
      readonly mode: "override";
      /** Replacement guard evaluated from the CLI seed. */
      readonly run: Guard<Input, Seed, Added>;
    }
  | "public";

/**
 * Command guard with method-bivariance so concrete parsed inputs can join a heterogeneous command tree.
 * The callback still receives the exact declared input and locals context.
 */
type CommandGuard<Input, Seed extends object> = {
  bivarianceHack(
    /** Parsed command inputs and the current invocation locals. */
    context: InvocationContext<Input, Seed>,
  ): ReturnType<Guard<Input, Seed, object>>;
}["bivarianceHack"];

/**
 * A command that runs a handler (with optional positionals).
 * Use {@link command} to get `ctx.inputs` and the return value typed from `inputSchema` / `outputSchema`.
 */
export type RunnableCommand<
  I extends z.ZodType | undefined = z.ZodType | undefined,
  O extends z.ZodType | undefined = z.ZodType | undefined,
  P extends z.ZodObject | undefined = z.ZodObject | undefined,
  Seed extends object = Locals,
  Added extends object = Record<never, never>,
> = CommandBase & {
  /**
   * When `"document"`, the command accepts a single JSON document
   * (CLI positional or piped stdin; MCP/HTTP tool args = body). Requires `inputSchema`;
   * forbids `options` and `positionals`.
   */
  kind?: CommandKind;
  /** Handler (method syntax so typed commands fit in heterogeneous `commands` arrays). */
  handler(
    ctx: CommandHandlerContext<CommandInputsOf<I> & FlatCommandPathInputs<P>, MergeCommandLocals<Seed, Added>>,
  ): CommandResultOf<O> | Promise<CommandResultOf<O>>;
  /** Optional command-owned supplement, replacement, or public marker. */
  guard?: OperationGuard<CommandGuard<CommandInputsOf<I> & FlatCommandPathInputs<P>, Seed>>;
  /** Positional argument definitions. */
  positionals?: readonly CommandPositional[];
  /**
   * Zod schema for structured stdout (e.g. with `--json` or MCP when the handler emits JSON).
   * Emitted in CLI schema export and used for direct handler return inference.
   */
  outputSchema?: O;
  /**
   * Zod schema for tool arguments and merged CLI inputs. Validated before the handler runs;
   * the parsed value becomes `ctx.inputs`.
   */
  inputSchema?: I;
  /**
   * Zod object schema for the `:param` segments above this command (keys = param names without `:`). Validated
   * before the handler; parsed path fields merge into `ctx.inputs`.
   */
  pathParams?: P;
};

/**
 * A routing command node with nested subcommands.
 */
export type CommandGroup = CommandBase & {
  /** Nested subcommands. */
  commands: Command[];
  /** Default subcommand when argv omits a command or uses an unknown token at this routing node. */
  fallbackCommand?: string;
  /** How fallbackCommand is applied at this routing node. */
  fallbackMode?: FallbackMode;
};

/**
 * A command in the tree: runnable (`handler`) or a group of subcommands (`commands`).
 */
export type Command = RunnableCommand | CommandGroup;

/** Classified failure kind for invoke error pipeline and HTTP/MCP status mapping. */
export type InvokeFailureKind = "validation" | "help" | "unexpected" | "unknown_route";

/**
 * Per-invocation context attached in hooks (e.g. DB handles, auth principals).
 * Augment in app code: `declare module "argsbarg" { interface Locals { db: AppDb } }`.
 */
export interface Locals {
  /** Correlation id seeded before hooks run (HTTP/MCP wire id or generated UUID). */
  requestId?: string;
}

/** Context for app-level invoke hooks (CLI, HTTP, MCP user commands). */
export interface InvokeHookContext {
  /** Native surface selected for this invocation. */
  surface: import("./invocation.ts").Surface;
  /** Exact cancellation signal retained by the invocation. */
  signal: AbortSignal;
  /** Routed declaration path. */
  path: string[];
  /** Read-only raw binding summary retained before validation. */
  rawInputs: Readonly<Record<string, unknown>>;
  /** Per-invocation bag; `beforeInvoke` may write. Framework seeds `requestId` before hooks run. */
  locals: Locals;
}

/** Error hook context after failure classification. */
export interface ErrorHookContext extends InvokeHookContext {
  failureKind: InvokeFailureKind;
  error: unknown;
  /** Default client-facing error before `formatError` override. */
  clientError: ClientErrorOverride;
}

/** Client-facing error payload; `formatError` may return a partial override. */
export interface ClientErrorOverride {
  message: string;
  exitCode?: number;
}

/** Minimal invoke result passed to `afterInvoke` (see {@link App.invoke}). */
export interface InvokeHookResult {
  kind: "ok" | "help" | "error";
  exitCode: number;
  failureKind?: InvokeFailureKind;
  errorMsg?: string;
}

/** App-level invoke and error hooks (skipped for builtins). */
export interface AppHooks {
  /** May attach app-owned values to the fresh locals bag before validation. */
  beforeInvoke?: (ctx: InvokeHookContext) => void | Promise<void>;
  afterInvoke?: (ctx: InvokeHookContext & { result: InvokeHookResult }) => void | Promise<void>;
  /** Mutate client-facing error payload only. Runs before `onError`. */
  formatError?: (ctx: ErrorHookContext) => ClientErrorOverride | undefined | Promise<ClientErrorOverride | undefined>;
  /** Observe only — runs after `formatError`; may enrich `locals`. Never mutates client response. */
  onError?: (ctx: ErrorHookContext) => void | Promise<void>;
}

/** Framework logging defaults (ECS Logging json or human text on stderr). */
export interface LogConfig {
  /** `json` = ECS Logging lines; `text` = human stderr lines. Default: `json`. */
  format?: "json" | "text";
  /** Tee stderr + append; relative paths resolve against the working directory. */
  file?: string;
  /** Emit HTTP/MCP access logs. Default: true. */
  access?: boolean;
  /** Emit error events after the hook pipeline. Default: true. */
  errors?: boolean;
  /**
   * Add non-standard fields to each JSON log line after the ECS baseline.
   * Cannot override `@timestamp`, `log.level`, `message`, `ecs.version`, or service fields.
   */
  enrich?: (ctx: import("../log/ecs.ts").LogEnrichContext) => Record<string, unknown>;
  /**
   * Full control over JSON log line serialization. When set, bypasses the built-in ECS formatter.
   * The consumer owns the entire line (including newline omission).
   */
  serialize?: (ctx: import("../log/ecs.ts").LogEnrichContext) => string;
}

/** Policy applied to user-authored CLI leaves before command guards. */
export interface CliAppConfig<Seed extends object = Locals> {
  /** Optional CLI surface guard compiled into every native CLI declaration. */
  readonly guard?: Guard<unknown, Seed, object>;
}

/** Independent native REST registration exposed by the app factory. */
export interface HttpAppConfig {
  /** Explicit REST routes consumed by one fixed catalog. */
  readonly routes: readonly HttpRouteRegistration[];
  /** Optional HTTP surface guard compiled before operation guards. */
  readonly guard?: import("./invocation.ts").Guard<unknown, Locals, object>;
  /** Optional listener host overriding the loopback default. */
  readonly host?: string;
  /** Optional listener port overriding `3000`. */
  readonly port?: number;
  /** Whether wire hooks may use forwarded client-address headers. */
  readonly trustProxy?: boolean;
  /** Observe-only hooks for REST requests. */
  readonly hooks?: HttpWireHooks;
}

/** Independent native JSON-RPC registration exposed by the app factory. */
export interface JsonRpcAppConfig {
  /** Exact registered RPC method declarations in discovery order. */
  readonly methods: readonly JsonRpcMethodMetadata[];
  /** Optional RPC surface guard compiled before operation guards. */
  readonly guard?: import("./invocation.ts").Guard<unknown, Locals, object>;
}

/** Independent native MCP registration exposed by the app factory. */
export interface McpAppConfig<Seed extends object = Locals> {
  /** Heterogeneous immutable tool registrations supplied to one registry. */
  readonly tools: readonly McpToolRegistration<Seed>[];
  /** Optional MCP surface guard compiled before every tool operation guard. */
  readonly guard?: Guard<unknown, Seed, object>;
  /** Optional app-owned provider for MCP Tasks follow-up operations. */
  readonly tasks?: import("../mcp/tasks.ts").McpTaskProvider<Seed>;
  /** Package-internal HTTP transport boundary with one public middleware callback. */
  readonly http?: McpHttpConfig<Seed>;
  /** Optional instructions returned by MCP discovery. */
  readonly instructions?: string;
  /** Optional bundle and plugin packaging metadata. */
  readonly bundle?: McpBundleConfig;
  /** Package a Claude Desktop `.mcpb` bundle. */
  readonly mcpd?: boolean;
  /** Package a Claude Code plugin archive. */
  readonly claudePlugin?: boolean;
  /** Package a Cursor plugin archive. */
  readonly cursorPlugin?: boolean;
}

/** Native app surface that one mounted child may expose. */
export type ChildSurface = "cli" | "http" | "jsonRpc" | "mcp";

/** One build-time child app mount copied into the parent's fixed declaration catalogs. */
export interface ChildAppMount {
  /** Already-built child app snapshotted while the parent is constructed. */
  readonly app: App;
  /** Exact child surfaces to expose, or every configured child surface when omitted. */
  readonly expose?: readonly ChildSurface[];
}

/**
 * App spec passed to `argsbarg()`.
 * May be a command or command group, plus optional app-level MCP and HTTP config.
 */
export type AppSpec = Command & AppSpecFields;

/** Root settings shared by grouping and runnable roots (see {@link AppSpec} and `argsbarg()`). */
export type AppSpecFields = {
  /** Build-time keyed child app snapshots composed into the parent's fixed catalogs. */
  readonly children?: Readonly<Record<string, ChildAppMount>>;
  /** User-authored CLI policy; generated mirror commands keep their target surface policy. */
  cli?: CliAppConfig<Locals>;
  /** Opt-out for shell completion generation (`completion bash|zsh|fish`). */
  completion?: CompletionConfig;
  /** Reports unexpected command failures (CLI, HTTP, MCP) to a Sentry-compatible collector; see `createErrorReporter`. */
  errorReporter?: import("../log/error-report.ts").ErrorReporter;
  /** Invoke and error hooks for user commands on CLI, HTTP, and MCP. */
  hooks?: AppHooks;
  /** Independently declared REST surface and fixed route catalog inputs. */
  http?: HttpAppConfig;
  /** Independently declared JSON-RPC methods and fixed OpenRPC catalog inputs. */
  jsonRpc?: JsonRpcAppConfig;
  /** Framework logging (stderr + optional file). */
  log?: LogConfig;
  /** Independently declared MCP 2026 tools and discovery inputs. */
  mcp?: McpAppConfig<Locals>;
  /** App version (printed by the `version` built-in and MCP serverInfo). */
  version: string;
};

/** True when the command runs a handler. */
export function hasHandler(node: Command): node is RunnableCommand {
  return "handler" in node && typeof node.handler === "function";
}

/** True when the command accepts a structured JSON document body (no CLI flags). */
export function isDocumentCommand(
  /** Command to inspect. */
  leaf: RunnableCommand,
): boolean {
  return leaf.kind === "document";
}

/** True when the node is a command group (has subcommands). */
export function hasSubcommands(node: Command): node is CommandGroup {
  return "commands" in node && Array.isArray(node.commands);
}

/** Emitted JSON Schema for the command's structured stdout, when it declares an `outputSchema`. */
export function leafOutputSchema(leaf: RunnableCommand): JsonSchema | undefined {
  return leaf.outputSchema === undefined ? undefined : toJsonSchema(leaf.outputSchema, "output");
}

/** Emitted JSON Schema for the command's `inputSchema`, when set. */
export function leafInputSchema(leaf: RunnableCommand): JsonSchema | undefined {
  return leaf.inputSchema === undefined ? undefined : toJsonSchema(leaf.inputSchema, "input");
}

/**
 * Declares a command. With a `handler` it runs: `ctx.inputs` is typed from its `inputSchema` (or its `options` /
 * `positionals` literals), `ctx.pathParams` from `pathParams`, and the return value from `outputSchema`. With
 * `commands` it groups subcommands and keeps its literal type. Identity at runtime.
 */
export function command<Seed extends object = Locals>(): CommandBuilder<Seed>;
export function command<const T extends CommandGroup>(
  /** Command that groups subcommands. */
  group: T,
): NoInfer<T>;
export function command<
  I extends z.ZodType | undefined = undefined,
  O extends z.ZodType | undefined = undefined,
  P extends z.ZodObject | undefined = undefined,
  const Opts extends readonly CommandOption[] = [],
  const Pos extends readonly CommandPositional[] = [],
  const Added extends object = Record<never, never>,
>(
  /** Command that runs a handler. */
  runnable: CommandDef<I, O, P, Opts, Pos, Locals, Added>,
  // NoInfer: generics come from the definition, never from where the result is used (e.g. a `commands` array).
): RunnableCommand<NoInfer<I>, NoInfer<O>, NoInfer<P>, Locals, Added>;
export function command(
  /** Command definition. */
  node?: Command,
): Command | CommandBuilder<Locals> {
  if (node === undefined) return buildCommand as CommandBuilder<Locals>;
  return node;
}

/** Call signatures returned by an extracted, seed-typed command builder. */
interface CommandBuilder<Seed extends object> {
  <const T extends CommandGroup>(
    /** Command that groups subcommands. */
    group: T,
  ): NoInfer<T>;
  <
    I extends z.ZodType | undefined = undefined,
    O extends z.ZodType | undefined = undefined,
    P extends z.ZodObject | undefined = undefined,
    const Opts extends readonly CommandOption[] = [],
    const Pos extends readonly CommandPositional[] = [],
    const Added extends object = Record<never, never>,
  >(
    /** Command that runs a handler. */
    runnable: CommandDef<I, O, P, Opts, Pos, Seed, Added>,
  ): RunnableCommand<NoInfer<I>, NoInfer<O>, NoInfer<P>, Seed, Added>;
}

/** Extracted command builder implementation shared by each selected seed type. */
function buildCommand(
  /** Command declaration preserved by identity. */
  node: Command,
): Command {
  return node;
}

/**
 * Runnable command definition accepted by {@link command}: a {@link RunnableCommand} whose `options` / `positionals` literals
 * type `ctx.inputs` when there is no `inputSchema` (see {@link CommandOptionInputs}).
 */
export type CommandDef<
  I extends z.ZodType | undefined,
  O extends z.ZodType | undefined,
  P extends z.ZodObject | undefined,
  Opts extends readonly CommandOption[],
  Pos extends readonly CommandPositional[],
  Seed extends object = Locals,
  Added extends object = Record<never, never>,
> = Omit<RunnableCommand<I, O, P, Seed>, "handler" | "options" | "positionals" | "guard"> & {
  /** Command-local flags/options (their literal types drive `ctx.inputs` typing). */
  options?: Opts;
  /** Positional argument definitions (their literal types drive `ctx.inputs` typing). */
  positionals?: Pos;
  /** Optional command-owned supplement, replacement, or public marker. */
  guard?: CommandBuilderGuard<
    ([I] extends [z.ZodType] ? z.output<I> : CommandOptionInputs<Opts> & CommandPositionalInputs<Pos>) &
      FlatCommandPathInputs<P>,
    Seed,
    Added
  >;
  /** Handler function. */
  handler(
    ctx: CommandHandlerContext<
      ([I] extends [z.ZodType] ? z.output<I> : CommandOptionInputs<Opts> & CommandPositionalInputs<Pos>) &
        FlatCommandPathInputs<P>,
      MergeCommandLocals<Seed, Added>
    >,
  ): CommandResultOf<O> | Promise<CommandResultOf<O>>;
};

/** Value type `ctx.inputs` holds for one option definition (after argsbarg's coercion). */
export type CommandOptionValueOf<Opt extends CommandOption> = Opt extends { kind: typeof OptionKind.Presence }
  ? boolean
  : Opt extends { kind: typeof OptionKind.Number }
    ? number
    : Opt extends { kind: typeof OptionKind.Enum; choices: readonly (infer C)[] }
      ? C
      : Opt extends { kind: typeof OptionKind.Json }
        ? unknown
        : Opt extends { format: typeof ValueFormat.Duration }
          ? number
          : Opt extends { format: typeof ValueFormat.CommaList }
            ? string[]
            : string;

/** True when an option always has a value in `ctx.inputs` (presence flags, `required`, or a `default`). */
type OptionAlwaysSet<Opt> = Opt extends { kind: typeof OptionKind.Presence }
  ? true
  : Opt extends { required: true }
    ? true
    : Opt extends { default: string }
      ? true
      : false;

/** `ctx.inputs` shape for a command's own options (root and ancestor options are present at runtime but untyped). */
export type CommandOptionInputs<Opts extends readonly CommandOption[]> = {
  [Opt in Opts[number] as OptionAlwaysSet<Opt> extends true ? Opt["name"] : never]: CommandOptionValueOf<Opt>;
} & {
  [Opt in Opts[number] as OptionAlwaysSet<Opt> extends true ? never : Opt["name"]]?: CommandOptionValueOf<Opt>;
};

/** Value type for one positional slot: a single word, or a `string[]` for multi-value / varargs slots. */
type PositionalValueOf<Pos extends CommandPositional> = Pos extends { argMax: number }
  ? Pos["argMax"] extends 1
    ? string
    : string[]
  : string;

/** True when a positional always has a value (single slot with `argMin` ≥ 1, the default). */
type PositionalAlwaysSet<Pos> = Pos extends { argMin: 0 } ? false : true;

/** `ctx.inputs` shape for a command's positionals. */
export type CommandPositionalInputs<Pos extends readonly CommandPositional[]> = {
  [Slot in Pos[number] as PositionalAlwaysSet<Slot> extends true ? Slot["name"] : never]: PositionalValueOf<Slot>;
} & {
  [Slot in Pos[number] as PositionalAlwaysSet<Slot> extends true ? never : Slot["name"]]?: PositionalValueOf<Slot>;
};

/**
 * Error thrown when the static CLI tree violates ArgsBarg rules.
 */
export class SchemaValidationError extends Error {
  /** Creates a schema validation error with a human-readable rule violation. */
  constructor(message: string) {
    super(message);
    this.name = "SchemaValidationError";
  }
}

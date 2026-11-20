/*
Runtime entry point: validate program, cache derived state, run / invoke / MCP serve.
*/

import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { builtinInterceptRoot, dispatchBuiltin } from "../builtins/dispatch.ts";
import { cliParseRoot, cliPresentationRoot } from "../builtins/presentation.ts";
import { bindCliCommand, type CliBoundCommand, processEnvView } from "../cli/bind.ts";
import { type CliCallWriter, encodeCliOutcome, presentCliCall } from "../cli/encode.ts";
import type { CliCallResult, CliFailedCallResult } from "../cli/mirror.ts";
import { decodeDocument, type DocumentFormat } from "../core/document.ts";
import type { BoundDeclaration, Guard, InvocationContext, InvocationOutcome } from "../core/invocation.ts";
import { InputError, preloadPipableJson } from "../core/leaf-inputs.ts";
import { collectPathOptionDefs, ParseKind, type ParseResult, parse, postParseValidate } from "../core/parse.ts";
import { type SchemaRootExport, schemaExport } from "../core/schema.ts";
import type {
  AppSpec,
  AppSpecFields,
  Command,
  CommandDef,
  CommandGroup,
  CommandOption,
  CommandPositional,
  InvokeFailureKind,
  Locals,
  RunnableCommand,
} from "../core/types.ts";
import { hasHandler, hasSubcommands } from "../core/types.ts";
import { cliValidateProgram } from "../core/validate.ts";
import { runtimeLeafInputSchema } from "../core/zod-schema.ts";
import { bindHttpCall } from "../http/bind.ts";
import { createHttpMirror, type HttpMirrorEntries } from "../http/mirror.ts";
import { createHttpMount } from "../http/mount.ts";
import { createHttpCatalog, type HttpRouteCatalog } from "../http/routes.ts";
import { createJsonRpcCatalog, type JsonRpcCatalog } from "../json-rpc/catalog.ts";
import { createJsonRpcHttpMount } from "../json-rpc/http.ts";
import { createJsonRpcMirror, type JsonRpcMirrorEntries, type JsonRpcMirrorInput } from "../json-rpc/mirror.ts";
import { createMcpHttpMount } from "../mcp/http.ts";
import { createMcpCliCalls, type McpCliCallInput, type McpCliCalls } from "../mcp/mirror.ts";
import { createMcpRegistry, type McpRegistry } from "../mcp/registry.ts";
import { serveMcpStdio } from "../mcp/stdio.ts";
import { type HttpMount, startHttpListener } from "../server/listener.ts";
import { resolveHttpServeConfig, type ServeOverrides } from "../server/overrides.ts";
import { assertBuiltinAllowed, type Capabilities, resolveCapabilities } from "./capabilities.ts";
import {
  assertNoChildCollisions,
  type ChildCollisionFact,
  type ChildSnapshot,
  childCliSnapshotForPath,
  composeChildCliCommands,
  composeChildren,
  scopeChildInvocation,
} from "./children.ts";
import { cliHelpRender } from "./help.ts";
import {
  buildBoundInvokeHookContext,
  classifyFailureKind,
  isBuiltinInvokePath,
  registerInvocationHooks,
  runErrorPipeline,
  runHook,
  runInvocationHookLifecycle,
} from "./hooks.ts";
import { createFrameworkHealthMount, type HttpServiceName } from "./health.ts";
import { type InvocationScope, runInInvocationScope } from "./invocation-scope.ts";
import { compileGuardPlan, invokeBound } from "./invoke.ts";

/** Outcome of a non-exiting CLI invocation. */
export type CliInvokeKind = "ok" | "help" | "error";

/** Result of App.invoke: captured output and exit metadata without process.exit. */
export interface CliInvokeResult {
  kind: CliInvokeKind;
  exitCode: number;
  stdout: string;
  stderr: string;
  errorMsg?: string;
  /** Classified failure for HTTP/MCP status mapping. */
  failureKind?: InvokeFailureKind;
}

class CliInvokeExit extends Error {
  readonly code: number;

  constructor(code: number) {
    super(`process.exit(${code})`);
    this.name = "CliInvokeExit";
    this.code = code;
  }
}

interface PreparedDispatch {
  pr: ParseResult;
  parseRoot: Command;
  completionParseRoot: CommandGroup;
  isLeafCompletionIntercept: boolean;
  leaf: RunnableCommand;
}

/** Runtime-erased registered CLI declaration retained for one immutable leaf identity. */
interface CliCatalogEntry {
  /** D2 declaration containing the one synthesized schema and empty CLI plan. */
  readonly declaration: BoundDeclaration<z.ZodType, unknown, Locals>;
  /** Child or parent lifecycle hooks owned by this exact declaration. */
  readonly hooks?: import("../core/types.ts").AppHooks;
  /** Child or parent reporter owned by this exact declaration. */
  readonly errorReporter?: AppSpec["errorReporter"];
  /** Mounted child credential scope, or `undefined` for the parent declaration. */
  readonly source?: import("./children.ts").ChildSourceScope;
}

/** Parsed D35 relay flags shared by all generated CLI calls. */
interface CliMirrorArguments {
  /** Format for the piped input and structured result. */
  readonly format: DocumentFormat;
  /** Explicit relay URL, or `undefined` for direct local registration. */
  readonly relay?: URL;
  /** Sanitized case-insensitive-unique explicit relay headers. */
  readonly headers: readonly (readonly [string, string])[];
  /** Generated selector positionals after option removal. */
  readonly positionals: readonly string[];
}

/** Builds the one flat runtime program while leaving the author's parent spec unchanged. */
function composeRuntimeProgram(program: AppSpec, children: ChildSnapshot): AppSpec {
  assertNoParentChildCollisions(program, children);
  const childCommands = composeChildCliCommands(children);
  if (childCommands.length > 0 && !hasSubcommands(program)) {
    throw new TypeError("Child CLI mounts require a grouped parent CLI root");
  }
  const httpConfigured = program.http !== undefined || children.surfaces.includes("http");
  const rpcConfigured = program.jsonRpc !== undefined || children.surfaces.includes("jsonRpc");
  const mcpConfigured = program.mcp !== undefined || children.surfaces.includes("mcp");
  return Object.freeze({
    ...program,
    ...(hasSubcommands(program)
      ? { commands: Object.freeze([...program.commands, ...childCommands]) }
      : {}),
    ...(httpConfigured
      ? {
          http: Object.freeze({
            ...(program.http ?? {}),
            routes: Object.freeze([
              ...(program.http?.routes ?? []),
              ...children.http.map((entry) => entry.route),
            ]),
          }),
        }
      : {}),
    ...(rpcConfigured
      ? {
          jsonRpc: Object.freeze({
            ...(program.jsonRpc ?? {}),
            methods: Object.freeze([
              ...(program.jsonRpc?.methods ?? []),
              ...children.jsonRpc.map((entry) => entry.method),
            ]),
          }),
        }
      : {}),
    ...(mcpConfigured
      ? {
          mcp: Object.freeze({
            ...(program.mcp ?? {}),
            tools: Object.freeze([
              ...(program.mcp?.tools ?? []),
              ...children.mcp.map((entry) => entry.tool),
            ]),
          }),
        }
      : {}),
  }) as AppSpec;
}

/** Rejects parent/child identity conflicts before any native catalog can resolve by order. */
function assertNoParentChildCollisions(program: AppSpec, children: ChildSnapshot): void {
  const parentFacts: ChildCollisionFact[] = [];
  const visit = (node: Command, path: readonly string[], enabled: boolean): void => {
    const nodeEnabled = enabled && node.cli?.enabled !== false;
    if (nodeEnabled) {
      const identity = [...path, node.key].join(" ");
      if (identity.length > 0) {
        parentFacts.push({ kind: "cli", identity, ownerPath: `parent.cli:${identity}` });
      }
    }
    if (hasSubcommands(node) && nodeEnabled) {
      for (const child of node.commands) visit(child, [...path, node.key], nodeEnabled);
    }
  };
  if (hasSubcommands(program)) {
    for (const child of program.commands) visit(child, [], true);
  }
  for (const key of reservedCliCollisionKeys(program, children)) {
    parentFacts.push({ kind: "cli", identity: key, ownerPath: `framework.cli:${key}` });
  }
  for (const route of program.http?.routes ?? []) {
    parentFacts.push({
      kind: "httpOperation",
      identity: route.id,
      ownerPath: `parent.http:${route.id}`,
    });
    parentFacts.push({
      kind: "httpRoute",
      identity: `${route.method} ${route.path}`,
      ownerPath: `parent.http:${route.id}`,
      method: route.method,
      routeSegments: Object.freeze(route.path.split("/").filter(Boolean)),
    });
  }
  for (const method of program.jsonRpc?.methods ?? []) {
    parentFacts.push({
      kind: "rpc",
      identity: method.name,
      ownerPath: `parent.rpc:${method.name}`,
    });
  }
  for (const tool of program.mcp?.tools ?? []) {
    parentFacts.push({
      kind: "mcp",
      identity: tool.name,
      ownerPath: `parent.mcp:${tool.name}`,
    });
  }
  for (const child of children.collisions) {
    for (const parent of parentFacts) assertNoChildCollisions([child, parent]);
  }
}

/** Names reserved by built-ins or generated mirrors at the parent CLI root. */
function reservedCliCollisionKeys(program: AppSpec, children: ChildSnapshot): readonly string[] {
  const keys = ["serve", "version"];
  if (program.completion?.enabled !== false) keys.push("completion");
  if (program.http !== undefined || children.surfaces.includes("http")) keys.push("api", "http");
  if (program.jsonRpc !== undefined || children.surfaces.includes("jsonRpc")) keys.push("rpc");
  if (program.mcp !== undefined || children.surfaces.includes("mcp")) keys.push("mcp");
  return keys;
}

/**
 * Builds an argsbarg app: validates and freezes the spec, then returns the runtime (`await app.run()`).
 * A runnable root (`handler`) gets `ctx.inputs` typed from its `inputSchema` or `options` / `positionals`, like
 * {@link command}.
 */
export function argsbarg<const T extends CommandGroup & AppSpecFields>(
  /** Spec whose root groups commands. */
  spec: T,
): App;
export function argsbarg<
  I extends z.ZodType | undefined = undefined,
  O extends z.ZodType | undefined = undefined,
  const Opts extends readonly CommandOption[] = [],
  const Pos extends readonly CommandPositional[] = [],
>(
  /** Spec whose root runs a handler (a one-command CLI). */
  spec: CommandDef<I, O, undefined, Opts, Pos> & AppSpecFields,
): App;
export function argsbarg(
  /** Already-typed app spec. */
  spec: AppSpec,
): App;
export function argsbarg(
  /** App spec. */
  spec: AppSpec,
): App {
  return new App(spec);
}

/** Argsbarg runtime for a validated, frozen {@link AppSpec}. */
export class App {
  readonly spec: AppSpec;
  readonly caps: Capabilities;
  /** One composed authoring snapshot used by CLI parsing and discovery. */
  private readonly runtimeProgram: AppSpec;
  /** Immutable child declarations composed once during construction. */
  private readonly childSnapshot: ChildSnapshot;
  private readonly parseRootMerged: CommandGroup;
  private readonly presentationRoot: CommandGroup;
  /** Immutable CLI declaration identity keyed by the parser's joined path. */
  private readonly cliCatalog: ReadonlyMap<string, CliCatalogEntry>;
  /** Retained REST catalog and paired generated registrations. */
  private readonly httpCatalog?: HttpRouteCatalog;
  /** Exactly one local/relay registration pair for REST. */
  private readonly httpMirror?: HttpMirrorEntries<Locals>;
  /** Retained JSON-RPC catalog used by the mount and generated command. */
  private readonly rpcCatalog?: JsonRpcCatalog<Locals>;
  /** Exactly one local/relay registration pair for JSON-RPC. */
  private readonly rpcMirror?: JsonRpcMirrorEntries<Locals>;
  /** Retained MCP 2026 registry used by stdio, HTTP, and generated calls. */
  private readonly mcpRegistry?: McpRegistry<Locals>;
  /** Exactly one local/relay MCP call registration pair. */
  private readonly mcpCalls?: McpCliCalls<Locals>;
  constructor(program: AppSpec) {
    cliValidateProgram(program);
    Object.freeze(program);
    this.spec = program;
    this.childSnapshot = composeChildren(program.children ?? {});
    this.runtimeProgram = composeRuntimeProgram(program, this.childSnapshot);
    cliValidateProgram(this.runtimeProgram);
    this.caps = resolveCapabilities(this.runtimeProgram);
    const generated = generatedCliCommands(this.runtimeProgram);
    const parseRoot = cliParseRoot(this.runtimeProgram);
    const presentationRoot = cliPresentationRoot(this.runtimeProgram);
    this.parseRootMerged = { ...parseRoot, commands: [...parseRoot.commands, ...generated] };
    this.presentationRoot = { ...presentationRoot, commands: [...presentationRoot.commands, ...generated] };
    this.cliCatalog = this.buildCliCatalog(this.runtimeProgram);
    const httpGuards = new Map(this.childSnapshot.http.map((entry) => [entry.route, entry.guard]));
    const httpSources = new Map(this.childSnapshot.http.map((entry) => [entry.route, entry]));
    if (this.runtimeProgram.http !== undefined) {
      this.httpCatalog = createHttpCatalog<Locals>(this.runtimeProgram.http.routes, {
        guard: program.http?.guard,
        guardsByRegistration: httpGuards,
        decorateInvoke: (registration, invoke, rawInputs, base) => {
          const child = httpSources.get(registration);
          return invoke(rawInputs, child === undefined ? base : scopeChildInvocation(base, child.source));
        },
      });
      for (const route of this.httpCatalog.routes) {
        const child = this.childSnapshot.http.find((entry) => entry.route.id === route.spec.id);
        registerInvocationHooks(route.declaration, {
          path: ["http", route.spec.id],
          hooks: child === undefined ? program.hooks : child.hooks,
          reporter: child === undefined ? program.errorReporter : child.errorReporter,
        });
      }
      this.httpMirror = createHttpMirror<Locals>(this.httpCatalog);
    }
    const rpcGuards = new Map(this.childSnapshot.jsonRpc.map((entry) => [entry.method, entry.guard]));
    const rpcSources = new Map(this.childSnapshot.jsonRpc.map((entry) => [entry.method, entry]));
    if (this.runtimeProgram.jsonRpc !== undefined) {
      this.rpcCatalog = createJsonRpcCatalog<Locals>({
        methods: this.runtimeProgram.jsonRpc.methods,
        guard: program.jsonRpc?.guard,
        guardsByRegistration: rpcGuards,
        decorateInvoke: (method, invoke, rawInputs, base) => {
          const child = rpcSources.get(method);
          return invoke(rawInputs, child === undefined ? base : scopeChildInvocation(base, child.source));
        },
      });
      for (const method of this.rpcCatalog.methods) {
        const child = this.childSnapshot.jsonRpc.find((entry) => entry.method.name === method.method.name);
        registerInvocationHooks(method.declaration, {
          path: ["rpc", method.method.name],
          hooks: child === undefined ? program.hooks : child.hooks,
          reporter: child === undefined ? program.errorReporter : child.errorReporter,
        });
      }
      this.rpcMirror = createJsonRpcMirror<Locals>(this.rpcCatalog);
    }
    if (this.runtimeProgram.mcp !== undefined) {
      this.mcpRegistry = createMcpRegistry<Locals>(this.runtimeProgram.mcp.tools, {
        guard: program.mcp?.guard,
        decorateInvoke: (name, invoke, rawInputs, base) =>
          this.invokeMcpWithHooks(invoke, name, rawInputs, base),
      });
      this.mcpCalls = createMcpCliCalls({
        registry: this.mcpRegistry,
        serverInfo: { name: program.key, version: program.version },
      });
    }
  }

  exportCommandSchema(): SchemaRootExport {
    return schemaExport(this.runtimeProgram);
  }

  async run(argv: string[] = process.argv.slice(2)): Promise<void> {
    if (argv[0] === "serve") {
      await this.runService(argv.slice(1));
      await flushStdio();
      return;
    }
    if (this.isGeneratedCliCall(argv)) {
      const input = process.stdin.isTTY ? undefined : await readGeneratedStdin(process.stdin);
      const writer = processCliWriter();
      const controller = new AbortController();
      const abort = (): void => controller.abort();
      process.once("SIGINT", abort);
      process.once("SIGTERM", abort);
      try {
        const presented = await this.invokeGeneratedCliCall(argv, {
          writer,
          input,
          signal: controller.signal,
          fetch: globalThis.fetch,
        });
        process.exitCode = presented.exitCode;
        await flushStdio();
        return;
      } finally {
        process.off("SIGINT", abort);
        process.off("SIGTERM", abort);
      }
    }
    assertBuiltinAllowed(argv, this.caps, this.runtimeProgram);

    const prep = this.prepareDispatch(argv);
    if ("error" in prep) {
      if (prep.error.kind === ParseKind.Help) {
        process.stdout.write(cliHelpRender(this.parseRootMerged, prep.error.helpPath, false));
        process.exitCode = prep.error.helpExplicit ? 0 : 1;
        await flushStdio();
        return;
      }
      process.stderr.write(`${prep.error.errorMsg}\n`);
      process.stderr.write(cliHelpRender(this.presentationRoot, prep.error.errorHelpPath, true));
      process.exitCode = 1;
      await flushStdio();
      return;
    }

    const { pr, completionParseRoot, isLeafCompletionIntercept } = prep;

    if (pr.kind === ParseKind.Ok) {
      await dispatchBuiltin(this.spec, pr, {
        isLeafCompletionIntercept,
        parseRoot: completionParseRoot,
      });
    }

    let preloadedJson: Record<string, unknown> = {};
    try {
      preloadedJson = await preloadPipableJson(this.runtimeProgram, pr.path, pr.opts, "cli", pr.args);
    } catch (err) {
      if (err instanceof InputError) {
        process.stderr.write(`${err.message}\n`);
        process.stderr.write(cliHelpRender(this.presentationRoot, pr.path, true));
        process.exitCode = 1;
        await flushStdio();
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`${msg}\n`);
      process.exitCode = 1;
      await flushStdio();
      return;
    }

    const result = await this.invokeNativeCli(argv, preloadedJson);
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exitCode = result.exitCode;
    await flushStdio();
  }

  async invoke(
    argv: string[],
    opts?: {
      signal?: AbortSignal;
      stdin?: string | AsyncIterable<string | Uint8Array>;
      fetch?: typeof globalThis.fetch;
    },
  ): Promise<CliInvokeResult> {
    if (this.isGeneratedCliCall(argv)) {
      const stdout: Uint8Array[] = [];
      const stderr: string[] = [];
      const decoder = new TextDecoder();
      const result = await this.invokeGeneratedCliCall(argv, {
        writer: {
          async stdout(chunk) {
            stdout.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
          },
          async stderr(chunk) {
            stderr.push(chunk);
          },
        },
        input:
          typeof opts?.stdin === "string"
            ? opts.stdin
            : opts?.stdin === undefined
              ? undefined
              : await readGeneratedStdin(opts.stdin),
        signal: opts?.signal ?? new AbortController().signal,
        fetch: opts?.fetch ?? globalThis.fetch,
      });
      return {
        kind: result.exitCode === 0 ? "ok" : "error",
        exitCode: result.exitCode,
        stdout: decoder.decode(Buffer.concat(stdout.map((chunk) => Buffer.from(chunk)))),
        stderr: stderr.join(""),
        ...(result.exitCode === 0 ? {} : { errorMsg: stderr.join("").trim() || `Exit code ${result.exitCode}` }),
      };
    }
    return this.invokeNativeCli(argv, undefined, opts?.signal);
  }

  /** True when this argv selects one configured D35 generated mirror. */
  private isGeneratedCliCall(argv: readonly string[]): boolean {
    return (
      (argv[0] === "api" && this.httpMirror !== undefined) ||
      (argv[0] === "rpc" && this.rpcMirror !== undefined) ||
      (argv[0] === "mcp" && argv[1] === "call" && this.mcpCalls !== undefined)
    );
  }

  /** Separates common generated options from selector positionals with no ambient option source. */
  private parseCliMirrorArguments(
    /** Tokens after the generated command prefix. */
    argv: readonly string[],
  ): CliMirrorArguments | CliFailedCallResult {
    const positionals: string[] = [];
    const headers: [string, string][] = [];
    const names = new Set<string>();
    let format: DocumentFormat = "json";
    let relayText: string | undefined;
    for (let index = 0; index < argv.length; index += 1) {
      const token = argv[index] ?? "";
      if (token === "--help" || token === "-h") {
        return callFailure("input", "HELP_REQUESTED", "Generated command help requested");
      }
      if (token === "--yaml") {
        format = "yaml";
        continue;
      }
      if (token === "--relay" || token.startsWith("--relay=")) {
        const value = token === "--relay" ? argv[++index] : token.slice("--relay=".length);
        if (value === undefined || value.length === 0 || relayText !== undefined) {
          return callFailure("input", "INVALID_RELAY_URL", "One non-empty --relay URL is required");
        }
        relayText = value;
        continue;
      }
      if (token === "--header" || token.startsWith("--header=")) {
        const value = token === "--header" ? argv[++index] : token.slice("--header=".length);
        const colon = value?.indexOf(":") ?? -1;
        if (colon === undefined || colon <= 0 || value === undefined) {
          return callFailure("input", "INVALID_HEADER", "Header must use --header name:value");
        }
        const name = value.slice(0, colon).trim();
        const fieldValue = value.slice(colon + 1).trim();
        const lower = name.toLowerCase();
        if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name) || fieldValue.includes("\r") || fieldValue.includes("\n")) {
          return callFailure("input", "INVALID_HEADER", "Relay header is invalid");
        }
        const blocked = new Set([
          "connection",
          "content-length",
          "content-type",
          "host",
          "mcp-method",
          "mcp-name",
          "transfer-encoding",
        ]);
        if (blocked.has(lower)) {
          return callFailure("input", "FORBIDDEN_HEADER", "Relay header is owned by the transport");
        }
        if (names.has(lower)) {
          return callFailure("input", "DUPLICATE_HEADER", "Relay header names may appear only once");
        }
        names.add(lower);
        headers.push([name, fieldValue]);
        continue;
      }
      if (token.startsWith("-")) {
        return callFailure("input", "UNKNOWN_OPTION", "Generated command option is not supported");
      }
      positionals.push(token);
    }
    if (headers.length > 0 && relayText === undefined) {
      return callFailure("input", "HEADER_WITHOUT_RELAY", "--header requires --relay");
    }
    if (relayText === undefined) return { positionals, headers, format };
    let relay: URL;
    try {
      relay = new URL(relayText);
    } catch {
      return callFailure("input", "INVALID_RELAY_URL", "Relay must be an absolute HTTP(S) URL");
    }
    if (
      !["http:", "https:"].includes(relay.protocol) ||
      relay.username.length > 0 ||
      relay.password.length > 0 ||
      relay.hash.length > 0
    ) {
      return callFailure("input", "INVALID_RELAY_URL", "Relay must be an HTTP(S) URL without userinfo or fragment");
    }
    return { positionals, headers, relay, format };
  }

  /** Invokes and presents one configured generated local or relay call. */
  private async invokeGeneratedCliCall(
    argv: readonly string[],
    options: {
      /** Native terminal sink; production is incremental and invoke is a collector. */
      readonly writer: CliCallWriter;
      /** Exactly one optional stdin document. */
      readonly input?: string;
      /** Exact caller/process signal retained by local D2 or relay Fetch. */
      readonly signal: AbortSignal;
      /** Injected Fetch implementation for the relay branch. */
      readonly fetch: typeof globalThis.fetch;
    },
  ): Promise<{ readonly exitCode: 0 | 1 | 130 }> {
    const prefix = argv[0] === "mcp" ? argv.slice(2) : argv.slice(1);
    const parsed = this.parseCliMirrorArguments(prefix);
    if ("kind" in parsed) {
      if (parsed.code === "HELP_REQUESTED") {
        await options.writer.stdout(generatedCliHelp(argv));
        return { exitCode: 0 };
      }
      return presentCliCall(this.generatedSurface(argv), parsed, options.writer, options.signal);
    }

    const input = parseGeneratedDocument(options.input, parsed.format);
    if (input.kind === "failure") {
      return presentCliCall(this.generatedSurface(argv), input.failure, options.writer, options.signal);
    }

    let call: CliCallResult<unknown>;
    let surface: "rest" | "rpc" | "mcp";
    try {
      if (argv[0] === "api") {
        surface = "rest";
        call = await this.callGeneratedRest(parsed, input.value, options);
      } else if (argv[0] === "rpc") {
        surface = "rpc";
        call = await this.callGeneratedRpc(parsed, input.value, options);
      } else {
        surface = "mcp";
        call = await this.callGeneratedMcp(parsed, input.value, options);
      }
      return presentCliCall(surface, call, options.writer, options.signal, parsed.format);
    } catch {
      const failure = callFailure("transport", "CALL_FAILED", "Generated call failed");
      return presentCliCall(this.generatedSurface(argv), failure, options.writer, options.signal);
    }
  }

  /** Returns the fixed presenter surface selected by a configured generated command. */
  private generatedSurface(argv: readonly string[]): "rest" | "rpc" | "mcp" {
    return argv[0] === "api" ? "rest" : argv[0] === "rpc" ? "rpc" : "mcp";
  }

  /** Prevalidates and executes one generated REST local or relay registration. */
  private callGeneratedRest(
    parsed: CliMirrorArguments,
    input: unknown,
    options: Parameters<App["invokeGeneratedCliCall"]>[1],
  ): Promise<CliCallResult<unknown>> {
    const [method, fullPath] = parsed.positionals;
    if (
      parsed.positionals.length !== 2 ||
      method === undefined ||
      fullPath === undefined ||
      (parsed.relay !== undefined &&
        (parsed.relay.pathname !== "/" || parsed.relay.search.length > 0 || parsed.relay.hash.length > 0))
    ) {
      return Promise.resolve(
        callFailure(
          "input",
          "INVALID_CALL",
          parsed.relay === undefined
            ? generatedCliHelp(["api"]).trimEnd()
            : "REST --relay requires an HTTP(S) origin",
        ),
      );
    }
    if (input !== undefined && (typeof input !== "object" || input === null || Array.isArray(input))) {
      return Promise.resolve(callFailure("input", "INVALID_BODY", parsed.format === "yaml" ? "REST stdin must be one YAML mapping" : "REST stdin must be one JSON object"));
    }
    const catalog = this.httpCatalog as HttpRouteCatalog;
    const callInput = {
      method: method.toUpperCase(),
      fullPath,
      ...(input === undefined ? {} : { body: input as Record<string, unknown> }),
    };
    const localValidation = bindHttpCall(catalog, callInput);
    if (!localValidation.ok) {
      return Promise.resolve(
        callFailure("input", localValidation.code, localValidation.message, localValidation.status),
      );
    }
    const mirror = this.httpMirror as HttpMirrorEntries<Locals>;
    if (parsed.relay === undefined) {
      return mirror.local.invoke(callInput, {
        mode: "local",
        signal: options.signal,
        locals: { requestId: randomUUID() } as Locals,
        env: processEnvNameView(),
        ...(parsed.format === "yaml" ? { format: parsed.format } : {}),
      });
    }
    return mirror.relay.invoke(callInput, {
      mode: "relay",
      signal: options.signal,
      url: parsed.relay,
      headers: parsed.headers,
      fetch: options.fetch,
      format: parsed.format,
    });
  }

  /** Prevalidates and executes one generated exact-name JSON-RPC call. */
  private callGeneratedRpc(
    parsed: CliMirrorArguments,
    input: unknown,
    options: Parameters<App["invokeGeneratedCliCall"]>[1],
  ): Promise<CliCallResult<unknown>> {
    const [method] = parsed.positionals;
    if (parsed.positionals.length !== 1 || method === undefined) {
      return Promise.resolve(
        callFailure("input", "INVALID_CALL", generatedCliHelp(["rpc"]).trimEnd()),
      );
    }
    if (
      input !== undefined &&
      (typeof input !== "object" || input === null || (!Array.isArray(input) && typeof input !== "object"))
    ) {
      return Promise.resolve(callFailure("input", "INVALID_PARAMS", "RPC stdin must be a JSON object or array"));
    }
    const callInput: JsonRpcMirrorInput = {
      method,
      ...(input === undefined ? {} : { params: input as Record<string, unknown> | unknown[] }),
    };
    const catalog = this.rpcCatalog as JsonRpcCatalog<Locals>;
    if (catalog.get(method) === undefined) {
      return Promise.resolve(callFailure("input", "METHOD_NOT_FOUND", "JSON-RPC method is not registered"));
    }
    const mirror = this.rpcMirror as JsonRpcMirrorEntries<Locals>;
    if (parsed.relay === undefined) {
      return mirror.local.invoke(callInput, {
        mode: "local",
        signal: options.signal,
        locals: { requestId: randomUUID() } as Locals,
        env: processEnvNameView(),
      });
    }
    return mirror.relay.invoke(callInput, {
      mode: "relay",
      signal: options.signal,
      url: parsed.relay,
      headers: parsed.headers,
      fetch: options.fetch,
    });
  }

  /** Prevalidates and executes one generated exact-name MCP tools/call. */
  private callGeneratedMcp(
    parsed: CliMirrorArguments,
    input: unknown,
    options: Parameters<App["invokeGeneratedCliCall"]>[1],
  ): Promise<CliCallResult<unknown>> {
    const [name] = parsed.positionals;
    if (parsed.positionals.length !== 1 || name === undefined) {
      return Promise.resolve(
        callFailure("input", "INVALID_CALL", generatedCliHelp(["mcp", "call"]).trimEnd()),
      );
    }
    const argumentsValue = input === undefined ? {} : input;
    if (typeof argumentsValue !== "object" || argumentsValue === null || Array.isArray(argumentsValue)) {
      return Promise.resolve(callFailure("input", "INVALID_ARGUMENTS", "MCP stdin must be one JSON object"));
    }
    const registry = this.mcpRegistry as McpRegistry<Locals>;
    if (registry.lookup(name) === undefined) {
      return Promise.resolve(callFailure("input", "TOOL_NOT_FOUND", "MCP tool is not registered"));
    }
    const callInput: McpCliCallInput = { name, arguments: argumentsValue as Record<string, unknown> };
    const calls = this.mcpCalls as McpCliCalls<Locals>;
    if (parsed.relay === undefined) {
      return calls.local.invoke(callInput, {
        mode: "local",
        signal: options.signal,
        locals: { requestId: randomUUID() } as Locals,
        env: processEnvNameView(),
      });
    }
    return calls.relay.invoke(callInput, {
      mode: "relay",
      signal: options.signal,
      url: parsed.relay,
      headers: parsed.headers,
      fetch: options.fetch,
    });
  }

  /** Builds one startup snapshot of every user-authored CLI declaration and its guard plan. */
  private buildCliCatalog(program: AppSpec): ReadonlyMap<string, CliCatalogEntry> {
    const entries = new Map<string, CliCatalogEntry>();
    const register = (node: Command, path: readonly string[], pathNames: readonly string[]): void => {
      if (hasHandler(node)) {
        const child = childCliSnapshotForPath(this.childSnapshot, path);
        const compile = compileGuardPlan<unknown, Locals>();
        const operation = node.guard as
          | Guard<unknown, Locals, object>
          | { readonly mode: "override"; readonly run: Guard<unknown, Locals, object> }
          | "public"
          | undefined;
        const runtimeSurface = child === undefined ? program.cli?.guard : child.guard;
        const guardPlan =
          operation === undefined
            ? compile({ surface: runtimeSurface })
            : operation === "public" || typeof operation === "object"
              ? compile({ surface: runtimeSurface, operation: operation as never })
              : compile({ surface: runtimeSurface, operation: operation as never });
        const inputSchema = runtimeLeafInputSchema({
          leaf: node,
          options: collectPathOptionDefs(program, [...path]),
          pathNames,
        });
        const declaration = {
          inputSchema,
          guardPlan,
          handler: node.handler as unknown as (
            context: InvocationContext<unknown, Locals>,
          ) => unknown | Promise<unknown>,
        } as BoundDeclaration<z.ZodType, unknown, Locals>;
        entries.set(JSON.stringify(path), {
          declaration,
          ...(child === undefined
            ? { hooks: program.hooks, errorReporter: program.errorReporter }
            : {
                hooks: child.hooks,
                errorReporter: child.errorReporter,
                source: child.source,
              }),
        });
        return;
      }
      for (const child of node.commands) {
        const param = child.key.startsWith(":") ? child.key.slice(1) : undefined;
        register(child, [...path, child.key], param === undefined ? pathNames : [...pathNames, param]);
      }
    };
    register(program, [], []);
    return new Map(entries);
  }

  /** Runs a native CLI parse and one D2 declaration without ending the process. */
  private async invokeNativeCli(
    /** Original argv so hook and parser diagnostics retain the accepted selection. */
    argv: string[],
    /** Piped JSON preloaded by `run`; omitted `invoke` calls do not consume ambient stdin. */
    preloadedJson?: Record<string, unknown>,
    /** Exact caller-owned signal; direct CLI invocation never substitutes it. */
    signal: AbortSignal = new AbortController().signal,
  ): Promise<CliInvokeResult> {
    const prep = this.prepareDispatch(argv, { presentationFallback: true });
    if ("error" in prep) {
      if (prep.error.kind === ParseKind.Help) {
        return {
          kind: "help",
          exitCode: prep.error.helpExplicit ? 0 : 1,
          stdout: prep.error.helpExplicit ? cliHelpRender(this.presentationRoot, prep.error.helpPath, false) : "",
          stderr: prep.error.helpExplicit ? "" : cliHelpRender(this.presentationRoot, prep.error.errorHelpPath, true),
          errorMsg: prep.error.helpExplicit ? undefined : "Help is not available for an implicit route.",
          failureKind: "help",
        };
      }
      return {
        kind: "error",
        exitCode: 1,
        stdout: "",
        stderr: `${prep.error.errorMsg}\n${cliHelpRender(this.presentationRoot, prep.error.errorHelpPath, true)}`,
        errorMsg: prep.error.errorMsg,
        failureKind: "validation",
      };
    }

    if (isBuiltinInvokePath(prep.pr.path, this.caps)) {
      if (prep.pr.path[0] === "version") {
        return { kind: "ok", exitCode: 0, stdout: `${this.spec.version}\n`, stderr: "" };
      }
      return {
        kind: "error",
        exitCode: 1,
        stdout: "",
        stderr: "Built-in service commands must run through app.run().\n",
        errorMsg: "Built-in service commands must run through app.run().",
      };
    }

    const entry = this.cliCatalog.get(JSON.stringify(prep.pr.path));
    if (entry === undefined) {
      const errorMsg = "Internal error: missing bound command declaration";
      return {
        kind: "error",
        exitCode: 1,
        stdout: "",
        stderr: `${errorMsg}\n`,
        errorMsg,
        failureKind: "unexpected",
      };
    }
    const locals = { requestId: randomUUID() } as Locals;
    let bound: CliBoundCommand<Locals>;
    try {
      bound = bindCliCommand({
        program: this.runtimeProgram,
        leaf: prep.leaf,
        parsed: prep.pr,
        preloadedJson,
        signal,
        locals,
        inputSchema: entry.declaration.inputSchema,
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Unable to bind CLI inputs";
      return {
        kind: "error",
        exitCode: 1,
        stdout: "",
        stderr: `${errorMsg}\n`,
        errorMsg,
        failureKind: "validation",
      };
    }

    const hookCtx = (): import("../core/types.ts").InvokeHookContext =>
      buildBoundInvokeHookContext({
        path: bound.path,
        rawInputs: bound.rawInputs,
        signal: bound.base.signal,
        locals,
      });
    const scope: InvocationScope = {
      stdout: "",
      stderr: "",
      exit: (code) => {
        throw new CliInvokeExit(code);
      },
      forbidChdir: false,
      closed: false,
      metadata: { source: "local", surface: "cli" },
      signal: bound.base.signal,
    };
    return runInInvocationScope(scope, async () => {
      let outcome: InvocationOutcome<unknown>;
      try {
        await runHook(() => entry.hooks?.beforeInvoke?.(hookCtx()), "beforeInvoke");
        outcome = await invokeBound({
          declaration: entry.declaration,
          rawInputs: bound.rawInputs,
          base:
            entry.source === undefined
              ? ({ ...bound.base, locals } as typeof bound.base)
              : scopeChildInvocation({ ...bound.base, locals } as typeof bound.base, entry.source),
        });
        process.stdout.write(outcome.stdout);
        process.stderr.write(outcome.stderr);
        if (outcome.kind === "ok") {
          const encoded = encodeCliOutcome({ ...outcome, stdout: "", stderr: "" });
          process.stdout.write(encoded.stdout);
          process.stderr.write(encoded.stderr);
          await runHook(
            () =>
              entry.hooks?.afterInvoke?.({
                ...hookCtx(),
                result: encoded,
              }),
            "afterInvoke",
          );
          return { ...encoded, stdout: scope.stdout, stderr: scope.stderr };
        }
      } catch (error) {
        outcome = { kind: "error", error, stdout: "", stderr: "" };
      }

      if (outcome.kind === "denied") {
        const encoded = encodeCliOutcome({ ...outcome, stdout: "", stderr: "" });
        process.stderr.write(encoded.stderr);
        return { ...encoded, stdout: scope.stdout, stderr: scope.stderr };
      }
      const errorValue = outcome.kind === "invalid" ? outcome.error : outcome.error;
      try {
        const piped = await runErrorPipeline(
          hookCtx(),
          errorValue,
          classifyFailureKind(errorValue, { parseError: outcome.kind === "invalid" }),
          entry.hooks,
          undefined,
          false,
          entry.errorReporter,
        );
        process.stderr.write(`${piped.errorMsg}\n`);
        return {
          kind: "error",
          exitCode: piped.clientError.exitCode ?? 1,
          stdout: scope.stdout,
          stderr: scope.stderr,
          errorMsg: piped.errorMsg,
          failureKind: piped.failureKind,
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : "Error hook failed";
        process.stderr.write(`${errorMsg}\n`);
        return {
          kind: "error",
          exitCode: 1,
          stdout: scope.stdout,
          stderr: scope.stderr,
          errorMsg,
          failureKind: "unexpected",
        };
      }
    });
  }

  async serveMcp(overrides: ServeOverrides = {}): Promise<void> {
    void overrides;
    if (this.mcpRegistry === undefined) throw new TypeError("MCP is not configured");
    await serveMcpStdio({
      registry: this.mcpRegistry,
      serverInfo: { name: this.spec.key, version: this.spec.version },
      ...(this.spec.mcp?.instructions === undefined ? {} : { instructions: this.spec.mcp.instructions }),
      createSeedLocals: () => ({ requestId: randomUUID() }) as Locals,
    });
    await flushStdio();
  }

  async serveHttp(overrides: ServeOverrides = {}, selected?: readonly string[]): Promise<void> {
    const mounts = this.createNativeHttpMounts(selected);
    if (mounts.length === 0) throw new TypeError("No HTTP service is configured");
    const resolved = resolveHttpServeConfig(this.spec, overrides);
    const handle = await startHttpListener({ mounts, targets: resolved.targets });
    let stopping: Promise<void> | undefined;
    const stop = (): void => {
      stopping ??= handle.stop();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      await handle.terminal;
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      if (handle.state === "running") await handle.stop();
      await stopping;
      await flushStdio();
    }
  }

  /** Creates the fixed REST, RPC, and MCP mounts from the one catalog per configured surface. */
  private createNativeHttpMounts(selected?: readonly string[]): readonly HttpMount[] {
    const mounts: HttpMount[] = [];
    const services = this.selectedHttpServices(selected);
    if (
      this.httpCatalog !== undefined &&
      services.includes("http")
    ) {
      mounts.push(
        createHttpMount({
          catalog: this.httpCatalog,
          identity: {
            title: this.spec.key,
            version: this.spec.version,
            description: this.spec.description,
          },
          hooks: this.spec.http?.hooks,
          trustProxy: this.spec.http?.trustProxy ?? false,
          seedLocals: () => ({ requestId: randomUUID() }) as Locals,
        }),
      );
    }
    if (
      this.rpcCatalog !== undefined &&
      services.includes("rpc")
    ) {
      mounts.push(
        createJsonRpcHttpMount({
          catalog: this.rpcCatalog,
          appInfo: {
            title: this.spec.key,
            version: this.spec.version,
            description: this.spec.description,
          },
          createLocals: () => ({ requestId: randomUUID() }) as Locals,
        }),
      );
    }
    if (
      this.mcpRegistry !== undefined &&
      services.includes("mcp")
    ) {
      mounts.push(
        createMcpHttpMount({
          registry: this.mcpRegistry,
          serverInfo: { name: this.spec.key, version: this.spec.version },
          ...(this.spec.mcp?.instructions === undefined ? {} : { instructions: this.spec.mcp.instructions }),
          ...(this.spec.mcp?.http?.middleware === undefined
            ? {}
            : { middleware: this.spec.mcp.http.middleware }),
          seedLocals: () => ({ requestId: randomUUID() }) as Locals,
        }),
      );
    }
    if (mounts.length > 0) mounts.unshift(createFrameworkHealthMount(services));
    return mounts;
  }

  /** Validates explicit selections and returns every configured service that this listener will mount. */
  private selectedHttpServices(selected?: readonly string[]): readonly HttpServiceName[] {
    const configured = [
      ...(this.httpCatalog === undefined ? [] : (["http"] as const)),
      ...(this.rpcCatalog === undefined ? [] : (["rpc"] as const)),
      ...(this.mcpRegistry === undefined ? [] : (["mcp"] as const)),
    ] as HttpServiceName[];
    if (selected === undefined || selected.length === 0) return configured;
    const requested = [...new Set(selected)] as HttpServiceName[];
    const missing = requested.filter((service) => !configured.includes(service));
    if (missing.length > 0) throw new TypeError(`HTTP service is not configured: ${missing.join(", ")}`);
    return requested;
  }

  /** Runs MCP hooks around the adapter's one registry invocation while retaining captured output. */
  private async invokeMcpWithHooks(
    /** Original registry invocation closure. */
    invoke: (
      rawInputs: unknown,
      base: import("../core/invocation.ts").InvocationBase<Locals>,
    ) => Promise<InvocationOutcome<unknown>>,
    /** Exact selected MCP tool name. */
    name: string,
    /** Raw inputs for the one D2 parse. */
    rawInputs: unknown,
    /** Exact MCP source, signal, and per-call locals. */
    base: import("../core/invocation.ts").InvocationBase<Locals>,
  ): Promise<InvocationOutcome<unknown>> {
    const child = this.childSnapshot.mcp.find((entry) => entry.tool.name === name);
    const selectedBase =
      child === undefined ? base : scopeChildInvocation(base, child.source);
    const hooks = child === undefined ? this.spec.hooks : child.hooks;
    const reporter = child === undefined ? this.spec.errorReporter : child.errorReporter;
    if (hooks === undefined && reporter === undefined) return invoke(rawInputs, selectedBase);
    const scope: InvocationScope = {
      stdout: "",
      stderr: "",
      exit: (code) => {
        throw new CliInvokeExit(code);
      },
      forbidChdir: true,
      closed: false,
      metadata: { source: selectedBase.source, surface: selectedBase.surface },
      signal: selectedBase.signal,
    };
    return runInInvocationScope(scope, async () => {
      const outcome = await runInvocationHookLifecycle(
        { path: ["mcp", name], hooks, reporter },
        selectedBase,
        rawInputs,
        () => invoke(rawInputs, selectedBase),
        () => ({ stdout: scope.stdout, stderr: scope.stderr }),
      );
      return { ...outcome, stdout: `${scope.stdout}${outcome.stdout}`, stderr: `${scope.stderr}${outcome.stderr}` };
    });
  }

  /** Selects exactly one native service mode and rejects combined MCP launch before I/O. */
  private async runService(argv: readonly string[]): Promise<void> {
    const stdio = argv.includes("--stdio");
    const modes = serviceModes(argv);
    if (stdio) {
      if (
        argv.length !== 2 ||
        argv[0] !== "mcp" ||
        argv[1] !== "--stdio" ||
        modes.length !== 1 ||
        this.mcpRegistry === undefined
      ) {
        throw new TypeError("serve mcp --stdio requires exactly that grammar and an enabled MCP registry");
      }
      await this.serveMcp();
      return;
    }
    if (modes.some((surface) => surface !== "http" && surface !== "rpc" && surface !== "mcp")) {
      throw new TypeError("serve accepts optional http, rpc or mcp service names");
    }
    this.selectedHttpServices(modes);
    const overrides = parseServeArgs(argv);
    if (this.createNativeHttpMounts(modes).length === 0) {
      throw new TypeError("No HTTP service is configured");
    }
    await this.serveHttp(overrides, modes);
  }

  private prepareDispatch(
    argv: string[],
    opts?: { presentationFallback?: boolean },
  ): PreparedDispatch | { error: ParseResult } {
    const program = this.runtimeProgram;
    let parseRoot: Command;
    let completionParseRoot: CommandGroup = opts?.presentationFallback ? this.presentationRoot : this.parseRootMerged;
    let isLeafCompletionIntercept = false;

    if (hasHandler(program)) {
      const intercept = builtinInterceptRoot(program, argv);
      if (intercept.isLeafCompletionIntercept || intercept.parseRoot !== program) {
        parseRoot = intercept.parseRoot;
        completionParseRoot = hasSubcommands(intercept.parseRoot)
          ? intercept.parseRoot
          : opts?.presentationFallback
            ? this.presentationRoot
            : this.parseRootMerged;
        isLeafCompletionIntercept = intercept.isLeafCompletionIntercept;
      } else {
        parseRoot = program;
      }
    } else {
      parseRoot = this.parseRootMerged;
    }

    let pr = parse(parseRoot, argv);
    pr = postParseValidate(parseRoot, pr);

    if (pr.kind !== ParseKind.Ok) {
      return { error: pr };
    }

    let current: Command = parseRoot;
    for (const seg of pr.path) {
      if (!hasSubcommands(current)) {
        const msg = "Internal error: missing handler for path.";
        return {
          error: {
            kind: ParseKind.Error,
            path: pr.path,
            args: pr.args,
            opts: pr.opts,
            pathParams: pr.pathParams,
            helpExplicit: false,
            helpPath: [],
            errorMsg: msg,
            errorHelpPath: pr.path,
          },
        };
      }
      const ch = current.commands.find((candidate) => candidate.key === seg);
      if (!ch) {
        const msg = "Internal error: missing handler for path.";
        return {
          error: {
            kind: ParseKind.Error,
            path: pr.path,
            args: pr.args,
            opts: pr.opts,
            pathParams: pr.pathParams,
            helpExplicit: false,
            helpPath: [],
            errorMsg: msg,
            errorHelpPath: pr.path,
          },
        };
      }
      current = ch;
    }

    if (!hasHandler(current) || !current.handler) {
      const msg = "Internal error: missing handler for path.";
      return {
        error: {
          kind: ParseKind.Error,
          path: pr.path,
          args: pr.args,
          opts: pr.opts,
          pathParams: pr.pathParams,
          helpExplicit: false,
          helpPath: [],
          errorMsg: msg,
          errorHelpPath: pr.path,
        },
      };
    }

    return {
      pr,
      parseRoot,
      completionParseRoot,
      isLeafCompletionIntercept,
      leaf: current,
    };
  }
}

/** Returns one sanitized D35 result with empty captured streams. */
function callFailure(
  /** Stable failure ownership. */
  category: CliFailedCallResult["category"],
  /** Credential-safe machine code. */
  code: string,
  /** Credential-safe terminal message. */
  message: string,
  /** Optional sanitized remote status. */
  status?: number,
): CliFailedCallResult {
  return {
    kind: "failure",
    category,
    code,
    message,
    ...(status === undefined ? {} : { status }),
    stdout: "",
    stderr: "",
  };
}

/** Parses exactly one optional stdin document without reading ambient state. */
function parseGeneratedDocument(
  /** Complete optional stdin text. */
  text: string | undefined,
  /** Explicit mirror format, defaulting to JSON at argument parsing. */
  format: DocumentFormat,
):
  | { readonly kind: "value"; readonly value: unknown }
  | { readonly kind: "failure"; readonly failure: CliFailedCallResult } {
  if (text === undefined || text.trim().length === 0) return { kind: "value", value: undefined };
  try {
    return { kind: "value", value: decodeDocument(text, format) };
  } catch {
    return {
      kind: "failure",
      failure: format === "yaml"
        ? callFailure("input", "INVALID_YAML", "stdin is not a valid YAML document")
        : callFailure("input", "INVALID_JSON", "stdin is not valid JSON"),
    };
  }
}

/** Reads one generated command's complete piped stdin as UTF-8 text. */
async function readGeneratedStdin(
  /** Explicit process or test input stream. */
  stream: AsyncIterable<string | Uint8Array>,
): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

/** Builds an incremental production writer that honors Node stream backpressure. */
function processCliWriter(): CliCallWriter {
  return {
    stdout(chunk) {
      return new Promise<void>((resolve, reject) => {
        process.stdout.write(chunk, (error?: Error | null) => (error ? reject(error) : resolve()));
      });
    },
    stderr(chunk) {
      return new Promise<void>((resolve, reject) => {
        process.stderr.write(chunk, (error?: Error | null) => (error ? reject(error) : resolve()));
      });
    },
  };
}

/** Snapshots process environment behind a name-only local D2 source. */
function processEnvNameView(): import("../core/invocation.ts").NameView {
  return processEnvView(process.env);
}

/** Returns plain generated-command help with the exact supported flags. */
function generatedCliHelp(argv: readonly string[]): string {
  if (argv[0] === "api") {
    return "Usage: api <METHOD> <FULL_PATH> [--yaml] [--relay URL] [--header name:value]\n";
  }
  if (argv[0] === "rpc") {
    return "Usage: rpc <METHOD> [--yaml] [--relay URL] [--header name:value]\n";
  }
  return "Usage: mcp call <NAME> [--yaml] [--relay URL] [--header name:value]\n";
}

/** Creates parser/help-only nodes for every configured D35 generated command. */
function generatedCliCommands(program: AppSpec): readonly Command[] {
  const commands: Command[] = [];
  const userRoots = new Set(hasSubcommands(program) ? program.commands.map((entry) => entry.key) : []);
  const collision = (key: string): void => {
    if (userRoots.has(key)) throw new TypeError(`Generated CLI command "${key}" conflicts with a user command`);
  };
  const mirrorOptions = [
    {
      name: "relay",
      description: "Relay this call to one explicit HTTP(S) URL.",
      kind: "string" as const,
    },
    {
      name: "header",
      description: "Repeatable explicit relay header in name:value form.",
      kind: "string" as const,
    },
    {
      name: "yaml",
      description: "Read YAML stdin and write structured results as YAML.",
      kind: "presence" as const,
    },
  ];
  if (program.http !== undefined) {
    collision("api");
    commands.push({
      key: "api",
      description: "Call one registered REST operation locally or by explicit relay.",
      options: mirrorOptions,
      positionals: [
        { name: "method", description: "Registered REST method.", kind: "string" as const },
        { name: "fullPath", description: "Exact absolute /api path including query text.", kind: "string" as const },
      ],
      handler: () => {},
    });
  }
  if (program.jsonRpc !== undefined) {
    collision("rpc");
    commands.push({
      key: "rpc",
      description: "Call one registered JSON-RPC method locally or by explicit relay.",
      options: mirrorOptions,
      positionals: [{ name: "method", description: "Registered exact method name.", kind: "string" as const }],
      handler: () => {},
    });
  }
  if (program.mcp !== undefined) {
    collision("mcp");
    commands.push({
      key: "mcp",
      description: "Call one registered MCP tool.",
      commands: [
        {
          key: "call",
          description: "Call one registered MCP tool locally or by explicit relay.",
          options: mirrorOptions,
          positionals: [{ name: "name", description: "Registered exact tool name.", kind: "string" as const }],
          handler: () => {},
        },
      ],
    });
  }
  return commands;
}

/** Parses the package-owned `serve` host/port flags; unsupported options remain terminal usage errors. */
function parseServeArgs(argv: readonly string[]): ServeOverrides {
  const out: ServeOverrides = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "http" || token === "rpc" || token === "mcp") continue;
    if (token === "--host") {
      const host = argv[++index];
      if (host === undefined) throw new TypeError("serve --host requires a value");
      out.host = host;
      continue;
    }
    if (token?.startsWith("--host=")) {
      out.host = token.slice("--host=".length);
      continue;
    }
    if (token === "--port") {
      const port = Number(argv[++index]);
      if (!Number.isInteger(port)) throw new TypeError("serve --port requires an integer");
      out.port = port;
      continue;
    }
    if (token?.startsWith("--port=")) {
      const port = Number(token.slice("--port=".length));
      if (!Number.isInteger(port)) throw new TypeError("serve --port requires an integer");
      out.port = port;
      continue;
    }
    if (token !== "--stdio") throw new TypeError(`Unsupported serve option: ${String(token)}`);
  }
  return out;
}

/** Returns configured service names while skipping accepted option values. */
function serviceModes(argv: readonly string[]): string[] {
  const modes: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--host" || token === "--port") {
      index += 1;
    } else if (token === "http" || token === "rpc" || token === "mcp") {
      modes.push(token);
    }
  }
  return modes;
}

/**
 * Wait until everything written to stdout and stderr has been handed to the OS. On a pipe, Node
 * writes asynchronously, so exiting straight after a large write dropped everything past ~64 KB.
 */
function flushStdio(): Promise<void> {
  const drain = (stream: NodeJS.WriteStream) => new Promise<void>((resolve) => stream.write("", () => resolve()));
  return Promise.all([drain(process.stdout), drain(process.stderr)]).then(() => undefined);
}

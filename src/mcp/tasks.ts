/*
MCP 2026 Tasks extension types and app-owned provider dispatch.
Argsbarg validates and routes the protocol; apps retain execution, state, and storage.
*/

import { z } from "zod";
import { AppError } from "../core/errors.ts";
import type {
  BoundDeclaration,
  Guard,
  InvocationBase,
  InvocationContext,
  InvocationOutcome,
  MaybePromise,
} from "../core/invocation.ts";
import type { Locals } from "../core/types.ts";
import { compileGuardPlan, invokeBound } from "../runtime/invoke.ts";
import { markMcpHandlerStarted } from "./progress.ts";
import {
  encodeMcpResult,
  MCP_PROTOCOL_VERSION,
  type McpErrorResponse,
  type McpProtocolError,
  type McpRequest,
  type McpRequestId,
  type McpResultResponse,
  type McpServerInfo,
  mcpErrorResponse,
} from "./protocol.ts";
import {
  isJsonValue,
  isMcpTaskInputRequests,
  isMcpTaskInputResponses,
  isMcpTaskToolResult,
  mcpTaskInputUsesSamplingTools,
} from "./task-payloads.ts";
import { type TaskSubscription, type TaskWatch, untilTaskAbort } from "./task-subscriptions.ts";

/** Stable extension identifier used in MCP capability negotiation. */
export const MCP_TASKS_EXTENSION = "io.modelcontextprotocol/tasks" as const;

/** Limits held task subscriptions per app and concurrent watches per subscription. */
const MAX_TASK_SUBSCRIPTIONS = 64;
const MAX_WATCHED_TASKS = 32;

/** Throws from a tool that cannot run without negotiated Tasks. */
export class McpTasksRequiredError extends AppError {
  /** Rejects the tool call before any background work starts. */
  constructor() {
    super("This tool requires MCP Tasks", { code: "MCP_TASKS_CAPABILITY_REQUIRED" });
  }
}

/** Throws from a provider for a missing, expired, or inaccessible task. */
export class McpTaskNotFoundError extends AppError {
  /** Uses the same error for unknown and inaccessible IDs. */
  constructor() {
    super("Task not found", { code: "MCP_TASK_NOT_FOUND" });
  }
}

/** Lifecycle state allowed by the 2026-07-28 Tasks extension. */
export type McpTaskStatus = "working" | "input_required" | "completed" | "failed" | "cancelled";

/** One server-to-client input request carried by an input-required task. */
export type McpTaskInputRequest =
  | {
      /** Standard elicitation request. */
      readonly method: "elicitation/create";
      /** Elicitation request parameters. */
      readonly params: Readonly<Record<string, unknown>>;
    }
  | {
      /** Deprecated 2026 sampling request retained by the Tasks schema. */
      readonly method: "sampling/createMessage";
      /** Sampling request parameters. */
      readonly params: Readonly<Record<string, unknown>>;
    }
  | {
      /** Deprecated 2026 roots request retained by the Tasks schema. */
      readonly method: "roots/list";
      /** Optional roots request parameters. */
      readonly params?: Readonly<Record<string, unknown>>;
    };

/** Responses to outstanding task input requests. */
export type McpTaskInputResponse =
  | {
      /** Elicitation user action. */
      readonly action: "accept" | "decline" | "cancel";
      /** Optional submitted form values. */
      readonly content?: Readonly<Record<string, unknown>>;
    }
  | {
      /** Sampling response role. */
      readonly role: "user" | "assistant";
      /** Sampling response content block or blocks. */
      readonly content: unknown;
      /** Selected model name. */
      readonly model: string;
      /** Optional sampling stop reason. */
      readonly stopReason?: string;
    }
  | {
      /** Roots returned by a client. */
      readonly roots: readonly Readonly<Record<string, unknown>>[];
    };

/** Input requests keyed by provider-owned request IDs. */
export type McpTaskInputRequests = Readonly<Record<string, McpTaskInputRequest>>;

/** Client input responses keyed to provider-owned request IDs. */
export type McpTaskInputResponses = Readonly<Record<string, McpTaskInputResponse>>;

/** Native MCP tool result stored as the terminal result of a completed task. */
export interface McpTaskToolResult {
  /** Complete MCP result discriminator. */
  readonly resultType: "complete";
  /** Native MCP content blocks returned by the original tool. */
  readonly content: readonly Readonly<Record<string, unknown>>[];
  /** Optional structured content returned by the original tool. */
  readonly structuredContent?: unknown;
  /** Whether the original tool result represents an application error. */
  readonly isError?: boolean;
  /** Optional result metadata retained from the original MCP result. */
  readonly _meta?: Readonly<Record<string, unknown>>;
}

/** Required fields shared by every app-owned MCP task snapshot. */
export interface McpTaskBase {
  /** Stable app-owned task identifier. */
  readonly taskId: string;
  /** Current task lifecycle state. */
  readonly status: McpTaskStatus;
  /** Optional human-readable task state message. */
  readonly statusMessage?: string;
  /** RFC 3339 creation time supplied by the app provider. */
  readonly createdAt: string;
  /** RFC 3339 last-update time supplied by the app provider. */
  readonly lastUpdatedAt: string;
  /** Time to live from creation in milliseconds, or `null` for unlimited. */
  readonly ttlMs: number | null;
  /** Optional suggested polling interval in milliseconds. */
  readonly pollIntervalMs?: number;
}

/** Task in a normal working state. */
export interface McpWorkingTask extends McpTaskBase {
  /** Working-state discriminator. */
  readonly status: "working";
}

/** Task waiting for app-defined request input. */
export interface McpInputRequiredTask extends McpTaskBase {
  /** Input-required discriminator. */
  readonly status: "input_required";
  /** Outstanding input requests keyed by the app provider's stable request IDs. */
  readonly inputRequests: McpTaskInputRequests;
}

/** Task with its terminal operation result. */
export interface McpCompletedTask extends McpTaskBase {
  /** Completed-state discriminator. */
  readonly status: "completed";
  /** Native MCP result object for the operation that created the task. */
  readonly result: McpTaskToolResult;
}

/** Task with its terminal JSON-RPC failure. */
export interface McpFailedTask extends McpTaskBase {
  /** Failed-state discriminator. */
  readonly status: "failed";
  /** JSON-RPC-compatible failure returned by the app provider. */
  readonly error: McpProtocolError;
}

/** Task whose cancellation was accepted and reached terminal state. */
export interface McpCancelledTask extends McpTaskBase {
  /** Cancelled-state discriminator. */
  readonly status: "cancelled";
}

/** One validated app-owned task snapshot returned by a provider. */
export type McpTask =
  | McpWorkingTask
  | McpInputRequiredTask
  | McpCompletedTask
  | McpFailedTask
  | McpCancelledTask;

/** App-owned task snapshot accepted by `mcp.tasks.reference`. */
export type McpTaskReferenceInput = McpTaskBase;

/** Runtime-only brand placed on an app task returned from a tool handler. */
const taskReference: unique symbol = Symbol("argsbarg.mcp-task-reference");

/** Associates issued handles with the exact tool invocation that created them. */
const referenceOwner = new WeakMap<McpTaskReference, McpTaskAccess>();

/** Strict RFC 3339 parser used for app-owned task lifecycle timestamps. */
const RFC3339_DATE_TIME = z.iso.datetime({ offset: true });

/** App task snapshot marked for MCP `CreateTaskResult` encoding. */
export type McpTaskReference = McpTaskBase & {
  /** Runtime-only marker proving the value came from `mcp.tasks.reference`. */
  readonly [taskReference]: true;
};

/** MCP task helper exposed only on MCP tool invocation contexts. */
export interface McpTaskAccess {
  /** True when the server has a provider and this client opted into the Tasks extension. */
  readonly available: boolean;
  /** Validates and brands an app-owned task snapshot as an MCP task reference. */
  reference(task: McpTaskReferenceInput): McpTaskReference;
}

/** MCP-only protocol controls exposed to an MCP tool handler. */
export interface McpToolProtocolContext {
  /** Task capability and reference helper for the current request. */
  readonly tasks: McpTaskAccess;
}

/** MCP tool handler context with protocol-specific task controls. */
export type McpToolInvocationContext<Input, Seed extends object> = InvocationContext<Input, Seed> & {
  /** MCP-only task controls; absent from CLI, REST, and JSON-RPC contexts. */
  readonly mcp: McpToolProtocolContext;
};

/** Common inputs supplied to an app-owned task provider operation. */
export interface McpTaskOperationContext<Seed extends object> {
  /** Provider-local task ID, after stripping any mount prefix. */
  readonly taskId: string;
  /** Fresh operation locals produced by MCP middleware and the MCP surface guard. */
  readonly locals: Seed;
  /** Exact signal for this follow-up request only. */
  readonly signal: AbortSignal;
  /** Current request's protocol revision. */
  readonly protocolVersion: typeof MCP_PROTOCOL_VERSION;
  /** Immutable client capabilities for this request, not the creation request. */
  readonly clientCapabilities: Readonly<Record<string, unknown>>;
}

/** Inputs supplied to an app-owned task input update. */
export interface McpTaskUpdateContext<Seed extends object> extends McpTaskOperationContext<Seed> {
  /** Responses keyed to the provider's outstanding input-request IDs. */
  readonly inputResponses: McpTaskInputResponses;
}

/** App-owned MCP Tasks provider. Argsbarg owns protocol framing, never the task engine. */
export interface McpTaskProvider<Seed extends object = Locals> {
  /** Returns the current complete task snapshot for the caller. */
  get(context: McpTaskOperationContext<Seed>): MaybePromise<McpTask>;
  /** Supplies pending input responses and returns when the update is accepted. */
  update(context: McpTaskUpdateContext<Seed>): MaybePromise<void>;
  /** Requests cooperative cancellation and returns once that request is accepted. */
  cancel(context: McpTaskOperationContext<Seed>): MaybePromise<void>;
  /**
   * Authorizes this caller before returning an abort-aware stream of committed snapshots.
   * Throw McpTaskNotFoundError for inaccessible tasks. Aborting the signal stops observing, not the job.
   */
  watch?(context: McpTaskOperationContext<Seed>): MaybePromise<AsyncIterable<McpTask>>;
}

/** Result emitted by one task provider dispatch. */
export interface McpTaskDispatchResult {
  /** Native MCP protocol response. */
  readonly response: McpErrorResponse | McpResultResponse;
  /** Exact D2 outcome retained for HTTP denial response mapping. */
  readonly outcome: InvocationOutcome<unknown>;
}

/** Runtime closure that accepts a task operation through one compiled D2 declaration. */
export type McpTaskInvokeDecorator<Seed extends object> = (
  /** Exact task method selected by the dispatcher. */
  method: TaskMethod | "subscriptions/listen",
  /** Raw request params supplied to the one D2 parse. */
  rawInputs: unknown,
  /** Request-owned source, signal, and mutable locals. */
  base: InvocationBase<Seed>,
  /** Compiled task invocation. */
  invoke: () => Promise<InvocationOutcome<unknown>>,
) => Promise<InvocationOutcome<unknown>>;

/** Package-internal task runtime shared by the MCP dispatcher and native adapters. */
export interface McpTaskRuntime {
  /** Returns request-capability-aware task helpers for one tool call. */
  access(request: McpRequest, toolName: string): McpTaskAccess;
  /** True when the caller opted into the 2026 Tasks extension for this request. */
  supported(request: McpRequest): boolean;
  /** Prepares guarded watches or returns a rejection before transport streaming starts. */
  subscribe(
    request: McpRequest,
    taskIds: readonly string[],
    base: InvocationBase<object>,
    serverInfo: McpServerInfo,
  ): Promise<{ readonly subscription: TaskSubscription } | { readonly response: McpErrorResponse }>;
  /** Dispatches one validated task method through caller guards and provider callbacks. */
  dispatch(
    request: McpRequest,
    base: InvocationBase<object>,
    serverInfo: McpServerInfo,
  ): Promise<McpTaskDispatchResult>;
}

/** Construction inputs for one immutable app-owned MCP task runtime. */
export interface McpTaskRuntimeOptions<Seed extends object> {
  /** Optional parent-app callbacks that own unprefixed task IDs. */
  readonly provider?: McpTaskProvider<Seed>;
  /** Parent MCP surface guard compiled before every parent task operation. */
  readonly guard?: Guard<unknown, Seed, object>;
  /** Optional parent hook wrapper applied around task operations. */
  readonly decorateInvoke?: McpTaskInvokeDecorator<Seed>;
  /** Namespaced child provider routes in addition to the optional parent provider. */
  readonly routes?: readonly McpTaskProviderRoute<Seed>[];
  /** Exact composed child tool ownership; `undefined` explicitly denies provider fallback. */
  readonly childToolRoutes?: ReadonlyMap<string, string | undefined>;
}

/** One namespaced app-owned provider mounted under a composed MCP child path. */
export interface McpTaskProviderRoute<Seed extends object> {
  /** Stable mount prefix; wire task IDs are `${prefix}__${localTaskId}`. */
  readonly prefix: string;
  /** Child app callbacks. */
  readonly provider: McpTaskProvider<Seed>;
  /** Child MCP surface guard. */
  readonly guard?: Guard<unknown, Seed, object>;
  /** Adds the child's scoped source and fresh mount locals. */
  readonly prepareBase?: (base: InvocationBase<Seed>) => InvocationBase<Seed>;
  /** Child hook/error-reporter wrapper. */
  readonly decorateInvoke?: McpTaskInvokeDecorator<Seed>;
}

/** Creates one provider-backed runtime for exact 2026 Tasks extension methods. */
export function createMcpTaskRuntime<Seed extends object>(
  options: McpTaskRuntimeOptions<Seed>,
): McpTaskRuntime {
  const routes = createTaskRoutes(options);
  let subscriptionCount = 0;
  const canWatch = routes.some((route) => route.invocations.watch !== undefined);
  const runtime: McpTaskRuntime = {
    access: (request: McpRequest, toolName: string) =>
      createTaskAccess(
        supportsTasks(request) && routeForTool(routes, toolName, options.childToolRoutes) !== undefined,
        routeForTool(routes, toolName, options.childToolRoutes),
        routes,
      ),
    supported: supportsTasks,
    subscribe: async (request, taskIds, base, serverInfo) => {
      const id = request.id;
      if (id === undefined) throw new TypeError("MCP subscriptions require a request ID");
      if (!canWatch) return { response: mcpErrorResponse(id, -32_601, "Method not found") };
      if (taskIds.length > MAX_WATCHED_TASKS) {
        return { response: mcpErrorResponse(id, -32_602, "Too many task IDs in subscription") };
      }
      if (subscriptionCount >= MAX_TASK_SUBSCRIPTIONS) {
        return { response: mcpErrorResponse(id, -32_603, "Task subscription capacity reached") };
      }
      subscriptionCount++;
      const controller = new AbortController();
      const watches: TaskWatch[] = [];
      const capabilities = immutableCapabilities(request.meta?.clientCapabilities ?? {});
      /** Links transport cancellation to watch preparation and reads. */
      const abort = (): void => controller.abort(base.signal.reason);
      base.signal.addEventListener("abort", abort, { once: true });
      if (base.signal.aborted) abort();
      let disposed = false;
      const subscription: TaskSubscription = {
        id,
        serverInfo,
        watches,
        controller,
        dispose() {
          if (disposed) return;
          disposed = true;
          controller.abort();
          base.signal.removeEventListener("abort", abort);
          subscriptionCount--;
          for (const { iterator } of watches) {
            void Promise.resolve().then(() => iterator.return?.()).catch(() => {
              // The provider signal is already aborted; teardown cannot replace the wire outcome.
            });
          }
        },
      };
      const deadline = setTimeout(() => controller.abort(), 15_000);
      try {
        for (const taskId of new Set(taskIds)) {
          const selected = routeForTaskId(routes, taskId);
          const watch = selected?.route.invocations.watch;
          if (selected === undefined || watch === undefined || controller.signal.aborted) continue;
          const fresh = { ...base, locals: { ...base.locals }, signal: controller.signal } as InvocationBase<Seed>;
          const selectedBase = selected.route.route.prepareBase?.(fresh) ?? fresh;
          const rawInputs = { taskId: selected.localTaskId };
          /** Runs the watch setup through the same guard and hooks as polling. */
          const invoke = () => watch(rawInputs, selectedBase, capabilities);
          const decorate = selected.route.route.decorateInvoke;
          const outcome = await untilTaskAbort(
            decorate === undefined ? invoke() : decorate("subscriptions/listen", rawInputs, selectedBase, invoke),
            controller.signal,
          );
          if (outcome === undefined || outcome.kind === "denied") continue;
          if (outcome.kind === "error" && outcome.error instanceof McpTaskNotFoundError) continue;
          if (outcome.kind !== "ok" || !isTaskIterable(outcome.result)) {
            throw new TypeError("Task watch failed to open");
          }
          const iterator = outcome.result[Symbol.asyncIterator]();
          if (typeof iterator?.next !== "function") throw new TypeError("Task watch returned an invalid iterator");
          watches.push({
            id: taskId,
            iterator,
            snapshot: (value) => taskSnapshotForWire(value, selected, capabilities),
          });
        }
        if (controller.signal.aborted) throw new Error("Task watch preparation was cancelled");
        return { subscription };
      } catch {
        subscription.dispose();
        return { response: mcpErrorResponse(id, -32_603, "Task subscription could not be opened") };
      } finally {
        clearTimeout(deadline);
      }
    },
    dispatch: async (
      request: McpRequest,
      base: InvocationBase<object>,
      serverInfo: McpServerInfo,
    ): Promise<McpTaskDispatchResult> => {
      const operation = taskOperation(request.method);
      if (operation === undefined) {
        throw new TypeError(`Unsupported MCP task method ${JSON.stringify(request.method)}`);
      }
      if (request.id === undefined) throw new TypeError("MCP task operations require a request ID");
      if (!supportsTasks(request)) {
        return {
          response: missingMcpCapabilities(request.id),
          outcome: taskUnsupportedOutcome(),
        };
      }
      const taskId = request.params.taskId;
      if (typeof taskId !== "string" || taskId.length === 0) {
        return { response: mcpErrorResponse(request.id, -32_602, "Invalid taskId"), outcome: taskInvalidOutcome() };
      }
      const selected = routeForTaskId(routes, taskId);
      if (selected === undefined) {
        return { response: mcpErrorResponse(request.id, -32_602, "Unknown task ID"), outcome: taskInvalidOutcome() };
      }
      const invokeOperation = selected.route.invocations[operation];
      const { _meta: _metaValue, ...params } = request.params;
      const rawInputs = { ...params, taskId: selected.localTaskId };
      const selectedBase =
        selected.route.route.prepareBase?.(base as InvocationBase<Seed>) ?? (base as InvocationBase<Seed>);
      const clientCapabilities = immutableCapabilities(request.meta?.clientCapabilities ?? {});
      const invoke = (): Promise<InvocationOutcome<unknown>> =>
        invokeOperation(rawInputs, selectedBase, clientCapabilities);
      let outcome: InvocationOutcome<unknown>;
      try {
        outcome = selected.route.route.decorateInvoke === undefined
          ? await invoke()
          : await selected.route.route.decorateInvoke(request.method as TaskMethod, rawInputs, selectedBase, invoke);
      } catch (error) {
        outcome = { kind: "error", error, stdout: "", stderr: "" };
      }
      return {
        outcome,
        response: encodeTaskOutcome(request.id, operation, outcome, serverInfo, selected, clientCapabilities),
      };
    },
  };
  return Object.freeze(runtime);
}

/** One immutable compiled provider route. */
interface CompiledTaskRoute<Seed extends object> {
  /** Public prefix, including trailing `__`; empty for the parent provider. */
  readonly prefix: string;
  /** Original public provider route and policy. */
  readonly route: McpTaskProviderRoute<Seed>;
  /** Guarded operation invocations. */
  readonly invocations: TaskInvocations<Seed>;
}

/** Result of resolving one wire task ID to its owning provider. */
interface SelectedTaskRoute<Seed extends object> {
  /** Selected compiled route. */
  readonly route: CompiledTaskRoute<Seed>;
  /** App-owned task ID after removing the public mount prefix. */
  readonly localTaskId: string;
}

/** Builds one parent route plus every configured child provider route. */
function createTaskRoutes<Seed extends object>(
  options: McpTaskRuntimeOptions<Seed>,
): readonly CompiledTaskRoute<Seed>[] {
  const routes: CompiledTaskRoute<Seed>[] = [];
  if (options.provider !== undefined) {
    const route: McpTaskProviderRoute<Seed> = {
      prefix: "",
      provider: options.provider,
      ...(options.guard === undefined ? {} : { guard: options.guard }),
      ...(options.decorateInvoke === undefined ? {} : { decorateInvoke: options.decorateInvoke }),
    };
    routes.push({
      prefix: "",
      route,
      invocations: createTaskInvocations(route.provider, route.guard),
    });
  }
  for (const route of options.routes ?? []) {
    const prefix = route.prefix.length === 0 ? "" : `${route.prefix.replace(/_+$/, "")}__`;
    if (routes.some((candidate) => candidate.prefix === prefix)) {
      throw new TypeError(`Duplicate MCP Tasks provider prefix ${JSON.stringify(prefix)}`);
    }
    routes.push({
      prefix,
      route: { ...route, prefix },
      invocations: createTaskInvocations(route.provider, route.guard),
    });
  }
  if (routes.length === 0) throw new TypeError("MCP Tasks runtime requires at least one provider");
  return routes.sort((left, right) => right.prefix.length - left.prefix.length);
}

/** Selects the task provider owned by a composed MCP tool name. */
function routeForTool<Seed extends object>(
  routes: readonly CompiledTaskRoute<Seed>[],
  toolName: string,
  childToolRoutes: ReadonlyMap<string, string | undefined> | undefined,
): CompiledTaskRoute<Seed> | undefined {
  if (childToolRoutes?.has(toolName)) {
    const prefix = childToolRoutes.get(toolName);
    return prefix === undefined
      ? undefined
      : routes.find((route) => route.prefix === `${prefix}__`);
  }
  return routes.find((route) => route.prefix === "");
}

/** Selects and strips the deterministic provider prefix from a wire task ID. */
function routeForTaskId<Seed extends object>(
  routes: readonly CompiledTaskRoute<Seed>[],
  taskId: string,
): SelectedTaskRoute<Seed> | undefined {
  for (const route of routes) {
    if (route.prefix !== "" && taskId.startsWith(route.prefix)) {
      const localTaskId = taskId.slice(route.prefix.length);
      if (localTaskId.length === 0) return undefined;
      return { route, localTaskId };
    }
  }
  const root = routes.find((route) => route.prefix === "");
  return root === undefined ? undefined : { route: root, localTaskId: taskId };
}

/** Returns a disabled task helper for local mirror calls that cannot negotiate task capability. */
export function unavailableMcpTaskAccess(): McpTaskAccess {
  return createTaskAccess(false, undefined, []);
}

/** True when a handler returned a task snapshot created by `mcp.tasks.reference`. */
export function isMcpTaskReference(value: unknown): value is McpTaskReference {
  return typeof value === "object" && value !== null && (value as Record<PropertyKey, unknown>)[taskReference] === true;
}

/** Encodes a branded task snapshot as the exact flat 2026 `CreateTaskResult`. */
export function encodeMcpTaskReference(
  id: McpRequestId,
  reference: McpTaskReference,
  serverInfo: McpServerInfo,
  access: McpTaskAccess,
): McpResultResponse {
  if (!access.available || referenceOwner.get(reference) !== access) {
    throw new TypeError("MCP task reference was not issued by this invocation");
  }
  return {
    jsonrpc: "2.0",
    id,
    result: {
      ...reference,
      resultType: "task",
      _meta: {
        "io.modelcontextprotocol/serverInfo": { name: serverInfo.name, version: serverInfo.version },
      },
    },
  };
}

/** Method names dispatched by the Tasks extension. */
type TaskMethod = "tasks/get" | "tasks/update" | "tasks/cancel";

/** Internal task operation name. */
type TaskOperation = "get" | "update" | "cancel";

/** Compiled request invocations shared by all requests for one task provider. */
type TaskInvocations<Seed extends object> = Record<
  TaskOperation,
  (rawInputs: unknown, base: InvocationBase<Seed>, capabilities: Readonly<Record<string, unknown>>) =>
    Promise<InvocationOutcome<unknown>>
> & { readonly watch?: TaskInvocations<Seed>["get"] };

/** Creates strict request schemas and one guarded D2 invocation per task operation. */
function createTaskInvocations<Seed extends object>(
  provider: McpTaskProvider<Seed>,
  guard: Guard<unknown, Seed, object> | undefined,
): TaskInvocations<Seed> {
  const get = z.object({ taskId: z.string().min(1) });
  const update = z.object({
    taskId: z.string().min(1),
    inputResponses: z.custom<McpTaskInputResponses>(isMcpTaskInputResponses, "Invalid MCP task input responses"),
  });
  const cancel = get;
  return {
    get: taskInvocation(get, guard, (context) => provider.get(context)),
    update: taskInvocation(update, guard, (context) => provider.update(context)),
    cancel: taskInvocation(cancel, guard, (context) => provider.cancel(context)),
    watch: provider.watch === undefined ? undefined : taskInvocation(get, guard, provider.watch.bind(provider)),
  };
}

/** Checks the eager provider watch result without advancing it before acknowledgment. */
function isTaskIterable(value: unknown): value is AsyncIterable<McpTask> {
  return typeof value === "object" && value !== null &&
    Symbol.asyncIterator in value && typeof value[Symbol.asyncIterator] === "function";
}

/** Builds one strict task invocation whose handler receives provider-safe fields only. */
function taskInvocation<
  Schema extends z.ZodType<{ taskId: string }>,
  Seed extends object,
>(
  inputSchema: Schema,
  guard: Guard<unknown, Seed, object> | undefined,
  provider: (
    context: z.output<Schema> & McpTaskOperationContext<Seed>,
  ) => unknown | Promise<unknown>,
): TaskInvocations<Seed>[TaskOperation] {
  const compile = compileGuardPlan<z.output<Schema>, Seed>();
  const guardPlan = compile({ surface: guard as Guard<z.output<Schema>, Seed, object> | undefined });
  return (rawInputs, base, clientCapabilities) => {
    const declaration = {
      inputSchema,
      guardPlan,
      handler: (context: InvocationContext<z.output<Schema>, Seed>) => {
        markMcpHandlerStarted(context.locals);
        return provider({
          ...context.inputs,
          locals: context.locals,
          signal: context.signal,
          protocolVersion: MCP_PROTOCOL_VERSION,
          clientCapabilities,
        });
      },
    } as BoundDeclaration<Schema, unknown, Seed>;
    return invokeBound({ declaration, rawInputs, base, forbidChdir: true });
  };
}

/** True for the official Tasks extension capability shape. */
export function supportsTasks(request: McpRequest): boolean {
  const extensions = request.meta?.clientCapabilities.extensions;
  if (
    !(
    typeof extensions === "object" &&
    extensions !== null &&
      !Array.isArray(extensions)
    )
  ) {
    return false;
  }
  const declared = (extensions as Record<string, unknown>)[MCP_TASKS_EXTENSION];
  return typeof declared === "object" && declared !== null && !Array.isArray(declared) && Object.keys(declared).length === 0;
}

/** Encodes the current request's missing capability set. */
export function missingMcpCapabilities(
  id: McpRequestId,
  requiredCapabilities: Readonly<Record<string, unknown>> = { extensions: { [MCP_TASKS_EXTENSION]: {} } },
): McpErrorResponse {
  return mcpErrorResponse(id, -32_021, "Missing required client capability", { requiredCapabilities });
}

/** Copies and freezes JSON capabilities without exposing the decoded envelope to providers. */
function immutableCapabilities(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, freezeCapability(item)])));
}

/** Freezes one nested value in a request's JSON capability map. */
function freezeCapability(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeCapability));
  if (isRecord(value)) return immutableCapabilities(value);
  return value;
}

/** Finds capabilities missing for the pending input variants in this task. */
function missingInputCapabilities(
  requests: McpTaskInputRequests,
  capabilities: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const required: Record<string, unknown> = {};
  const elicitation: Record<string, object> = {};
  const sampling: Record<string, object> = {};
  for (const request of Object.values(requests)) {
    if (request.method === "roots/list" && !isRecord(capabilities.roots)) required.roots = {};
    if (request.method === "elicitation/create") {
      const mode = request.params.mode === "url" ? "url" : "form";
      const declared = capabilities.elicitation;
      const implicitForm = mode === "form" && isRecord(declared) &&
        declared.form === undefined && declared.url === undefined;
      if (!implicitForm && !(isRecord(declared) && isRecord(declared[mode]))) elicitation[mode] = {};
    }
    if (request.method === "sampling/createMessage") {
      const declared = capabilities.sampling;
      if (!isRecord(declared)) required.sampling = sampling;
      if (request.params.includeContext !== undefined && request.params.includeContext !== "none" &&
        !(isRecord(declared) && isRecord(declared.context))) {
        sampling.context = {};
        required.sampling = sampling;
      }
      if (mcpTaskInputUsesSamplingTools(request) && !(isRecord(declared) && isRecord(declared.tools))) {
        sampling.tools = {};
        required.sampling = sampling;
      }
    }
  }
  if (Object.keys(elicitation).length !== 0) required.elicitation = elicitation;
  return required;
}

/** Creates immutable, validated task helpers for one tool call. */
function createTaskAccess<Seed extends object>(
  available: boolean,
  route: CompiledTaskRoute<Seed> | undefined,
  routes: readonly CompiledTaskRoute<Seed>[],
): McpTaskAccess {
  const access: McpTaskAccess = Object.freeze({
    available,
    reference: (task: McpTaskReferenceInput): McpTaskReference => {
      if (!available) throw new McpTasksRequiredError();
      const validated = validateTaskBase(task);
      const taskId = `${route?.prefix ?? ""}${validated.taskId}`;
      const selected = routeForTaskId(routes, taskId);
      if (
        selected === undefined ||
        selected.route !== route ||
        selected.localTaskId !== validated.taskId
      ) {
        throw new TypeError(
          `MCP task ID ${JSON.stringify(validated.taskId)} collides with a mounted child provider namespace`,
        );
      }
      const reference = Object.freeze({
        ...validated,
        taskId,
        [taskReference]: true as const,
      });
      referenceOwner.set(reference, access);
      return reference;
    },
  });
  return access;
}

/** Converts one task method string into its runtime operation. */
function taskOperation(method: string): TaskOperation | undefined {
  if (method === "tasks/get") return "get";
  if (method === "tasks/update") return "update";
  if (method === "tasks/cancel") return "cancel";
  return undefined;
}

/** Encodes one task provider outcome as the protocol-specific response. */
function encodeTaskOutcome<Seed extends object>(
  id: McpRequestId,
  operation: TaskOperation,
  outcome: InvocationOutcome<unknown>,
  serverInfo: McpServerInfo,
  selected: SelectedTaskRoute<Seed>,
  capabilities: Readonly<Record<string, unknown>>,
): McpErrorResponse | McpResultResponse {
  if (outcome.kind === "ok") {
    if (operation === "get") {
      try {
        return encodeMcpResult(id, { ...taskSnapshotForWire(outcome.result, selected, capabilities) }, serverInfo);
      } catch (error) {
        return error instanceof TaskInputCapabilityError
          ? missingMcpCapabilities(id, error.required)
          : mcpErrorResponse(id, -32_603, "Task provider returned an invalid snapshot");
      }
    }

    return encodeMcpResult(id, {}, serverInfo);
  }
  if (outcome.kind === "invalid") return mcpErrorResponse(id, -32_602, "Invalid task operation params");
  if (outcome.kind === "denied") {
    return mcpErrorResponse(id, -32_003, outcome.denial.message, { code: outcome.denial.code });
  }
  if (outcome.error instanceof McpTaskNotFoundError) {
    return mcpErrorResponse(id, -32_602, "Task not found");
  }
  return mcpErrorResponse(id, -32_603, "Task operation failed");
}

/** Carries the exact missing capability details for a polling response. */
class TaskInputCapabilityError extends Error {
  /** Capabilities required by the pending task input requests. */
  readonly required: Readonly<Record<string, unknown>>;

  /** Records missing input capabilities without exposing the pending input itself. */
  constructor(required: Readonly<Record<string, unknown>>) {
    super("Client is missing capabilities required by the task snapshot");
    this.required = required;
  }
}

/** Gives polling and subscriptions the same snapshot validation and public task identity. */
function taskSnapshotForWire<Seed extends object>(
  value: unknown,
  selected: SelectedTaskRoute<Seed>,
  capabilities: Readonly<Record<string, unknown>>,
): McpTask {
  const task = validateMcpTask(value);
  if (task.taskId !== selected.localTaskId) throw new TypeError("Task provider returned an invalid snapshot");
  if (task.status === "input_required") {
    const missing = missingInputCapabilities(task.inputRequests, capabilities);
    if (Object.keys(missing).length !== 0) throw new TaskInputCapabilityError(missing);
  }
  return { ...task, taskId: `${selected.route.prefix}${task.taskId}` };
}

/** Validates and copies only the fields allowed on a creation handle. */
function validateTaskBase(value: unknown): McpTaskBase {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Task provider returned an invalid task");
  }
  const record = value as Record<string, unknown>;
  const taskId = record.taskId;
  const status = record.status;
  const createdAt = record.createdAt;
  const lastUpdatedAt = record.lastUpdatedAt;
  const ttlMs = record.ttlMs;
  const pollIntervalMs = record.pollIntervalMs;
  if (
    typeof taskId !== "string" ||
    taskId.length === 0 ||
    !isTaskStatus(status) ||
    typeof createdAt !== "string" || !RFC3339_DATE_TIME.safeParse(createdAt).success ||
    typeof lastUpdatedAt !== "string" || !RFC3339_DATE_TIME.safeParse(lastUpdatedAt).success ||
    (record.statusMessage !== undefined && typeof record.statusMessage !== "string") ||
    !validDuration(ttlMs, true) ||
    (pollIntervalMs !== undefined && !validDuration(pollIntervalMs, false))
  ) {
    throw new TypeError("Task provider returned an invalid task");
  }
  return {
    taskId,
    status,
    createdAt,
    lastUpdatedAt,
    ttlMs: ttlMs as number | null,
    ...(typeof record.statusMessage === "string" ? { statusMessage: record.statusMessage } : {}),
    ...(pollIntervalMs === undefined ? {} : { pollIntervalMs: pollIntervalMs as number }),
  };
}

/** Validates and copies one detailed provider snapshot for polling. */
function validateMcpTask(value: unknown): McpTask {
  if (!isRecord(value)) throw new TypeError("Task provider returned an invalid task");
  const common = validateTaskBase(value);
  const { status } = common;
  const record = value;
  if (status === "working" || status === "cancelled") return { ...common, status };
  if (status === "input_required" && isMcpTaskInputRequests(record.inputRequests)) {
    return { ...common, status, inputRequests: record.inputRequests };
  }
  if (status === "completed" && isMcpTaskToolResult(record.result)) {
    return { ...common, status, result: record.result };
  }
  if (status === "failed" && isProtocolError(record.error)) {
    return { ...common, status, error: record.error };
  }
  throw new TypeError("Task provider returned an invalid status payload");
}

/** Returns true only for the exact 2026 task lifecycle set. */
function isTaskStatus(value: unknown): value is McpTaskStatus {
  return (
    value === "working" ||
    value === "input_required" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled"
  );
}

/** Validates task duration fields against the extension's integer bounds. */
function validDuration(value: unknown, nullable: boolean): boolean {
  if (nullable && value === null) return true;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Checks the wire-safe JSON-RPC error subset carried by failed tasks. */
function isProtocolError(value: unknown): value is McpProtocolError {
  if (!isRecord(value)) return false;
  return (
    typeof value.code === "number" &&
    Number.isSafeInteger(value.code) &&
    typeof value.message === "string" &&
    isJsonValue(value)
  );
}

/** Creates a synthetic error outcome for requests rejected before provider invocation. */
function taskUnsupportedOutcome(): InvocationOutcome<unknown> {
  return {
    kind: "error",
    error: new AppError("MCP Tasks client capability is required for this request", {
      code: "MCP_TASKS_CAPABILITY_REQUIRED",
    }),
    stdout: "",
    stderr: "",
  };
}

/** Creates a synthetic parse outcome for invalid task method inputs. */
function taskInvalidOutcome(): InvocationOutcome<unknown> {
  return {
    kind: "error",
    error: new AppError("MCP task ID is invalid or cannot be routed", {
      code: "MCP_TASK_ID_INVALID",
    }),
    stdout: "",
    stderr: "",
  };
}

/** Checks for a non-null object without accepting arrays. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

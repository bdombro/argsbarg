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
  type McpErrorResponse,
  type McpProtocolError,
  type McpRequest,
  type McpRequestId,
  type McpResultResponse,
  type McpServerInfo,
  mcpErrorResponse,
} from "./protocol.ts";

/** Stable extension identifier used in MCP capability negotiation. */
export const MCP_TASKS_EXTENSION = "io.modelcontextprotocol/tasks" as const;

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
  /** Remaining lifetime in milliseconds, or `null` for unlimited. */
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
export type McpTaskReferenceInput = McpTask;

/** Runtime-only brand placed on an app task returned from a tool handler. */
const taskReference: unique symbol = Symbol("argsbarg.mcp-task-reference");

/** Strict RFC 3339 parser used for app-owned task lifecycle timestamps. */
const RFC3339_DATE_TIME = z.iso.datetime({ offset: true });

/** App task snapshot marked for MCP `CreateTaskResult` encoding. */
export type McpTaskReference = McpTask & {
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
  /** Exact task ID supplied by the client. */
  readonly taskId: string;
  /** Fresh operation locals produced by MCP middleware and the MCP surface guard. */
  readonly locals: Seed;
  /** Exact signal for this follow-up request only. */
  readonly signal: AbortSignal;
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
  method: "tasks/get" | "tasks/update" | "tasks/cancel",
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
  const runtime: McpTaskRuntime = {
    access: (request: McpRequest, toolName: string) =>
      createTaskAccess(
        supportsTasks(request) && routeForTool(routes, toolName, options.childToolRoutes) !== undefined,
        routeForTool(routes, toolName, options.childToolRoutes),
        routes,
      ),
    supported: supportsTasks,
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
          response: mcpErrorResponse(request.id, -32_021, "Missing required client capability", {
            requiredCapabilities: {
              extensions: {
                [MCP_TASKS_EXTENSION]: {},
              },
            },
          }),
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
      const invoke = (): Promise<InvocationOutcome<unknown>> =>
        invokeOperation(rawInputs, selectedBase);
      const outcome =
        selected.route.route.decorateInvoke === undefined
          ? await invoke()
          : await selected.route.route.decorateInvoke(request.method as TaskMethod, rawInputs, selectedBase, invoke);
      return {
        outcome,
        response: encodeTaskOutcome(request.id, operation, outcome, serverInfo, selected.route.prefix),
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
): McpResultResponse {
  const task = validateMcpTask(reference);
  return {
    jsonrpc: "2.0",
    id,
    result: {
      ...task,
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
  (rawInputs: unknown, base: InvocationBase<Seed>) => Promise<InvocationOutcome<unknown>>
>;

/** Creates strict request schemas and one guarded D2 invocation per task operation. */
function createTaskInvocations<Seed extends object>(
  provider: McpTaskProvider<Seed>,
  guard: Guard<unknown, Seed, object> | undefined,
): TaskInvocations<Seed> {
  const get = z.strictObject({ taskId: z.string().min(1) });
  const update = z.strictObject({
    taskId: z.string().min(1),
    inputResponses: z.record(z.string(), z.unknown()).transform((value, context) => {
      try {
        return validateInputResponses(value);
      } catch {
        context.addIssue({ code: "custom", message: "Invalid MCP task input responses" });
        return z.NEVER;
      }
    }),
  });
  const cancel = z.strictObject({ taskId: z.string().min(1) });
  return {
    get: taskInvocation(get, guard, async ({ taskId, locals, signal }) => {
      const task = validateMcpTask(await provider.get({ taskId, locals, signal }));
      if (task.taskId !== taskId) {
        throw new TypeError(
          `MCP Tasks provider returned task ${JSON.stringify(task.taskId)} for ${JSON.stringify(taskId)}`,
        );
      }
      return task;
    }),
    update: taskInvocation(update, guard, ({ taskId, inputResponses, locals, signal }) =>
      provider.update({ taskId, inputResponses, locals, signal }),
    ),
    cancel: taskInvocation(cancel, guard, ({ taskId, locals, signal }) => provider.cancel({ taskId, locals, signal })),
  };
}

/** Builds one strict task invocation whose handler receives provider-safe fields only. */
function taskInvocation<
  Schema extends z.ZodType<Record<string, unknown>>,
  Seed extends object,
>(
  inputSchema: Schema,
  guard: Guard<unknown, Seed, object> | undefined,
  provider: (
    context: z.output<Schema> & {
      /** Fresh request locals after the MCP surface guard. */
      locals: Seed;
      /** Exact follow-up request signal. */
      signal: AbortSignal;
    },
  ) => unknown | Promise<unknown>,
): (rawInputs: unknown, base: InvocationBase<Seed>) => Promise<InvocationOutcome<unknown>> {
  const compile = compileGuardPlan<z.output<Schema>, Seed>();
  const declaration = {
    inputSchema,
    guardPlan: compile({ surface: guard as Guard<z.output<Schema>, Seed, object> | undefined }),
    handler: (context: InvocationContext<z.output<Schema>, Seed>) => {
      markMcpHandlerStarted(context.locals);
      return provider({ ...context.inputs, locals: context.locals, signal: context.signal });
    },
  } as BoundDeclaration<Schema, unknown, Seed>;
  return (rawInputs, base) => invokeBound({ declaration, rawInputs, base });
}

/** True for the official Tasks extension capability shape. */
function supportsTasks(request: McpRequest): boolean {
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

/** Creates immutable, validated task helpers for one tool call. */
function createTaskAccess<Seed extends object>(
  available: boolean,
  route: CompiledTaskRoute<Seed> | undefined,
  routes: readonly CompiledTaskRoute<Seed>[],
): McpTaskAccess {
  return Object.freeze({
    available,
    reference: (task: McpTaskReferenceInput): McpTaskReference => {
      if (!available) throw new TypeError("MCP Tasks is unavailable for this client request");
      const validated = validateMcpTask(task);
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
      return Object.freeze({
        ...validated,
        taskId,
        [taskReference]: true as const,
      }) as McpTaskReference;
    },
  });
}

/** Converts one task method string into its runtime operation. */
function taskOperation(method: string): TaskOperation | undefined {
  if (method === "tasks/get") return "get";
  if (method === "tasks/update") return "update";
  if (method === "tasks/cancel") return "cancel";
  return undefined;
}

/** Encodes one task provider outcome as the protocol-specific response. */
function encodeTaskOutcome(
  id: McpRequestId,
  operation: TaskOperation,
  outcome: InvocationOutcome<unknown>,
  serverInfo: McpServerInfo,
  prefix: string,
): McpErrorResponse | McpResultResponse {
  if (outcome.kind === "ok") {
    if (operation === "get") {
      return encodeMcpResult(
        id,
        prefixTask(validateMcpTask(outcome.result), prefix) as unknown as Readonly<Record<string, unknown>>,
        serverInfo,
      );
    }

    /** Adds the selected provider's public namespace to one task snapshot. */
    function prefixTask(task: McpTask, prefix: string): McpTask {
      return prefix.length === 0 ? task : ({ ...task, taskId: `${prefix}${task.taskId}` } as McpTask);
    }
    return encodeMcpResult(id, {}, serverInfo);
  }
  if (outcome.kind === "invalid") return mcpErrorResponse(id, -32_602, "Invalid task operation params");
  if (outcome.kind === "denied") {
    return mcpErrorResponse(id, -32_003, outcome.denial.message, { code: outcome.denial.code });
  }
  if (outcome.error instanceof AppError) {
    return mcpErrorResponse(id, -32_000, outcome.error.message, {
      code: outcome.error.code,
      ...(outcome.error.details === undefined ? {} : { details: outcome.error.details }),
    });
  }
  return mcpErrorResponse(id, -32_603, "Task operation failed");
}

/** Validates and copies one provider-owned task snapshot for wire use. */
function validateMcpTask(value: unknown): McpTask {
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
    !RFC3339_DATE_TIME.safeParse(createdAt).success ||
    !RFC3339_DATE_TIME.safeParse(lastUpdatedAt).success ||
    !validDuration(ttlMs, true) ||
    (pollIntervalMs !== undefined && !validDuration(pollIntervalMs, false))
  ) {
    throw new TypeError("Task provider returned an invalid task");
  }
  const common = {
    taskId,
    status,
    createdAt,
    lastUpdatedAt,
    ttlMs: ttlMs as number | null,
    ...(typeof record.statusMessage === "string" ? { statusMessage: record.statusMessage } : {}),
    ...(pollIntervalMs === undefined ? {} : { pollIntervalMs: pollIntervalMs as number }),
  };
  if (status === "working" || status === "cancelled") return validateJsonValue(common as McpTask);
  if (status === "input_required") {
    const inputRequests = validateInputRequests(record.inputRequests);
    return validateJsonValue({ ...common, status, inputRequests } as McpTask);
  }
  if (status === "completed") {
    const result = validateToolTaskResult(record.result);
    return validateJsonValue({ ...common, status, result } as McpTask);
  }
  if (!isProtocolError(record.error)) throw new TypeError("Failed task needs a JSON-RPC error");
  return validateJsonValue({ ...common, status, error: record.error } as McpTask);
}

/** Validates one provider-owned map of MCP input requests. */
function validateInputRequests(value: unknown): McpTaskInputRequests {
  if (!isRecord(value)) throw new TypeError("Input-required task needs inputRequests");
  const entries = Object.entries(value).map(([key, request]) => {
    if (
      !isRecord(request) ||
      ((request.method === "elicitation/create" || request.method === "sampling/createMessage")
        ? !isRecord(request.params)
        : request.method !== "roots/list" ||
          (request.params !== undefined && !isRecord(request.params)))
    ) {
      throw new TypeError(`Invalid MCP task input request ${JSON.stringify(key)}`);
    }
    return [
      key,
      request as unknown as McpTaskInputRequest,
    ] as const;
  });
  return Object.fromEntries(entries);
}

/** Validates one client-provided map of MCP task input responses. */
function validateInputResponses(value: unknown): McpTaskInputResponses {
  if (!isRecord(value)) throw new TypeError("Task inputResponses must be an object");
  const entries = Object.entries(value).map(([key, response]) => {
    if (!isRecord(response)) throw new TypeError(`Invalid MCP task input response ${JSON.stringify(key)}`);
    const elicitation =
      (response.action === "accept" || response.action === "decline" || response.action === "cancel") &&
      (response.content === undefined || isRecord(response.content));
    const sampling =
      (response.role === "user" || response.role === "assistant") &&
      typeof response.model === "string" &&
      (isMcpContentBlock(response.content) ||
        (Array.isArray(response.content) &&
          response.content.every(isMcpContentBlock))) &&
      (response.stopReason === undefined || typeof response.stopReason === "string");
    const roots =
      Array.isArray(response.roots) &&
      response.roots.every(
        (root) =>
          isRecord(root) &&
          typeof root.uri === "string" &&
          (root.name === undefined || typeof root.name === "string"),
      );
    if (!elicitation && !sampling && !roots) {
      throw new TypeError(`Invalid MCP task input response ${JSON.stringify(key)}`);
    }
    return [key, response as unknown as McpTaskInputResponse] as const;
  });
  return Object.fromEntries(entries);
}

/** Validates one completed task's original MCP tools/call result. */
function validateToolTaskResult(value: unknown): McpTaskToolResult {
  if (
    !isRecord(value) ||
    value.resultType !== "complete" ||
    !Array.isArray(value.content) ||
    !value.content.every(isMcpContentBlock) ||
    (value.isError !== undefined && typeof value.isError !== "boolean") ||
    (value._meta !== undefined && !isRecord(value._meta))
  ) {
    throw new TypeError("Completed task needs a valid MCP CallToolResult");
  }
  const result = value as unknown as McpTaskToolResult;
  validateJsonValue(result);
  return result;
}

/** Checks one native MCP content block used in a completed task result. */
function isMcpContentBlock(value: unknown): boolean {
  if (!isRecord(value) || (value._meta !== undefined && !isRecord(value._meta))) return false;
  switch (value.type) {
    case "text":
      return typeof value.text === "string";
    case "image":
    case "audio":
      return typeof value.data === "string" && typeof value.mimeType === "string";
    case "resource_link":
      return (
        typeof value.uri === "string" &&
        typeof value.name === "string" &&
        (value.description === undefined || typeof value.description === "string") &&
        (value.mimeType === undefined || typeof value.mimeType === "string") &&
        (value.size === undefined ||
          (typeof value.size === "number" && Number.isSafeInteger(value.size) && value.size >= 0))
      );
    case "resource": {
      const resource = value.resource;
      return (
        isRecord(resource) &&
        typeof resource.uri === "string" &&
        (typeof resource.text === "string" || typeof resource.blob === "string") &&
        (resource.mimeType === undefined || typeof resource.mimeType === "string")
      );
    }
    default:
      return false;
  }
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
    (value.data === undefined || value.data !== undefined)
  );
}

/** Rejects task payloads that cannot cross the MCP JSON wire. */
function validateJsonValue<T extends object>(task: T): T {
  try {
    JSON.stringify(task);
  } catch {
    throw new TypeError("Task provider returned a non-JSON task value");
  }

  return task;
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

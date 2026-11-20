/*
Immutable MCP tool catalog shared by discovery and dispatch.
It owns wire-schema copies, deterministic ordering, and exact name lookup.
*/

import type { z } from "zod";
import type {
  BoundDeclaration,
  CompiledGuard,
  Guard,
  InvocationBase,
  InvocationContext,
  InvocationOutcome,
  MaybePromise,
  OperationGuard,
} from "../core/invocation.ts";
import { compileGuardPlan, composeGuardPlanSurface, invokeBound } from "../runtime/invoke.ts";
import { toJsonSchema } from "../core/zod-schema.ts";

/** Framework-private marker used to arm HTTP progress only after guard work reaches the handler. */
export const MCP_HANDLER_STARTED = Symbol("argsbarg.mcp-handler-started");

/** One explicitly registered MCP tool and its native bound declaration. */
export interface McpToolEntry<
  InputSchema extends z.ZodType = z.ZodType,
  Result = unknown,
  Locals extends object = object,
  Seed extends object = Locals,
> {
  /** Unique wire name accepted by `tools/call`. */
  readonly name: string;
  /** Human-readable tool description emitted by `tools/list`. */
  readonly description: string;
  /** Object-rooted JSON Schema emitted for tool arguments. */
  readonly inputSchema: Readonly<Record<string, unknown>>;
  /** Optional object-rooted JSON Schema emitted for structured output. */
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  /** Optional advisory MCP tool annotations. */
  readonly annotations?: Readonly<Record<string, unknown>>;
  /** Whether callers must put the authored input under the `input` object-root marker. */
  readonly inputWrapped?: boolean;
  /** Whether successful structured output is placed under the `result` marker. */
  readonly outputWrapped?: boolean;
  /** Native declaration consumed exactly once by the invocation dispatcher. */
  readonly declaration: BoundDeclaration<
    InputSchema,
    Result,
    Locals,
    Seed,
    (context: InvocationContext<z.output<InputSchema>, Locals>) => MaybePromise<Result>
  >;
}

/** Common wire and declaration shape accepted from heterogeneous generic entries. */
export interface McpToolRegistration<Seed extends object = object> {
  /** Unique wire name accepted by `tools/call`. */
  readonly name: string;
  /** Human-readable tool description emitted by `tools/list`. */
  readonly description: string;
  /** Object-rooted JSON Schema emitted for tool arguments. */
  readonly inputSchema: Readonly<Record<string, unknown>>;
  /** Optional object-rooted JSON Schema emitted for structured output. */
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  /** Optional advisory MCP tool annotations. */
  readonly annotations?: Readonly<Record<string, unknown>>;
  /** Whether callers must put the authored input under the `input` object-root marker. */
  readonly inputWrapped?: boolean;
  /** Whether successful structured output is placed under the `result` marker. */
  readonly outputWrapped?: boolean;
  /** Typed closure that invokes the concrete declaration without exposing it to the heterogeneous registry. */
  invoke(rawInputs: unknown, base: InvocationBase<Seed>): Promise<InvocationOutcome<unknown>>;
  /** Recompiles one public tool declaration with the accepted MCP surface guard. */
  withSurfaceGuard?(guard: Guard<unknown, Seed, object> | undefined): McpToolRegistration<Seed>;
}

/** Runtime-erased registered entry retained behind the catalog boundary. */
export interface McpRegisteredTool<Seed extends object = object> {
  /** Unique wire name accepted by `tools/call`. */
  readonly name: string;
  /** Human-readable tool description emitted by `tools/list`. */
  readonly description: string;
  /** Frozen object-rooted JSON Schema for tool arguments. */
  readonly inputSchema: Readonly<Record<string, unknown>>;
  /** Frozen optional object-rooted JSON Schema for structured output. */
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  /** Frozen optional advisory annotations. */
  readonly annotations?: Readonly<Record<string, unknown>>;
  /** Whether the dispatcher unwraps the `input` marker before invocation. */
  readonly inputWrapped: boolean;
  /** Whether the dispatcher wraps successful structured output under `result`. */
  readonly outputWrapped: boolean;
  /** Typed invocation closure retaining the concrete declaration at its call site. */
  invoke(rawInputs: unknown, base: InvocationBase<Seed>): Promise<InvocationOutcome<unknown>>;
}

/** Immutable wire-only tool definition returned to protocol discovery. */
export type McpToolView = Omit<McpRegisteredTool, "invoke" | "inputWrapped" | "outputWrapped">;

/** Fixed startup catalog used by both MCP discovery and invocation lookup. */
export class McpRegistry<Seed extends object = object> {
  /** Immutable deterministic wire listing. */
  readonly tools: readonly McpToolView[];

  /** Registered entries indexed by their exact names. */
  readonly #byName: ReadonlyMap<string, McpRegisteredTool<Seed>>;

  /** Builds one validated immutable catalog snapshot from explicitly supplied tools. */
  constructor(
    /** Explicit startup entries; order is not relied on for wire output. */
    entries: readonly McpToolRegistration<Seed>[],
    /** Optional surface guard and registry-owned invocation decoration. */
    options: McpRegistryOptions<Seed> = {},
  ) {
    const byName = new Map<string, McpRegisteredTool<Seed>>();
    for (const original of entries) {
      if (options.guard !== undefined && original.withSurfaceGuard === undefined) {
        throw new TypeError(
          `MCP tool ${JSON.stringify(original.name)} cannot compose the configured surface guard`,
        );
      }
      const entry = original.withSurfaceGuard?.(options.guard) ?? original;
      if (entry.name.length === 0) throw new TypeError("MCP tool name must not be empty");
      if (byName.has(entry.name)) throw new TypeError(`Duplicate MCP tool name: ${entry.name}`);
      const registered: McpRegisteredTool<Seed> = Object.freeze({
        name: entry.name,
        description: entry.description,
        inputSchema: cloneWireValue(entry.inputSchema),
        ...(entry.outputSchema === undefined ? {} : { outputSchema: cloneWireValue(entry.outputSchema) }),
        ...(entry.annotations === undefined ? {} : { annotations: cloneWireValue(entry.annotations) }),
        inputWrapped: entry.inputWrapped ?? false,
        outputWrapped: entry.outputWrapped ?? false,
        invoke: (rawInputs: unknown, base: InvocationBase<Seed>) =>
          options.decorateInvoke === undefined
            ? entry.invoke(rawInputs, base)
            : options.decorateInvoke(entry.name, entry.invoke, rawInputs, base),
      });
      byName.set(entry.name, registered);
    }

    const sorted = [...byName.values()].sort((left, right) => compareCodePoints(left.name, right.name));
    this.#byName = new Map(sorted.map((entry) => [entry.name, entry]));
    this.tools = Object.freeze(
      sorted.map((entry) =>
        Object.freeze({
          name: entry.name,
          description: entry.description,
          inputSchema: entry.inputSchema,
          ...(entry.outputSchema === undefined ? {} : { outputSchema: entry.outputSchema }),
          ...(entry.annotations === undefined ? {} : { annotations: entry.annotations }),
        }),
      ),
    );
    Object.freeze(this);
  }

  /** Returns the exact registered tool, or `undefined` when the name is unknown. */
  lookup(
    /** Wire name supplied by `tools/call`. */
    name: string,
  ): McpRegisteredTool<Seed> | undefined {
    return this.#byName.get(name);
  }

  /** Returns a frozen snapshot suitable for `tools/list`. */
  list(): readonly McpToolView[] {
    return this.tools;
  }
}

/** Constructs a registry while preserving the generic entry call-site checks. */
export function createMcpRegistry<Seed extends object>(
  /** Explicit startup tool entries. */
  entries: readonly McpToolRegistration<Seed>[],
  /** MCP surface guard and optional runtime hook wrapper. */
  options: McpRegistryOptions<Seed> = {},
): McpRegistry<Seed> {
  return new McpRegistry<Seed>(entries, options);
}

/** Options applied once while constructing one immutable MCP registry. */
export interface McpRegistryOptions<Seed extends object> {
  /** MCP surface guard compiled before each authored tool operation guard. */
  readonly guard?: Guard<unknown, Seed, object>;
  /** Optional package-runtime wrapper applied to the concrete registry invocation. */
  readonly decorateInvoke?: (
    /** Exact tool name selected from the registry. */
    name: string,
    /** Already compiled concrete registry invocation. */
    invoke: McpToolRegistration<Seed>["invoke"],
    /** Raw native MCP inputs. */
    rawInputs: unknown,
    /** Exact request-owned invocation base. */
    base: InvocationBase<Seed>,
  ) => Promise<InvocationOutcome<unknown>>;
}

/** Converts one concrete bound tool into a heterogeneous registry-safe typed invocation closure. */
export function registerMcpTool<InputSchema extends z.ZodType, Result, Locals extends object, Seed extends object>(
  entry: McpToolEntry<InputSchema, Result, Locals, Seed>,
): McpToolRegistration<Seed> {
  const declaration: typeof entry.declaration = {
    ...entry.declaration,
    handler: (context) => {
      markMcpHandlerStarted(context.locals);
      return entry.declaration.handler(context);
    },
  };
  const register = (surfaceGuard: Guard<unknown, Seed, object> | undefined): McpToolRegistration<Seed> => {
    const surfacedDeclaration = {
      ...declaration,
      guardPlan: composeGuardPlanSurface(
        declaration.guardPlan,
        surfaceGuard as Guard<z.output<InputSchema>, Seed, object> | undefined,
      ),
    };
    return {
    name: entry.name,
    description: entry.description,
    inputSchema: entry.inputSchema,
    ...(entry.outputSchema === undefined ? {} : { outputSchema: entry.outputSchema }),
    ...(entry.annotations === undefined ? {} : { annotations: entry.annotations }),
    ...(entry.inputWrapped === undefined ? {} : { inputWrapped: entry.inputWrapped }),
    ...(entry.outputWrapped === undefined ? {} : { outputWrapped: entry.outputWrapped }),
      invoke: (rawInputs, base) =>
        invokeBound({ declaration: surfacedDeclaration, rawInputs, base, forbidChdir: true }),
      withSurfaceGuard: register,
    };
  };
  return register(undefined);
}

/** Arms a request-local MCP progress reporter immediately before one tool handler executes. */
function markMcpHandlerStarted(locals: object): void {
  const reportProgress = (locals as Record<string, unknown>).reportProgress;
  if (typeof reportProgress !== "function") return;
  const arm = (reportProgress as unknown as Record<PropertyKey, unknown>)[MCP_HANDLER_STARTED];
  if (typeof arm === "function") arm();
}

/** Author-facing MCP declaration accepted by the public tool builder. */
export interface McpToolSpec<
  Seed extends object,
  InputSchema extends z.ZodType,
  Result,
  Added extends object = Record<never, never>,
> {
  /** Exact case-sensitive wire tool name. */
  readonly name: string;
  /** Human-readable discovery description. */
  readonly description: string;
  /** Input schema parsed before the handler. */
  readonly inputSchema: InputSchema;
  /** Optional output schema emitted in discovery and used for inference. */
  readonly outputSchema?: z.ZodType<Result>;
  /** Optional advisory MCP annotations. */
  readonly annotations?: Readonly<Record<string, unknown>>;
  /** Optional tool-owned supplement, replacement, or public marker. */
  readonly guard?: McpToolBuilderGuard<z.output<InputSchema>, Seed, Added>;
  /** Handler receiving parsed inputs and fresh per-call locals. */
  handler(context: InvocationContext<z.output<InputSchema>, MergeMcpLocals<Seed, Added>>): MaybePromise<Result>;
}

/** Builds one public MCP registration with direct Zod inference and no generated CLI argv. */
export function tool<Seed extends object = object>(): <
  const InputSchema extends z.ZodType,
  const Result = unknown,
  const Added extends object = Record<never, never>,
>(
  /** MCP tool declaration. */
  spec: McpToolSpec<Seed, InputSchema, Result, Added>,
) => McpToolRegistration<Seed> {
  function build<
    const InputSchema extends z.ZodType,
    const Result = unknown,
    const Added extends object = Record<never, never>,
  >(
    /** MCP tool declaration preserving schema inference. */
    spec: McpToolSpec<Seed, InputSchema, Result, Added>,
  ): McpToolRegistration<Seed> {
    /** Rebuilds only the concrete guard plan and native declaration at registry construction. */
    const registration = (surfaceGuard: Guard<unknown, Seed, object> | undefined): McpToolRegistration<Seed> => {
    const input = toJsonSchema(spec.inputSchema, "input");
    const output = spec.outputSchema === undefined ? undefined : toJsonSchema(spec.outputSchema, "output");
    const inputWrapped = input.type !== "object";
    const outputWrapped = output?.type !== "object" && output !== undefined;
    const inputSchema =
      inputWrapped
        ? {
            type: "object",
            properties: { input },
            required: ["input"],
            additionalProperties: false,
          }
        : input;
    const outputSchema =
      output === undefined
        ? undefined
        : outputWrapped
          ? {
              type: "object",
              properties: { result: output },
              required: ["result"],
              additionalProperties: false,
            }
          : output;
    const compile = compileGuardPlan<z.output<InputSchema>, Seed>();
    const operation = spec.guard as
      | Guard<z.output<InputSchema>, Seed, Added>
      | {
          readonly mode: "override";
          readonly run: Guard<z.output<InputSchema>, Seed, Added>;
        }
      | "public"
      | undefined;
    const runtimeSurface = surfaceGuard as Guard<z.output<InputSchema>, Seed, object> | undefined;
    const guardPlan =
      operation === undefined
        ? compile({ surface: runtimeSurface })
        : operation === "public" || typeof operation === "object"
          ? compile({ surface: runtimeSurface, operation: operation as never })
          : compile({ surface: runtimeSurface, operation: operation as never });
    const registration = registerMcpTool({
      name: spec.name,
      description: spec.description,
      inputSchema,
      ...(outputSchema === undefined ? {} : { outputSchema }),
      ...(spec.annotations === undefined ? {} : { annotations: spec.annotations }),
      inputWrapped,
      outputWrapped,
      declaration: {
        inputSchema: spec.inputSchema,
        guardPlan: guardPlan as CompiledGuard<
          z.output<InputSchema>,
          Seed,
          MergeMcpLocals<Seed, Added>
        >,
        handler: spec.handler as (
          context: InvocationContext<z.output<InputSchema>, MergeMcpLocals<Seed, Added>>,
        ) => MaybePromise<Result>,
      },
    });
    return registration;
    };
    return {
      ...registration(undefined),
      withSurfaceGuard: (surfaceGuard) => registration(surfaceGuard),
    };
  }
  return build;
}

/** Contextually typed operation guard accepted by the MCP tool builder. */
type McpToolBuilderGuard<Input, Seed extends object, Added extends object> =
  | Guard<Input, Seed, Added>
  | {
      /** Selects tool-owned replacement of the MCP surface guard. */
      readonly mode: "override";
      /** Replacement guard evaluated from the MCP seed. */
      readonly run: Guard<Input, Seed, Added>;
    }
  | "public";

/** Shallow merge preserving tool operation-guard additions. */
type MergeMcpLocals<Seed extends object, Added extends object> = {
  [Key in keyof Seed | keyof Added]: Key extends keyof Added
    ? Added[Key]
    : Key extends keyof Seed
      ? Seed[Key]
      : never;
};

/** Deep-clones and freezes JSON-shaped wire metadata without retaining caller-owned objects. */
function cloneWireValue<T>(value: T): Readonly<T> {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => cloneWireValue(item))) as unknown as Readonly<T>;
  }
  const copy = Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, cloneWireValue(item)]),
  );
  return Object.freeze(copy) as Readonly<T>;
}

/** Compares strings by UTF-16 code point order without locale-dependent collation. */
function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

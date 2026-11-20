/*
Builds immutable, package-internal child declaration snapshots before factory registration.
The helpers compose public names, expose selections, scoped sources, and collision facts.
*/

import type { InvocationBase, NameView } from "../core/invocation.ts";
import type { AppHooks, AppSpec, ChildSurface, Command, Locals } from "../core/types.ts";
import { hasHandler, hasSubcommands } from "../core/types.ts";
import type { HttpRouteRegistration } from "../http/routes.ts";
import type { JsonRpcMethodMetadata } from "../json-rpc/declaration.ts";
import { createMcpRegistry, type McpToolRegistration } from "../mcp/registry.ts";
import type { McpTaskProvider } from "../mcp/tasks.ts";

/** Marks a cloned child app root whose grouped-root options are valid in its mounted CLI position. */
export const CHILD_COMMAND_ROOT = Symbol("argsbarg.child-command-root");

/** Structural app view accepted before the public child descriptor is added. */
export interface ChildAppView {
  /** Frozen authoring snapshot retained by the child app. */
  readonly spec: AppSpec;
}

/** Package-internal structural mount descriptor consumed before public factory integration. */
export interface ChildAppMountLike {
  /** Already-built child app whose declarations will be copied. */
  readonly app: ChildAppView;
  /** Exact child surfaces to expose, or all configured surfaces when omitted. */
  readonly expose?: readonly ChildSurface[];
}

/** Prefix-only credential boundary for one mounted key path. */
export interface ChildSourceScope {
  /** Full immutable mount-key path. */
  readonly path: readonly string[];
  /** Prefix prepended to process-environment names. */
  readonly envPrefix: string;
  /** Prefix prepended to HTTP header names. */
  readonly headerPrefix: string;
  /** Reserved descendant environment prefixes hidden from this ancestor. */
  readonly descendantEnvPrefixes: readonly string[];
  /** Reserved descendant header prefixes hidden from this ancestor. */
  readonly descendantHeaderPrefixes: readonly string[];
}

/** One child-owned CLI tree, namespaced beneath its mount key. */
export interface ChildCliSnapshot {
  /** Reused child command tree with only its root key replaced. */
  readonly root: Command;
  /** Full public path to the child root. */
  readonly path: readonly string[];
  /** Child-owned invocation hooks copied at mount time. */
  readonly hooks?: AppHooks;
  /** Child-owned error reporter retained for its declarations. */
  readonly errorReporter?: AppSpec["errorReporter"];
  /** Child CLI default guard, not the parent CLI guard. */
  readonly guard?: NonNullable<AppSpec["cli"]>["guard"];
  /** Credential boundary shared by this child's CLI declarations. */
  readonly source: ChildSourceScope;
}

/** One child-owned REST declaration with composed public identity. */
export interface ChildHttpSnapshot {
  /** Child route registration with renamed path and operation id. */
  readonly route: HttpRouteRegistration;
  /** Full composed mount path. */
  readonly path: readonly string[];
  /** Child-owned invocation hooks copied at mount time. */
  readonly hooks?: AppHooks;
  /** Child-owned error reporter retained for this route. */
  readonly errorReporter?: AppSpec["errorReporter"];
  /** Child HTTP surface guard, not the parent HTTP guard. */
  readonly guard?: NonNullable<AppSpec["http"]>["guard"];
  /** Credential boundary for this route. */
  readonly source: ChildSourceScope;
}

/** One child-owned JSON-RPC declaration with a composed wire method. */
export interface ChildJsonRpcSnapshot {
  /** Child method declaration with only its public name changed. */
  readonly method: JsonRpcMethodMetadata;
  /** Full composed mount path. */
  readonly path: readonly string[];
  /** Child-owned invocation hooks copied at mount time. */
  readonly hooks?: AppHooks;
  /** Child-owned error reporter retained for this method. */
  readonly errorReporter?: AppSpec["errorReporter"];
  /** Child JSON-RPC surface guard, not the parent JSON-RPC guard. */
  readonly guard?: NonNullable<AppSpec["jsonRpc"]>["guard"];
  /** Credential boundary for this method. */
  readonly source: ChildSourceScope;
}

/** One child-owned MCP declaration with a composed wire tool name. */
export interface ChildMcpSnapshot {
  /** Child registration with only its public name changed. */
  readonly tool: McpToolRegistration<Locals>;
  /** Full composed mount path. */
  readonly path: readonly string[];
  /** Child-owned invocation hooks copied at mount time. */
  readonly hooks?: AppHooks;
  /** Child-owned error reporter retained for this tool. */
  readonly errorReporter?: AppSpec["errorReporter"];
  /** Child MCP surface guard, not the parent MCP guard. */
  readonly guard?: NonNullable<AppSpec["mcp"]>["guard"];
  /** Credential boundary for this tool. */
  readonly source: ChildSourceScope;
}

/** One child-owned MCP Tasks provider exposed through a stable mount namespace. */
export interface ChildMcpTaskSnapshot {
  /** Child provider callbacks retained at mount time. */
  readonly provider: McpTaskProvider<Locals>;
  /** Full composed mount path used to namespace public task IDs. */
  readonly path: readonly string[];
  /** Child-owned invocation hooks copied at mount time. */
  readonly hooks?: AppHooks;
  /** Child-owned error reporter retained for provider operations. */
  readonly errorReporter?: AppSpec["errorReporter"];
  /** Child MCP guard, not the parent MCP guard. */
  readonly guard?: NonNullable<AppSpec["mcp"]>["guard"];
  /** Child credential boundary. */
  readonly source: ChildSourceScope;
}

/** One public identity claim used to detect deterministic startup collisions. */
export interface ChildCollisionFact {
  /** Collision category that shares comparison semantics. */
  readonly kind: "cli" | "headerPrefix" | "httpOperation" | "httpRoute" | "mcp" | "rpc" | "envPrefix";
  /** Final public identity displayed in a collision error. */
  readonly identity: string;
  /** Declaration or sibling mount that owns this identity. */
  readonly ownerPath: string;
  /** Optional parent path restricting sibling-prefix comparisons. */
  readonly parentPath?: string;
  /** Optional HTTP method restricting route overlap comparisons. */
  readonly method?: string;
  /** Canonical path segments used for REST overlap checks. */
  readonly routeSegments?: readonly string[];
}

/** Immutable child-only declaration snapshot ready for later factory registration. */
export interface ChildSnapshot {
  /** Namespaced CLI trees retained in stable traversal order. */
  readonly cli: readonly ChildCliSnapshot[];
  /** Namespaced REST declarations retained in stable traversal order. */
  readonly http: readonly ChildHttpSnapshot[];
  /** Namespaced JSON-RPC declarations retained in stable traversal order. */
  readonly jsonRpc: readonly ChildJsonRpcSnapshot[];
  /** Namespaced MCP declarations retained in stable traversal order. */
  readonly mcp: readonly ChildMcpSnapshot[];
  /** Namespaced MCP Tasks providers retained in stable traversal order. */
  readonly mcpTasks: readonly ChildMcpTaskSnapshot[];
  /** Surfaces represented by this snapshot, including configured empty surfaces. */
  readonly surfaces: readonly ChildSurface[];
  /** All public identity claims, including hidden operations. */
  readonly collisions: readonly ChildCollisionFact[];
}

/** Mount-key profile shared by environment, header, and public namespace composition. */
const MOUNT_KEY = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** Stable surface ordering used by exposure results and service derivation. */
const SURFACES = Object.freeze(["cli", "http", "jsonRpc", "mcp"] as const);

/** Root fields removed from a copied child command tree. */
const APP_ROOT_FIELDS = new Set([
  "children",
  "completion",
  "errorReporter",
  "hooks",
  "http",
  "jsonRpc",
  "log",
  "mcp",
  "version",
]);

/** Builds one recursively composed snapshot from the parent-authoring child map. */
export function composeChildren(
  children: Readonly<Record<string, ChildAppMountLike>>,
): ChildSnapshot {
  validateSiblingPrefixes(children, []);
  const combined = mutableSnapshot();
  for (const [key, mountValue] of Object.entries(children)) {
    assertMountKey(key);
    const mount = assertMount(mountValue, key);
    const full = snapshotApp(mount.app.spec, [key]);
    const selected = selectSnapshot(full, resolveExpose(mount.expose, full.surfaces, key));
    appendSnapshot(combined, selected);
  }
  const snapshot = freezeSnapshot(combined);
  assertNoChildCollisions(snapshot.collisions);
  return snapshot;
}

/** Wraps an invocation base with the exact child credential view for its native source. */
export function scopeChildInvocation<Seed extends object>(
  base: InvocationBase<Seed>,
  scope: ChildSourceScope,
): InvocationBase<Seed> {
  if (base.source === "local") {
    return {
      source: "local",
      env: scopeChildNameView(base.env, scope, "env"),
      locals: base.locals,
      signal: base.signal,
      surface: base.surface,
    };
  }
  return {
    source: "http",
    headers: scopeChildNameView(base.headers, scope, "header"),
    locals: base.locals,
    signal: base.signal,
    surface: base.surface,
  };
}

/** Creates a frozen prefix-only view without enumerating or retaining source contents. */
export function scopeChildNameView(
  source: NameView,
  scope: ChildSourceScope,
  family: "env" | "header",
): NameView {
  const prefix = family === "env" ? scope.envPrefix : scope.headerPrefix;
  const descendants = family === "env" ? scope.descendantEnvPrefixes : scope.descendantHeaderPrefixes;
  const normalizedDescendants =
    family === "env" ? descendants : descendants.map((candidate) => candidate.toLowerCase());
  return Object.freeze({
    get(name: string) {
      const composed = `${prefix}${name}`;
      const compared = family === "env" ? composed : composed.toLowerCase();
      if (normalizedDescendants.some((candidate) => compared.startsWith(candidate))) return undefined;
      return source.get(composed);
    },
  });
}

/** Composes selected child CLI roots into the mount hierarchy consumed by the parent parser. */
export function composeChildCliCommands(snapshot: Pick<ChildSnapshot, "cli">): readonly Command[] {
  const roots = snapshot.cli.filter((entry) => entry.path.length === 1);
  return Object.freeze(roots.map((entry) => composeChildCliCommand(snapshot, entry)));
}

/** Selects the deepest mounted child root that owns one composed CLI path. */
export function childCliSnapshotForPath(
  snapshot: Pick<ChildSnapshot, "cli">,
  path: readonly string[],
): ChildCliSnapshot | undefined {
  let owner: ChildCliSnapshot | undefined;
  for (const entry of snapshot.cli) {
    if (entry.path.length > path.length) continue;
    if (!entry.path.every((segment, index) => path[index] === segment)) continue;
    if (owner === undefined || entry.path.length > owner.path.length) owner = entry;
  }
  return owner;
}

/** Returns immutable public identity facts for the selected child snapshot. */
export function collectChildCollisionFacts(snapshot: Pick<ChildSnapshot, "cli" | "http" | "jsonRpc" | "mcp">): readonly ChildCollisionFact[] {
  const facts: ChildCollisionFact[] = [];
  for (const entry of snapshot.cli) facts.push(...cliCollisionFacts(entry));
  for (const entry of snapshot.http) {
    const ownerPath = `${entry.path.join(".")}.http:${entry.route.id}`;
    facts.push({
      kind: "httpOperation",
      identity: entry.route.id,
      ownerPath,
    });
    facts.push({
      kind: "httpRoute",
      identity: `${entry.route.method} ${entry.route.path}`,
      ownerPath,
      method: entry.route.method,
      routeSegments: splitRoutePath(entry.route.path),
    });
  }
  for (const entry of snapshot.jsonRpc) {
    validateJsonRpcName(entry.method.name);
    facts.push({
      kind: "rpc",
      identity: entry.method.name,
      ownerPath: `${entry.path.join(".")}.rpc:${entry.method.name}`,
    });
  }
  for (const entry of snapshot.mcp) {
    createMcpRegistry([entry.tool]);
    facts.push({
      kind: "mcp",
      identity: entry.tool.name,
      ownerPath: `${entry.path.join(".")}.mcp:${entry.tool.name}`,
    });
  }
  return Object.freeze(facts.map(freezeCollisionFact));
}

/** Rejects duplicate, overlapping route, or overlapping sibling-prefix claims. */
export function assertNoChildCollisions(facts: readonly ChildCollisionFact[]): void {
  for (let index = 0; index < facts.length; index += 1) {
    const current = facts[index];
    for (let previousIndex = 0; previousIndex < index; previousIndex += 1) {
      const previous = facts[previousIndex];
      if (collisionPair(previous, current)) {
        const surface = collisionSurface(current.kind);
        throw new TypeError(
          `Child ${surface} collision ${JSON.stringify(current.identity)} between ${JSON.stringify(previous.ownerPath)} and ${JSON.stringify(current.ownerPath)}`,
        );
      }
    }
  }
}

/** App spec enriched with the not-yet-public runtime child field. */
type ChildAwareSpec = AppSpec & {
  /** Child mounts retained structurally until public type integration. */
  readonly children?: Readonly<Record<string, unknown>>;
};

/** Mutable assembly state used only while constructing a frozen snapshot. */
interface MutableChildSnapshot {
  /** CLI records accumulated during recursive traversal. */
  cli: ChildCliSnapshot[];
  /** REST records accumulated during recursive traversal. */
  http: ChildHttpSnapshot[];
  /** JSON-RPC records accumulated during recursive traversal. */
  jsonRpc: ChildJsonRpcSnapshot[];
  /** MCP records accumulated during recursive traversal. */
  mcp: ChildMcpSnapshot[];
  /** MCP Tasks provider records accumulated during recursive traversal. */
  mcpTasks: ChildMcpTaskSnapshot[];
  /** Configured native surfaces even when they contain no declarations. */
  surfaces: ChildSurface[];
}

/** Validates and snapshots one app before an exposure selection is applied. */
function snapshotApp(
  spec: AppSpec,
  path: readonly string[],
  ancestorCliEnabled = true,
): ChildSnapshot {
  const aware = spec as ChildAwareSpec;
  const children = aware.children ?? {};
  validateSiblingPrefixes(children, path);
  const combined = mutableSnapshot();
  combined.surfaces.push("cli");
  if (spec.http !== undefined) combined.surfaces.push("http");
  if (spec.jsonRpc !== undefined) combined.surfaces.push("jsonRpc");
  if (spec.mcp !== undefined) combined.surfaces.push("mcp");
  const scope = sourceScope(spec, path);
  const hooks = spec.hooks === undefined ? undefined : Object.freeze({ ...spec.hooks });
  const cliEnabled = ancestorCliEnabled && isCliConfigured(spec);
  if (cliEnabled) {
    combined.cli.push(
      Object.freeze({
        root: cloneCommandRoot(spec, path.at(-1) as string),
        path: Object.freeze([...path]),
        ...(hooks === undefined ? {} : { hooks }),
        ...(spec.errorReporter === undefined ? {} : { errorReporter: spec.errorReporter }),
        ...(spec.cli?.guard === undefined ? {} : { guard: spec.cli.guard }),
        source: scope,
      }),
    );
  }
  for (const route of spec.http?.routes ?? []) {
    combined.http.push(
      Object.freeze({
        route: cloneHttpRoute(route, path),
        path: Object.freeze([...path]),
        ...(hooks === undefined ? {} : { hooks }),
        ...(spec.errorReporter === undefined ? {} : { errorReporter: spec.errorReporter }),
        ...(spec.http?.guard === undefined ? {} : { guard: spec.http.guard }),
        source: scope,
      }),
    );
  }
  for (const method of spec.jsonRpc?.methods ?? []) {
    combined.jsonRpc.push(
      Object.freeze({
        method: cloneJsonRpcMethod(method, path),
        path: Object.freeze([...path]),
        ...(hooks === undefined ? {} : { hooks }),
        ...(spec.errorReporter === undefined ? {} : { errorReporter: spec.errorReporter }),
        ...(spec.jsonRpc?.guard === undefined ? {} : { guard: spec.jsonRpc.guard }),
        source: scope,
      }),
    );
  }
  for (const tool of spec.mcp?.tools ?? []) {
    combined.mcp.push(
      Object.freeze({
        tool: cloneMcpTool(tool, path, spec.mcp?.guard),
        path: Object.freeze([...path]),
        ...(hooks === undefined ? {} : { hooks }),
        ...(spec.errorReporter === undefined ? {} : { errorReporter: spec.errorReporter }),
        ...(spec.mcp?.guard === undefined ? {} : { guard: spec.mcp.guard }),
        source: scope,
      }),
    );
  }
  if (spec.mcp?.tasks !== undefined) {
    combined.mcpTasks.push(
      Object.freeze({
        provider: spec.mcp.tasks,
        path: Object.freeze([...path]),
        ...(hooks === undefined ? {} : { hooks }),
        ...(spec.errorReporter === undefined ? {} : { errorReporter: spec.errorReporter }),
        ...(spec.mcp.guard === undefined ? {} : { guard: spec.mcp.guard }),
        source: scope,
      }),
    );
  }
  for (const [key, mountValue] of Object.entries(children)) {
    assertMountKey(key);
    const mount = assertMount(mountValue, key);
    const child = snapshotApp(mount.app.spec, [...path, key], cliEnabled);
    appendSnapshot(combined, selectSnapshot(child, resolveExpose(mount.expose, child.surfaces, key)));
  }
  return freezeSnapshot(combined);
}

/** Creates a mutable, collision-free-until-validated child snapshot accumulator. */
function mutableSnapshot(): MutableChildSnapshot {
  return { cli: [], http: [], jsonRpc: [], mcp: [], mcpTasks: [], surfaces: [] };
}

/** Freezes every output array and derives configured surfaces and collision facts. */
function freezeSnapshot(
  mutable: MutableChildSnapshot,
): ChildSnapshot {
  const partial = {
    cli: Object.freeze([...mutable.cli]),
    http: Object.freeze([...mutable.http]),
    jsonRpc: Object.freeze([...mutable.jsonRpc]),
    mcp: Object.freeze([...mutable.mcp]),
    mcpTasks: Object.freeze([...mutable.mcpTasks]),
  };
  const surfaces = SURFACES.filter((surface) => mutable.surfaces.includes(surface));
  const snapshot: ChildSnapshot = Object.freeze({
    ...partial,
    surfaces: Object.freeze([...surfaces]),
    collisions: collectChildCollisionFacts(partial),
  });
  return snapshot;
}

/** Adds a selected recursive child snapshot to a parent accumulator. */
function appendSnapshot(target: MutableChildSnapshot, source: ChildSnapshot): void {
  target.cli.push(...source.cli);
  target.http.push(...source.http);
  target.jsonRpc.push(...source.jsonRpc);
  target.mcp.push(...source.mcp);
  target.mcpTasks.push(...source.mcpTasks);
  for (const surface of source.surfaces) {
    if (!target.surfaces.includes(surface)) target.surfaces.push(surface);
  }
}

/** Applies one mount's fixed exposure intersection without mutating the full snapshot. */
function selectSnapshot(snapshot: ChildSnapshot, exposed: ReadonlySet<ChildSurface>): ChildSnapshot {
  return freezeSnapshot({
    cli: exposed.has("cli") ? [...snapshot.cli] : [],
    http: exposed.has("http") ? [...snapshot.http] : [],
    jsonRpc: exposed.has("jsonRpc") ? [...snapshot.jsonRpc] : [],
    mcp: exposed.has("mcp") ? [...snapshot.mcp] : [],
    mcpTasks: exposed.has("mcp") ? [...snapshot.mcpTasks] : [],
    surfaces: SURFACES.filter((surface) => exposed.has(surface) && snapshot.surfaces.includes(surface)),
  });
}

/** Validates one expose selection against the child's independently composed surfaces. */
function resolveExpose(
  expose: readonly ChildSurface[] | undefined,
  available: readonly ChildSurface[],
  key: string,
): ReadonlySet<ChildSurface> {
  if (expose === undefined) return new Set(available);
  if (!Array.isArray(expose) || expose.length === 0) {
    throw new TypeError(`Child ${JSON.stringify(key)} expose must be a non-empty surface list`);
  }
  const selected = new Set<ChildSurface>();
  for (const surface of expose) {
    if (!SURFACES.includes(surface)) {
      throw new TypeError(`Child ${JSON.stringify(key)} exposes unsupported surface ${JSON.stringify(surface)}`);
    }
    if (selected.has(surface)) {
      throw new TypeError(`Child ${JSON.stringify(key)} exposes duplicate surface ${JSON.stringify(surface)}`);
    }
    if (!available.includes(surface)) {
      throw new TypeError(`Child ${JSON.stringify(key)} exposes unconfigured surface ${JSON.stringify(surface)}`);
    }
    selected.add(surface);
  }
  return selected;
}

/** Validates one runtime child descriptor and narrows its structural shape. */
function assertMount(value: unknown, key: string): ChildAppMountLike {
  if (typeof value !== "object" || value === null || !("app" in value)) {
    throw new TypeError(`Child ${JSON.stringify(key)} must be an object with an app`);
  }
  const app = (value as { app?: unknown }).app;
  if (typeof app !== "object" || app === null || !("spec" in app) || typeof (app as { spec?: unknown }).spec !== "object") {
    throw new TypeError(`Child ${JSON.stringify(key)} app must be an argsbarg App`);
  }
  return value as ChildAppMountLike;
}

/** Validates exact, case-sensitive mount-key syntax. */
function assertMountKey(key: unknown): asserts key is string {
  if (typeof key !== "string" || !MOUNT_KEY.test(key)) {
    throw new TypeError(`Invalid child mount key ${JSON.stringify(key)}`);
  }
}

/** Rejects overlapping sibling source namespaces before any declaration is copied. */
function validateSiblingPrefixes(
  children: Readonly<Record<string, unknown>>,
  parentPath: readonly string[],
): void {
  const facts: ChildCollisionFact[] = [];
  for (const key of Object.keys(children)) {
    assertMountKey(key);
    facts.push({
      kind: "envPrefix",
      identity: `${envPrefix([key])}`,
      ownerPath: [...parentPath, key].join("."),
      parentPath: parentPath.join("."),
    });
    facts.push({
      kind: "headerPrefix",
      identity: `${headerPrefix([key])}`,
      ownerPath: [...parentPath, key].join("."),
      parentPath: parentPath.join("."),
    });
  }
  assertNoChildCollisions(facts);
}

/** Derives one source scope and reserves every valid descendant mount prefix. */
function sourceScope(spec: AppSpec, path: readonly string[]): ChildSourceScope {
  const descendants = descendantPaths(spec, path);
  return Object.freeze({
    path: Object.freeze([...path]),
    envPrefix: envPrefix(path),
    headerPrefix: headerPrefix(path),
    descendantEnvPrefixes: Object.freeze(descendants.map((candidate) => envPrefix(candidate))),
    descendantHeaderPrefixes: Object.freeze(descendants.map((candidate) => headerPrefix(candidate))),
  });
}

/** Collects every nested mount path without applying an exposure selection. */
function descendantPaths(spec: AppSpec, path: readonly string[]): readonly (readonly string[])[] {
  const children = (spec as ChildAwareSpec).children ?? {};
  const paths: (readonly string[])[] = [];
  for (const [key, mountValue] of Object.entries(children)) {
    assertMountKey(key);
    const mount = assertMount(mountValue, key);
    const childPath = [...path, key];
    paths.push(Object.freeze(childPath));
    paths.push(...descendantPaths(mount.app.spec, childPath));
  }
  return paths;
}

/** Converts mount segments into an uppercase environment prefix. */
function envPrefix(path: readonly string[]): string {
  return `${path.map((segment) => segment.toUpperCase().replaceAll("-", "_")).join("_")}_`;
}

/** Converts mount segments into a lowercase HTTP header prefix. */
function headerPrefix(path: readonly string[]): string {
  return `${path.join("-")}-`;
}

/** True when one child app root contributes a callable CLI mount to descendants. */
function isCliConfigured(spec: AppSpec): boolean {
  return spec.cli?.enabled !== false;
}

/** Copies one child command root while removing app-level configuration fields. */
function cloneCommandRoot(root: Command, key: string): Command {
  const source = { ...(cloneCommand(root) as unknown as Record<string, unknown>) };
  for (const field of APP_ROOT_FIELDS) delete source[field];
  source.key = key;
  const rootCli = source.cli;
  if (typeof rootCli === "object" && rootCli !== null) {
    const policy = { ...(rootCli as Record<string, unknown>) };
    delete policy.guard;
    if (Object.keys(policy).length === 0) delete source.cli;
    else source.cli = Object.freeze(policy);
  }
  Object.defineProperty(source, CHILD_COMMAND_ROOT, { value: true, enumerable: false });
  return Object.freeze(source) as unknown as Command;
}

/** Deeply copies author-owned CLI containers while retaining schemas and callbacks by identity. */
function cloneCommand(command: Command): Command {
  const common: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(command)) {
    if (APP_ROOT_FIELDS.has(key)) {
      common[key] = value;
    } else if (key === "commands" && Array.isArray(value)) {
      common[key] = Object.freeze(value.map((child) => cloneCommand(child as Command)));
    } else if ((key === "options" || key === "positionals") && Array.isArray(value)) {
      common[key] = Object.freeze(value.map((item) => clonePlain(item)));
    } else if (key === "cli" && typeof value === "object" && value !== null) {
      common[key] = clonePlain(value);
    } else if (key === "guard" && typeof value === "object" && value !== null) {
      common[key] = clonePlain(value);
    } else {
      common[key] = value;
    }
  }
  return Object.freeze(common) as unknown as Command;
}

/** Clones a mutable route registration and composes REST path and operation id. */
function cloneHttpRoute(route: HttpRouteRegistration, path: readonly string[]): HttpRouteRegistration {
  const record = cloneRecord(route);
  record.id = `${path.join("__")}__${route.id}`;
  record.path = composeHttpPath(path, route.path);
  if (route.tags !== undefined) record.tags = Object.freeze([...route.tags]);
  if (route.responses !== undefined) record.responses = Object.freeze(route.responses.map((item) => clonePlain(item)));
  if (route.response !== undefined) record.response = clonePlain(route.response);
  if (typeof route.guard === "object" && route.guard !== null) record.guard = clonePlain(route.guard);
  return Object.freeze(record) as unknown as HttpRouteRegistration;
}

/** Clones JSON-RPC metadata while preserving its runtime identity symbol and declaration callbacks. */
function cloneJsonRpcMethod(
  method: JsonRpcMethodMetadata,
  path: readonly string[],
): JsonRpcMethodMetadata {
  const record = cloneRecord(method);
  record.name = `${path.join(".")}.${method.name}`;
  if (method.paramNames !== undefined) record.paramNames = Object.freeze([...method.paramNames]);
  if (typeof method.guard === "object" && method.guard !== null) record.guard = clonePlain(method.guard);
  return Object.freeze(record) as unknown as JsonRpcMethodMetadata;
}

/** Clones MCP wire registration metadata while preserving its compiled invocation closure. */
function cloneMcpTool(
  tool: McpToolRegistration<Locals>,
  path: readonly string[],
  childSurfaceGuard: NonNullable<AppSpec["mcp"]>["guard"],
): McpToolRegistration<Locals> {
  const record = cloneRecord(tool);
  const name = `${path.join("__")}__${tool.name}`;
  record.name = name;
  record.inputSchema = clonePlain(tool.inputSchema);
  if (tool.outputSchema !== undefined) record.outputSchema = clonePlain(tool.outputSchema);
  if (tool.annotations !== undefined) record.annotations = clonePlain(tool.annotations);
  if (tool.withSurfaceGuard !== undefined) {
    record.withSurfaceGuard = (
      _parentGuard: Parameters<NonNullable<McpToolRegistration<Locals>["withSurfaceGuard"]>>[0],
    ) => {
      const guarded = tool.withSurfaceGuard?.(childSurfaceGuard);
      if (guarded === undefined) return record as unknown as McpToolRegistration<Locals>;
      return Object.freeze({
        ...guarded,
        name,
        description: record.description,
        inputSchema: record.inputSchema,
        ...(record.outputSchema === undefined ? {} : { outputSchema: record.outputSchema }),
        ...(record.annotations === undefined ? {} : { annotations: record.annotations }),
        inputWrapped: record.inputWrapped,
        outputWrapped: record.outputWrapped,
      });
    };
  } else {
    record.withSurfaceGuard = () =>
      Object.freeze({ ...record }) as unknown as McpToolRegistration<Locals>;
  }
  return Object.freeze(record) as unknown as McpToolRegistration<Locals>;
}

/** Recursively inserts direct nested child roots without mutating the immutable snapshots. */
function composeChildCliCommand(
  snapshot: Pick<ChildSnapshot, "cli">,
  entry: ChildCliSnapshot,
): Command {
  const descendants = snapshot.cli.filter(
    (candidate) =>
      candidate.path.length === entry.path.length + 1 &&
      entry.path.every((segment, index) => candidate.path[index] === segment),
  );
  if (descendants.length === 0) return entry.root;
  if (!hasSubcommands(entry.root)) {
    throw new TypeError(
      `Runnable child mount ${JSON.stringify(entry.path.join(" "))} cannot contain nested CLI mounts`,
    );
  }
  return Object.freeze({
    ...entry.root,
    commands: Object.freeze([
      ...entry.root.commands,
      ...descendants.map((descendant) => composeChildCliCommand(snapshot, descendant)),
    ]),
  }) as Command;
}

/** Clones enumerable own string and symbol metadata into an unfrozen record. */
function cloneRecord<T extends object>(value: T): Record<PropertyKey, unknown> {
  return Object.assign({}, value) as Record<PropertyKey, unknown>;
}

/** Recursively copies JSON-like metadata while leaving opaque class instances and callbacks intact. */
function clonePlain<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map((item) => clonePlain(item))) as T;
  if (typeof value !== "object" || value === null) return value;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  return Object.freeze(
    Object.fromEntries(
      Reflect.ownKeys(value).map((key) => [
        key,
        clonePlain((value as Record<PropertyKey, unknown>)[key]),
      ]),
    ),
  ) as T;
}

/** Prefixes an authored REST route with one slash-safe mount path. */
function composeHttpPath(path: readonly string[], routePath: string): string {
  return `/${path.join("/")}${routePath === "/" ? "" : routePath}`;
}

/** Produces every enabled CLI node identity, including hidden nodes. */
function cliCollisionFacts(entry: ChildCliSnapshot): ChildCollisionFact[] {
  const facts: ChildCollisionFact[] = [];
  const visit = (node: Command, path: readonly string[], enabled: boolean): void => {
    const callable = enabled && node.cli?.enabled !== false;
    const nodePath = [...path, node.key];
    if (callable) {
      facts.push(
        freezeCollisionFact({
          kind: "cli",
          identity: nodePath.join(" "),
          ownerPath: `${entry.path.join(".")}.cli:${nodePath.join(" ")}`,
        }),
      );
    }
    if (hasSubcommands(node) && callable) {
      for (const child of node.commands) visit(child, nodePath, callable);
    } else if (!hasHandler(node)) {
      void enabled;
    }
  };
  visit(entry.root, entry.path.slice(0, -1), true);
  return facts;
}

/** Recursively freezes one collision fact and any route-segment array it owns. */
function freezeCollisionFact(fact: ChildCollisionFact): ChildCollisionFact {
  return Object.freeze({
    ...fact,
    ...(fact.routeSegments === undefined
      ? {}
      : { routeSegments: Object.freeze([...fact.routeSegments]) }),
  });
}

/** Splits a leading-slash route into canonical literal and parameter claims. */
function splitRoutePath(path: string): readonly string[] {
  return Object.freeze(path.split("/").filter(Boolean));
}

/** Validates the accepted JSON-RPC method profile after child prefixing. */
function validateJsonRpcName(name: unknown): asserts name is string {
  const containsControl =
    typeof name === "string" &&
    [...name].some((character) => {
      const point = character.codePointAt(0);
      return point !== undefined && (point <= 31 || (point >= 127 && point <= 159));
    });
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name.trim() !== name ||
    containsControl ||
    name.startsWith("rpc.")
  ) {
    throw new TypeError(`Invalid JSON-RPC method name ${JSON.stringify(name)}`);
  }
}

/** True when two public claims conflict under the surface-specific identity rules. */
function collisionPair(left: ChildCollisionFact, right: ChildCollisionFact): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "httpRoute") {
    return (
      left.method === right.method &&
      routePathsOverlap(left.routeSegments ?? [], right.routeSegments ?? [])
    );
  }
  if (left.kind === "envPrefix" || left.kind === "headerPrefix") {
    if (left.parentPath !== right.parentPath) return false;
    return left.identity.startsWith(right.identity) || right.identity.startsWith(left.identity);
  }
  return left.identity === right.identity;
}

/** True when literal and parameter route segments can match the same request path. */
function routePathsOverlap(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((segment, index) => {
    const other = right[index];
    return segment.startsWith(":") || other.startsWith(":") || segment === other;
  });
}

/** Returns the user-facing surface label for a collision category. */
function collisionSurface(kind: ChildCollisionFact["kind"]): string {
  switch (kind) {
    case "cli":
      return "CLI";
    case "envPrefix":
      return "environment source-prefix";
    case "headerPrefix":
      return "header source-prefix";
    case "httpOperation":
    case "httpRoute":
      return "REST";
    case "mcp":
      return "MCP";
    case "rpc":
      return "JSON-RPC";
  }
}

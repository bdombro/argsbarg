/*
Focused tests for REST local mirrors and injected-fetch relays.
They prove native parity, source isolation, exact request construction, and terminal no-fallback failures.
*/

import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { AppError } from "../core/errors.ts";
import type { NameView } from "../core/invocation.ts";
import { createHttpLocalMirror, createHttpMirror, createHttpRelayMirror, type HttpCallInput } from "./mirror.ts";
import { createHttpCatalog, route } from "./routes.ts";

/** Creates an explicit name view whose values come only from one caller-owned object. */
function nameView(values: Readonly<Record<string, string>>): NameView {
  return {
    get(name) {
      return values[name];
    },
  };
}

/** Builds one typed catalog that exercises every accepted REST input source. */
function localCatalog(observations: {
  /** Collected source names for guard and handler parity checks. */
  readonly sources: string[];
  /** Collected locals objects for fresh-call identity checks. */
  readonly locals: object[];
}) {
  return createHttpCatalog<{ requestId: string }>(
    [
      route<{ requestId: string }>()({
        id: "write-report",
        method: "POST",
        path: "/projects/:id/reports",
        description: "Write a report.",
        pathParams: z.strictObject({ id: z.string() }),
        queryParams: z.strictObject({
          dryRun: z.boolean().optional(),
          filter: z.object({ ok: z.boolean() }).optional(),
        }),
        body: z.strictObject({ title: z.string() }),
        guard: (context) => {
          if (context.source !== "local") throw new Error("Expected local source");
          assert.equal("headers" in context, false);
          observations.sources.push(`${context.source}:${context.env.get("TOKEN") ?? ""}`);
          if (context.env.get("TOKEN") === "deny") {
            return {
              kind: "deny" as const,
              denial: { code: "NO_REPORTS", message: "Reports are unavailable", http: { status: 403 } },
            };
          }
          return { kind: "allow" as const, locals: { guarded: true } };
        },
        outputSchema: z.strictObject({
          id: z.string(),
          title: z.string(),
          dryRun: z.boolean().optional(),
          filter: z.object({ ok: z.boolean() }).optional(),
        }),
        handler: (context) => {
          observations.locals.push(context.locals);
          assert.equal(context.source, "local");
          assert.equal(context.signal.aborted, false);
          assert.equal(context.locals.guarded, true);
          console.log("captured stdout");
          console.error("captured stderr");
          if (context.inputs.title === "error") throw new AppError("Conflict", { code: "CONFLICT", httpStatus: 409 });
          return {
            id: context.inputs.id,
            title: context.inputs.title,
            dryRun: context.inputs.dryRun,
            filter: context.inputs.filter,
          };
        },
      }),
      route()({
        id: "stream",
        method: "GET",
        path: "/stream",
        description: "Stream bytes.",
        responses: [{ status: 206, description: "Partial stream." }],
        handler: () => new Response("firstsecond", { status: 206, headers: { "x-stream": "present" } }),
      }),
    ],
    {
      guard: (context) => {
        assert.equal(context.source, "local");
        return true;
      },
    },
  );
}

test("local mirror binds the exact full path and invokes the same declaration once", async () => {
  const observations = { sources: [] as string[], locals: [] as object[] };
  const mirror = createHttpLocalMirror<{ requestId: string }>(localCatalog(observations));
  const controller = new AbortController();
  const seed = { requestId: "seed" };
  const result = await mirror.invoke(
    {
      method: "post",
      fullPath: "/api/projects/alpha%20one/reports?dryRun=true&filter=%7B%22ok%22%3Atrue%7D",
      body: { title: "Quarterly" },
    },
    {
      mode: "local",
      signal: controller.signal,
      locals: seed,
      env: nameView({ TOKEN: "local-secret" }),
    },
  );

  assert.equal(result.kind, "native");
  if (result.kind !== "native") return;
  assert.equal(result.value.status, 201);
  assert.deepEqual(await result.value.json(), {
    id: "alpha one",
    title: "Quarterly",
    dryRun: true,
    filter: { ok: true },
  });
  assert.equal(result.stdout, "captured stdout\n");
  assert.equal(result.stderr, "captured stderr\n");
  assert.deepEqual(observations.sources, ["local:local-secret"]);
  assert.notEqual(observations.locals[0], seed);
});

test("local mirror preserves native response status, headers, and body stream", async () => {
  const mirror = createHttpLocalMirror(localCatalog({ sources: [], locals: [] }));
  const result = await mirror.invoke(
    { method: "GET", fullPath: "/api/stream" },
    {
      mode: "local",
      signal: new AbortController().signal,
      locals: {},
      env: nameView({}),
    },
  );
  assert.equal(result.kind, "native");
  if (result.kind !== "native") return;
  assert.equal(result.value.status, 206);
  assert.equal(result.value.headers.get("x-stream"), "present");
  assert.equal(await result.value.text(), "firstsecond");
});

test("local calls use fresh locals and encode invalid input and denial-style terminal outcomes as native REST responses", async () => {
  const observations = { sources: [] as string[], locals: [] as object[] };
  const mirror = createHttpLocalMirror<{ requestId: string }>(localCatalog(observations));
  for (const requestId of ["one", "two"]) {
    const result = await mirror.invoke(
      {
        method: "POST",
        fullPath: "/api/projects/id/reports",
        body: { title: requestId },
      },
      {
        mode: "local",
        signal: new AbortController().signal,
        locals: { requestId },
        env: nameView({ TOKEN: requestId }),
      },
    );
    assert.equal(result.kind, "native");
  }
  assert.notEqual(observations.locals[0], observations.locals[1]);

  const invalid = await mirror.invoke(
    { method: "POST", fullPath: "/api/projects/id/reports", body: {} },
    {
      mode: "local",
      signal: new AbortController().signal,
      locals: { requestId: "invalid" },
      env: nameView({}),
    },
  );
  assert.equal(invalid.kind, "native");
  if (invalid.kind === "native") {
    assert.equal(invalid.value.status, 400);
    assert.equal(((await invalid.value.json()) as { error: { code: string } }).error.code, "INVALID_INPUT");
  }

  const denied = await mirror.invoke(
    { method: "POST", fullPath: "/api/projects/id/reports", body: { title: "denied" } },
    {
      mode: "local",
      signal: new AbortController().signal,
      locals: { requestId: "denied" },
      env: nameView({ TOKEN: "deny" }),
    },
  );
  assert.equal(denied.kind, "native");
  if (denied.kind === "native") assert.equal(denied.value.status, 403);

  const failed = await mirror.invoke(
    { method: "POST", fullPath: "/api/projects/id/reports", body: { title: "error" } },
    {
      mode: "local",
      signal: new AbortController().signal,
      locals: { requestId: "error" },
      env: nameView({ TOKEN: "allow" }),
    },
  );
  assert.equal(failed.kind, "native");
  if (failed.kind === "native") assert.equal(failed.value.status, 409);
});

test("local mirror returns safe bind and abort failures without invoking a handler", async () => {
  let calls = 0;
  let guards = 0;
  const catalog = createHttpCatalog(
    [
      route()({
        id: "count",
        method: "POST",
        path: "/count",
        description: "Count.",
        outputSchema: z.literal(true),
        handler: () => {
          calls += 1;
          return true as const;
        },
      }),
    ],
    {
      guard: () => {
        guards += 1;
        return true;
      },
    },
  );
  const mirror = createHttpLocalMirror(catalog);

  const missing = await mirror.invoke(
    { method: "GET", fullPath: "/api/missing" },
    {
      mode: "local",
      signal: new AbortController().signal,
      locals: {},
      env: nameView({ TOKEN: "must-not-leak" }),
    },
  );
  assert.equal(missing.kind, "failure");
  if (missing.kind === "failure") {
    assert.equal(missing.category, "input");
    assert.equal(missing.code, "NOT_FOUND");
  }

  const controller = new AbortController();
  controller.abort();
  const aborted = await mirror.invoke(
    { method: "POST", fullPath: "/api/count" },
    { mode: "local", signal: controller.signal, locals: {}, env: nameView({}) },
  );
  assert.deepEqual(aborted, {
    kind: "failure",
    category: "transport",
    code: "CALL_ABORTED",
    message: "REST call was aborted",
    stdout: "",
    stderr: "",
  });
  assert.equal(calls, 0);
  assert.equal(guards, 0);
});

test("relay sends exactly one request with the exact URL, body, headers, redirect policy, and signal", async () => {
  const controller = new AbortController();
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const remote = new Response("remote", { status: 503, headers: { "x-remote": "present" } });
  const previous = process.env.ARGSBARG_MIRROR_TOKEN;
  process.env.ARGSBARG_MIRROR_TOKEN = "ambient-secret";
  try {
    const result = await createHttpRelayMirror().invoke(
      { method: "post", fullPath: "/api/jobs?now=true", body: { job: "report" } },
      {
        mode: "relay",
        url: new URL("https://relay.example"),
        headers: [
          ["X-Explicit", "one"],
          ["Authorization", "Bearer explicit"],
        ],
        signal: controller.signal,
        fetch: (async (url, init) => {
          requests.push({ url: String(url), init });
          return remote;
        }) as typeof globalThis.fetch,
      },
    );
    assert.equal(result.kind, "native");
    if (result.kind === "native") assert.equal(result.value, remote);
  } finally {
    if (previous === undefined) delete process.env.ARGSBARG_MIRROR_TOKEN;
    else process.env.ARGSBARG_MIRROR_TOKEN = previous;
  }

  assert.equal(requests.length, 1);
  const sent = requests[0];
  assert.equal(sent?.url, "https://relay.example/api/jobs?now=true");
  assert.equal(sent?.init?.method, "POST");
  assert.equal(sent?.init?.body, '{"job":"report"}');
  assert.equal(sent?.init?.signal, controller.signal);
  assert.equal(sent?.init?.redirect, "manual");
  const headers = new Headers(sent?.init?.headers);
  assert.equal(headers.get("x-explicit"), "one");
  assert.equal(headers.get("authorization"), "Bearer explicit");
  assert.equal(headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(headers.has("argsbarg-mirror-token"), false);
});

test("paired REST registration exposes exactly local and relay shared-shape entries", async () => {
  const catalog = localCatalog({ sources: [], locals: [] });
  const entries = createHttpMirror<{ requestId: string }>(catalog);
  assert.deepEqual(Object.keys(entries), ["local", "relay"]);
  assert.equal(typeof entries.local.invoke, "function");
  assert.equal(typeof entries.relay.invoke, "function");

  const local = await entries.local.invoke(
    { method: "POST", fullPath: "/api/projects/id/reports", body: { title: "paired" } },
    {
      mode: "local",
      signal: new AbortController().signal,
      locals: { requestId: "paired" },
      env: nameView({}),
    },
  );
  assert.equal(local.kind, "native");

  const redirect = new Response(null, { status: 302, headers: { location: "https://next.example/redirected" } });
  let redirectMode: RequestRedirect | undefined;
  const relay = await entries.relay.invoke(
    { method: "GET", fullPath: "/api/redirect" },
    {
      mode: "relay",
      url: new URL("https://relay.example"),
      headers: [],
      signal: new AbortController().signal,
      fetch: (async (_url, init) => {
        redirectMode = init?.redirect;
        return redirect;
      }) as typeof globalThis.fetch,
    },
  );
  assert.equal(redirectMode, "manual");
  assert.equal(relay.kind, "native");
  if (relay.kind === "native") {
    assert.equal(relay.value, redirect);
    assert.equal(relay.value.status, 302);
    assert.equal(relay.value.headers.get("location"), "https://next.example/redirected");
  }
});

test("relay keeps all HTTP response statuses native and does not fabricate a body or fallback", async () => {
  const mirror = createHttpRelayMirror();
  for (const status of [200, 301, 302, 307, 308, 404, 500]) {
    let calls = 0;
    const result = await mirror.invoke(
      { method: "GET", fullPath: "/api/result" },
      {
        mode: "relay",
        url: new URL("http://relay.example"),
        headers: [],
        signal: new AbortController().signal,
        fetch: (async () => {
          calls += 1;
          return new Response(null, { status });
        }) as typeof globalThis.fetch,
      },
    );
    assert.equal(result.kind, "native");
    if (result.kind === "native") assert.equal(result.value.status, status);
    assert.equal(calls, 1);
  }
});

test("relay rejects malformed origin/input and maps aborts and network throws to safe failures", async () => {
  const mirror = createHttpRelayMirror();
  let fetchCalls = 0;
  const fetch = (async () => {
    fetchCalls += 1;
    throw new Error("credential detail from network");
  }) as typeof globalThis.fetch;
  const common = {
    mode: "relay" as const,
    url: new URL("https://relay.example"),
    headers: [] as const,
    signal: new AbortController().signal,
    fetch,
  };

  const malformed = await mirror.invoke({ method: 1, fullPath: "//other.example" } as unknown as HttpCallInput, common);
  assert.equal(malformed.kind, "failure");
  if (malformed.kind === "failure") assert.equal(malformed.category, "input");
  assert.equal(fetchCalls, 0);

  const badOrigin = await mirror.invoke(
    { method: "GET", fullPath: "/api/result" },
    { ...common, url: new URL("https://relay.example/base") },
  );
  assert.equal(badOrigin.kind, "failure");
  assert.equal(fetchCalls, 0);

  const network = await mirror.invoke({ method: "GET", fullPath: "/api/result" }, common);
  assert.deepEqual(network, {
    kind: "failure",
    category: "transport",
    code: "CALL_TRANSPORT_ERROR",
    message: "REST relay request failed",
    stdout: "",
    stderr: "",
  });
  assert.equal(fetchCalls, 1);

  const controller = new AbortController();
  controller.abort();
  const aborted = await mirror.invoke(
    { method: "GET", fullPath: "/api/result" },
    {
      ...common,
      signal: controller.signal,
      fetch: (async (_url, init) => {
        assert.equal(init?.signal, controller.signal);
        throw new DOMException("secret abort", "AbortError");
      }) as typeof globalThis.fetch,
    },
  );
  assert.equal(aborted.kind, "failure");
  if (aborted.kind === "failure") assert.equal(aborted.code, "CALL_ABORTED");
});

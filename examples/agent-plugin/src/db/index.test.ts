import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { AppDb } from "./index.ts";

describe("AppDb", () => {
  let appDb: AppDb;

  beforeEach(() => {
    appDb = AppDb.open();
  });

  afterEach(() => {
    appDb.close();
  });

  test("workspace CRUD round trip", () => {
    const workspaces = appDb.workspaces;
    assert.deepEqual(workspaces.list(), []);
    const created = workspaces.create("alpha");
    assert.deepEqual(workspaces.get(created.id), created);
    assert.deepEqual(workspaces.list(), [created]);
    assert.deepEqual(workspaces.patch(created.id, "beta"), { ...created, name: "beta" });
    assert.deepEqual(workspaces.replace(created.id, "gamma"), { id: created.id, name: "gamma" });
    assert.equal(workspaces.delete(created.id), true);
    assert.equal(workspaces.get(created.id), undefined);
  });

  test("ping succeeds on open database", () => {
    assert.doesNotThrow(() => appDb.ping());
  });
});

describe("AppDb.openWithRetry", () => {
  test("opens an in-memory database", () => {
    const appDb = AppDb.openWithRetry(1);
    try {
      appDb.workspaces.create("retry-ok");
      assert.equal(appDb.workspaces.list().length, 1);
    } finally {
      appDb.close();
    }
  });
});

describe("AppDb.attach", () => {
  test("sets ctx.locals.db", () => {
    const locals = {} as import("argsbarg").Locals;
    AppDb.attach({ locals });
    locals.db.workspaces.create("attached");
    assert.equal(locals.db.workspaces.list().length, 1);
  });
});

describe("AppDb.checkReadiness", () => {
  test("returns true when the app-owned database responds", () => {
    AppDb.resetForTests();
    assert.equal(AppDb.checkReadiness(), true);
  });
});

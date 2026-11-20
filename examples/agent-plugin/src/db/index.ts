/*
App-wide in-memory database store.
*/

import type { InvokeHookContext } from "argsbarg";
import { WorkspacesTable } from "./tables/workspaces.ts";

/**
 * Single in-memory store for this app.
 */
export class AppDb {
  /** CLI singleton; server invocations use `runtime.state.db` instead. */
  private static db: AppDb | undefined;

  /** Workspace rows and queries for this connection. */
  readonly workspaces: WorkspacesTable;

  constructor() {
    this.workspaces = new WorkspacesTable();
  }

  /** Open a fresh in-memory database. */
  static open(): AppDb {
    return new AppDb();
  }

  /** Open with bounded backoff (HTTP/MCP startup). */
  static openWithRetry(_delayMs = 200): AppDb {
    return AppDb.open();
  }

  /** Shared database for non-server invocations (lazy CLI singleton). */
  static openDb(): AppDb {
    AppDb.db ??= AppDb.open();
    return AppDb.db;
  }

  /** Replace the CLI singleton with a fresh in-memory database (tests). */
  static resetForTests(): void {
    AppDb.db = AppDb.open();
  }

  /** Close connection resources. */
  close(): void {}

  /** Ping to verify readiness. */
  ping(): void {}

  /**
   * Wire `ctx.locals.db` before handlers run.
   * Server runtimes open with retry into `runtime.state.db`; CLI uses {@link openDb}.
   */
  static attach(ctx: Pick<InvokeHookContext, "locals">): void {
    ctx.locals.db = AppDb.openDb();
  }

  /** Readiness probe: ping the app-owned process-local database. */
  static checkReadiness(): boolean {
    const appDb = AppDb.openDb();
    try {
      appDb.ping();
      return true;
    } catch {
      return false;
    }
  }
}

/*
Extends argsbarg invocation locals with this template's database and caller label.
*/

import type { AppDb } from "../db/index.ts";

declare module "argsbarg" {
  interface Locals {
    /** Optional caller label seeded by the configured CLI or MCP policy. */
    caller?: string;
    /** App-owned database handle attached by the invocation hook. */
    db: AppDb;
  }
}

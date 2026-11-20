import type { AppDb } from "../db/index.ts";

declare module "argsbarg" {
  interface Locals {
    caller?: "http" | "local";
    db: AppDb;
  }
}

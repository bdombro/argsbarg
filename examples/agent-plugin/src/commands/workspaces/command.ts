/*
Workspace CLI declarations with flat path values and typed Zod inputs.
*/

import { AppError, type AppSpec, type CommandGroup, command } from "argsbarg";
import { z } from "zod";

/** Body for workspace create/replace/patch. */
export const WorkspaceNameInput = z.strictObject({
  name: z.string().describe("Workspace display name."),
});

/** Parsed workspace name body. */
export type WorkspaceNameInput = z.infer<typeof WorkspaceNameInput>;

/** `:id` path parameter for single-workspace commands. */
export const WorkspaceIdParams = z.strictObject({
  id: z.string().describe("Workspace id (from `workspaces post` or `workspaces get`)."),
});

function notFound(id: string): never {
  throw new AppError(`Workspace not found: ${id}`, { code: "WORKSPACE_NOT_FOUND", httpStatus: 404 });
}

export const workspacesCommand = {
  key: "workspaces",
  description: "Workspace collection and CRUD.",
  commands: [
    {
      key: "get",
      description: "List workspaces.",
      handler: (ctx) => ({ workspaces: ctx.locals.db.workspaces.list() }),
    },
    command({
      key: "post",
      description: "Create a workspace.",
      inputSchema: WorkspaceNameInput,
      handler: (ctx) => {
        const { name } = ctx.inputs;
        return ctx.locals.db.workspaces.create(name);
      },
    }),
    {
      key: ":id",
      description: "One workspace by id.",
      commands: [
        command({
          key: "get",
          pathParams: WorkspaceIdParams,
          description: "Get one workspace.",
          handler: (ctx) => {
            const id = ctx.inputs.id;
            const ws = ctx.locals.db.workspaces.get(id);
            if (!ws) {
              notFound(id);
            }
            return ws;
          },
        }),
        command({
          key: "put",
          pathParams: WorkspaceIdParams,
          description: "Replace a workspace.",
          inputSchema: WorkspaceNameInput,
          handler: (ctx) => {
            const id = ctx.inputs.id;
            const { name } = ctx.inputs;
            const ws = ctx.locals.db.workspaces.replace(id, name);
            if (!ws) {
              notFound(id);
            }
            return ws;
          },
        }),
        command({
          key: "patch",
          pathParams: WorkspaceIdParams,
          description: "Patch a workspace name.",
          inputSchema: WorkspaceNameInput,
          handler: (ctx) => {
            const id = ctx.inputs.id;
            const { name } = ctx.inputs;
            const ws = ctx.locals.db.workspaces.patch(id, name);
            if (!ws) {
              notFound(id);
            }
            return ws;
          },
        }),
        command({
          key: "delete",
          pathParams: WorkspaceIdParams,
          description: "Delete a workspace.",
          handler: (ctx) => {
            const id = ctx.inputs.id;
            if (!ctx.locals.db.workspaces.delete(id)) {
              notFound(id);
            }
            return { deleted: id };
          },
        }),
      ],
    },
  ],
} satisfies CommandGroup;

/** Test program with workspaces registered. */
export function workspacesTestSpec(base: AppSpec): AppSpec {
  return {
    ...base,
    commands: [workspacesCommand],
  };
}

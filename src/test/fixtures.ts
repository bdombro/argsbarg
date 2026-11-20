import { spawnSync } from "node:child_process";
import type { AppSpec } from "../core/types.ts";
import { FallbackMode, OptionKind } from "../core/types.ts";

export function testProgram(prog: Record<string, unknown> & { key: string; description: string }): AppSpec {
  return { version: "0.0.0", ...prog } as AppSpec;
}

/** Output of a finished child process. */
export interface RunResult {
  /** Captured stdout. */
  stdout: string;
  /** Captured stderr. */
  stderr: string;
  /** Exit code (1 when the process could not start or was killed). */
  exitCode: number;
}

/** Runs `node <args>` from the repo root (10s timeout) and captures output. */
export function runNode(
  /** Script path and arguments. */
  args: string[],
  /** Extra environment and stdin text. */
  opts?: { env?: Record<string, string>; input?: string },
): RunResult {
  const proc = spawnSync(process.execPath, args, {
    encoding: "utf8",
    env: opts?.env ? { ...process.env, ...opts.env } : process.env,
    input: opts?.input,
    timeout: 10_000,
  });
  return { stdout: proc.stdout ?? "", stderr: proc.stderr ?? "", exitCode: proc.status ?? 1 };
}

/** Sends NDJSON MCP requests to a subprocess and collects responses by id. */
export async function mcpRequest(
  requests: object[],
  opts?: { script?: string; env?: Record<string, string> },
): Promise<Map<string | number, object>> {
  const script = opts?.script ?? "examples/nested.ts";
  const input = requests.map((request) => `${JSON.stringify(request)}\n`).join("");
  const { stdout } = runNode([script, "mcp"], { env: opts?.env, input });

  const byId = new Map<string | number, object>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const msg = JSON.parse(trimmed) as { id?: string | number };
    if (msg.id !== undefined) {
      byId.set(msg.id, msg);
    }
  }
  return byId;
}

export function varargsReadFixture(): AppSpec {
  return testProgram({
    key: "app",
    description: "",
    commands: [
      {
        key: "read",
        description: "Read files.",
        options: [
          {
            name: "json",
            description: "",
            kind: OptionKind.Presence,
          },
        ],
        positionals: [
          {
            name: "files",
            description: "",
            kind: OptionKind.String,
            argMin: 0,
            argMax: 0,
          },
        ],
        handler: () => {},
      },
    ],
  });
}

export function nestedDocsFallbackFixture(): AppSpec {
  return testProgram({
    key: "app",
    description: "",
    commands: [
      {
        key: "docs",
        description: "Documentation commands.",
        fallbackCommand: "guide",
        fallbackMode: FallbackMode.MissingOnly,
        commands: [
          {
            key: "guide",
            description: "User guide.",
            handler: () => {},
          },
          {
            key: "api",
            description: "API reference.",
            handler: () => {},
          },
        ],
      },
    ],
  });
}

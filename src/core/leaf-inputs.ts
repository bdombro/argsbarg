/*
Leaf input reads: Json options (flag, preloaded stdin, or toolArgs), optional Zod inputSchema validation.
With an inputSchema, the schema's parsed output becomes ctx.inputs.
*/

import { parseCommaList, parseDate, parseDateTime, parseDurationMs } from "./formats.ts";
import { collectPathOptionDefs } from "./parse.ts";
import type { AppSpec, Command, Invocation, RunnableCommand } from "./types.ts";
import { hasHandler, hasSubcommands, isDocumentCommand, OptionKind, ValueFormat } from "./types.ts";
import { isInteractiveTty, strictParseDouble } from "./utils.ts";

/** Thrown when leaf input resolution or validation fails. */
export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}

/** Internal key for piped stdin on `kind: "document"` leaves. */
export const DOCUMENT_LEAF_BODY_KEY = "__documentLeafBody";

function resolveLeaf(program: AppSpec, commandPath: string[]): RunnableCommand | undefined {
  let node: Command = program;
  for (const seg of commandPath) {
    if (!hasSubcommands(node)) return undefined;
    const child = node.commands.find((c) => c.key === seg);
    if (!child) return undefined;
    node = child;
  }
  return hasHandler(node) ? node : undefined;
}

/** Parses a JSON string from a `--name` flag value. */
export function parseJsonText(
  /** Raw text to parse as JSON. */
  raw: string,
  /** Field or argument label for error reporting. */
  label: string,
): unknown {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new InputError(`${label}: JSON value is empty`);
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new InputError(`${label}: invalid JSON`);
  }
}

/** Parses a JSON string from a command argument or document body. */
export function parseDocumentText(
  /** Raw text containing a JSON document. */
  raw: string,
  /** Field or argument label for error reporting. */
  label: string,
): unknown {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new InputError(`${label}: value is empty`);
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new InputError(`${label}: invalid JSON`);
  }
}

/** Reads all of piped stdin as UTF-8 text. */
async function readStdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Reads piped stdin as a JSON value for a pipable Json option. */
async function readPipedJsonStdin(): Promise<unknown> {
  const trimmed = (await readStdinText()).trim();
  if (trimmed.length === 0) {
    throw new InputError("stdin is empty; pass JSON via the option flag or pipe a JSON document to stdin");
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new InputError("stdin is not valid JSON");
  }
}

/** Error message when a document leaf gets no input. */
const DOCUMENT_BODY_HELP = "Missing document input: pass a JSON document as an argument or pipe to stdin";

/** Reads piped stdin for a document command with a handler. */
async function readPipedDocumentStdin(): Promise<unknown> {
  const trimmed = (await readStdinText()).trim();
  if (trimmed.length === 0) {
    throw new InputError(DOCUMENT_BODY_HELP);
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new InputError("stdin is not valid JSON");
  }
}

/** Coerces one parser-selected CLI leaf without running a Zod schema. */
export function coerceCliLeafInputs(options: {
  /** Validated/frozen app declaration used to resolve the selected leaf. */
  readonly program: AppSpec;
  /** Routed command path from the parser. */
  readonly commandPath: readonly string[];
  /** Parsed option text, including presence sentinels and post-parse defaults. */
  readonly opts: Readonly<Record<string, string>>;
  /** Positional CLI tokens after option parsing. */
  readonly args: readonly string[];
  /** JSON values already read from optional piped stdin. */
  readonly preloadedJson?: Readonly<Record<string, unknown>>;
  /** Raw path-router captures from the parser. */
  readonly pathParams?: Readonly<Record<string, string>>;
}): Record<string, unknown> {
  const { program, commandPath, opts, args, preloadedJson = {}, pathParams = {} } = options;
  const leaf = resolveLeaf(program, [...commandPath]);
  if (leaf === undefined) throw new InputError("Internal error: missing command leaf");
  if (isDocumentCommand(leaf)) {
    let body: unknown;
    if (args.length > 0) {
      body = parseDocumentText(args[0] ?? "", "Document argument");
    } else if (DOCUMENT_LEAF_BODY_KEY in preloadedJson) {
      body = preloadedJson[DOCUMENT_LEAF_BODY_KEY];
    } else {
      throw new InputError(DOCUMENT_BODY_HELP);
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new InputError("Document input must be a JSON object");
    }
    return { ...(body as Record<string, unknown>), ...pathParams };
  }

  const out: Record<string, unknown> = {};
  for (const option of collectPathOptionDefs(program, [...commandPath])) {
    const raw = opts[option.name];
    if (option.kind === OptionKind.Presence) {
      out[option.name] = raw !== undefined;
      continue;
    }
    if (raw === undefined) continue;
    if (option.kind === OptionKind.Number) {
      const numeric = strictParseDouble(raw);
      if (numeric === null) throw new InputError(`--${option.name}: invalid number`);
      out[option.name] = numeric;
    } else if (option.kind === OptionKind.Json) {
      out[option.name] = parseJsonText(raw, `--${option.name}`);
    } else if (option.format === ValueFormat.Duration) {
      out[option.name] = parseDurationMs(raw);
    } else if (option.format === ValueFormat.CommaList) {
      out[option.name] = parseCommaList(raw);
    } else if (option.format === ValueFormat.Date) {
      out[option.name] = parseDate(raw);
    } else if (option.format === ValueFormat.DateTime) {
      out[option.name] = parseDateTime(raw);
    } else {
      out[option.name] = raw;
    }
  }
  for (const option of collectPathOptionDefs(program, [...commandPath])) {
    if (option.kind === OptionKind.Json && option.name in preloadedJson && !(option.name in out)) {
      out[option.name] = preloadedJson[option.name];
    }
  }

  let index = 0;
  for (const slot of leaf.positionals ?? []) {
    const { argMax = 1 } = slot;
    if (argMax === 0) {
      out[slot.name] = args.slice(index);
      index = args.length;
    } else {
      const value = args[index];
      if (value !== undefined) out[slot.name] = value;
      index += 1;
    }
  }
  return { ...out, ...pathParams };
}

/**
 * Reads piped stdin for a pipable Json option when the flag is omitted (CLI only).
 * Call from {@link App.run} before constructing the handler context.
 */
export async function preloadPipableJson(
  program: AppSpec,
  commandPath: string[],
  opts: Record<string, string>,
  invocation: Invocation,
  args: string[] = [],
): Promise<Record<string, unknown>> {
  if (invocation !== "cli" || isInteractiveTty) {
    return {};
  }

  const leaf = resolveLeaf(program, commandPath);
  if (leaf && isDocumentCommand(leaf) && args.length === 0) {
    return { [DOCUMENT_LEAF_BODY_KEY]: await readPipedDocumentStdin() };
  }

  for (const opt of collectPathOptionDefs(program, commandPath)) {
    if (opt.kind === OptionKind.Json && opt.pipable && !(opt.name in opts)) {
      return { [opt.name]: await readPipedJsonStdin() };
    }
  }
  return {};
}

import { callPreview, inputPreview } from "../tool-names.js";
import type {
  CallListItem,
  CallRecord,
  CallStepSummary,
  SubCallRecord,
} from "./types.js";

const LIST_ARGUMENTS = [
  "source",
  "cmd",
  "patch",
  "query",
  "path",
  "destination",
  "workdir",
  "cell_id",
  "session_id",
] as const;
const PREVIEW_CHARS = 120;
const ERROR_CHARS = 200;
const STEP_HEAD = 5;
const STEP_TAIL = 3;
const PATCH_FILE =
  /^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/;
const YIELDED_CELL = /Script running with cell ID ([^\s"\\]+)/;
const STATUS_LINE =
  /^(?:Script (?:completed|failed|terminated|error:)|Script running with cell ID .*|Wall time .*|Output:)$/;

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The files a patch touches identify it better than its envelope line. */
function patchPreview(patch: string): string {
  const files: string[] = [];
  for (const line of patch.split("\n")) {
    const match = PATCH_FILE.exec(line.trim());
    const file = match?.[1] ?? match?.[2];
    if (file && !files.includes(file)) files.push(file);
  }
  return files.length ? files.join(", ") : inputPreview("patch", patch);
}

/** First input line of a nested call; outputs never enter listings. */
export function nestedPreview(name: string, input: unknown): string {
  if (typeof input === "string")
    return (
      name === "apply_patch"
        ? patchPreview(input)
        : inputPreview("input", input)
    ).slice(0, PREVIEW_CHARS);
  const args = objectValue(input);
  if (!args) return "";
  if (name === "apply_patch" && typeof args.patch === "string")
    return patchPreview(args.patch).slice(0, PREVIEW_CHARS);
  // Keep terminal input raw: an empty read and "q\n" are different actions.
  if (name === "write_stdin")
    return typeof args.chars === "string"
      ? args.chars.slice(0, PREVIEW_CHARS)
      : "";
  if (name === "read_mcp_resource" && typeof args.uri === "string")
    return args.uri.slice(0, PREVIEW_CHARS);
  const preview = callPreview(name, args);
  if (preview !== name) return preview.slice(0, PREVIEW_CHARS);
  for (const [key, value] of Object.entries(args))
    if (typeof value === "string" && value.trim())
      return `${key}: ${inputPreview(key, value)}`.slice(0, PREVIEW_CHARS);
  return "";
}

function stepHandle(subcall: SubCallRecord): string | undefined {
  const output = objectValue(subcall.output);
  if (
    subcall.name === "request_user_input_async" &&
    typeof output?.request_id === "string"
  )
    return output.request_id;
  if (subcall.name === "exec_command" && typeof output?.session_id === "string")
    return output.session_id;
  const input = objectValue(subcall.input);
  if (subcall.name === "write_stdin" && typeof input?.session_id === "string")
    return input.session_id;
  return undefined;
}

export function compactSteps(
  subcalls: readonly SubCallRecord[],
): CallStepSummary[] {
  const picked =
    subcalls.length <= STEP_HEAD + STEP_TAIL
      ? subcalls
      : [...subcalls.slice(0, STEP_HEAD), ...subcalls.slice(-STEP_TAIL)];
  return picked.map((subcall) => {
    const handle = stepHandle(subcall);
    const exitCode = objectValue(subcall.output)?.exit_code;
    return {
      name: subcall.name,
      status: subcall.status,
      durationMs: subcall.durationMs,
      preview: nestedPreview(subcall.name, subcall.input),
      ...(handle === undefined ? {} : { handle }),
      ...(typeof exitCode === "number" ? { exitCode } : {}),
    };
  });
}

export function yieldedCellId(call: CallRecord): string | undefined {
  if (call.tool !== "exec" || call.status !== "yielding") return undefined;
  let text: string;
  try {
    text = JSON.stringify(call.output ?? "");
  } catch {
    return undefined;
  }
  return YIELDED_CELL.exec(text)?.[1];
}

function meaningfulLine(text: string): string | undefined {
  const reported = /Script error:\s*\n\s*(\S[^\n]*)/.exec(text)?.[1];
  if (reported) return reported.trim().slice(0, ERROR_CHARS);
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && !STATUS_LINE.test(trimmed))
      return trimmed.slice(0, ERROR_CHARS);
  }
  return undefined;
}

/** The reason a call failed, taken from its error or its reported script error. */
export function errorPreview(call: CallRecord): string | undefined {
  if (call.status !== "error") return undefined;
  if (call.error) return meaningfulLine(call.error);
  const content = objectValue(call.output)?.content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((block) => objectValue(block))
    .flatMap((block) =>
      block?.type === "text" && typeof block.text === "string"
        ? [block.text]
        : [],
    )
    .join("\n");
  return meaningfulLine(text);
}

export function callListItem(call: CallRecord): CallListItem {
  const args: Record<string, string> =
    call.tool === "request_user_input_async"
      ? { preview: callPreview(call.tool, call.args) }
      : Object.fromEntries(
          LIST_ARGUMENTS.flatMap((key) => {
            const value = call.args[key];
            return typeof value === "string"
              ? [[key, inputPreview(key, value)]]
              : [];
          }),
        );
  const steps = compactSteps(call.subcalls);
  const cellId = yieldedCellId(call);
  const failure = errorPreview(call);
  return {
    id: call.id,
    sessionId: call.sessionId,
    tool: call.tool,
    status: call.status,
    startedAt: call.startedAt,
    endedAt: call.endedAt,
    durationMs: call.durationMs,
    args,
    subcallCount: call.subcalls.length + (call.omittedSubcalls ?? 0),
    truncated: !!call.truncatedFields || !!call.omittedSubcalls,
    ...(steps.length ? { steps } : {}),
    ...(cellId ? { cellId } : {}),
    ...(failure ? { errorPreview: failure } : {}),
  };
}

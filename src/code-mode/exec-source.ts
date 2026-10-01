import { validateOutputBudget } from "./output-budget.js";

export const DEFAULT_EXEC_YIELD_TIME_MS = 10_000;
export const DEFAULT_WAIT_YIELD_TIME_MS = 110_000;
export const MAX_EXEC_YIELD_TIME_MS = 30_000;
export const MAX_WAIT_YIELD_TIME_MS = 110_000;

// Unsupported helpers must fail explicitly; retain the native ALL_TOOLS catalog.
const CODE_MODE_SOURCE_PRELUDE = "delete globalThis.notify;";
const UNSCOPED_STORE_PRELUDE =
  'globalThis.store = globalThis.load = () => { throw new Error("store and load need an openai/session conversation ID from the host. This call has none, so values cannot be kept across exec calls."); };';

export interface ParsedExecSource {
  code: string;
  yieldTimeMs?: number;
  maxOutputTokens?: number;
}

/** Source sent to the native host. The prelude stays on the first line. */
export function hostSource(code: string, scoped: boolean): string {
  return `${CODE_MODE_SOURCE_PRELUDE}${scoped ? "" : UNSCOPED_STORE_PRELUDE}${code}`;
}

export function parseExecSource(input: string): ParsedExecSource {
  if (input.trim() === "") {
    throw new Error(
      'exec expects raw JavaScript source text; optionally prefix it with // @exec: {"yield_time_ms":10000}',
    );
  }
  const firstNewline = input.indexOf("\n");
  const firstLine = firstNewline < 0 ? input : input.slice(0, firstNewline);
  const trimmed = firstLine.trimStart();
  if (!trimmed.startsWith("// @exec:")) return { code: input };

  const code = firstNewline < 0 ? "" : input.slice(firstNewline + 1);
  if (code.trim() === "") {
    throw new Error(
      "exec pragma must be followed by JavaScript source on subsequent lines",
    );
  }
  const directive = trimmed.slice("// @exec:".length).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(directive) as unknown;
  } catch (error) {
    throw new Error(`exec pragma must be valid JSON: ${String(error)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("exec pragma must be a JSON object");
  }
  const object = parsed as Record<string, unknown>;
  for (const key of Object.keys(object)) {
    if (key !== "yield_time_ms" && key !== "max_output_tokens") {
      throw new Error(`exec pragma does not support field ${key}`);
    }
  }
  const yieldTimeMs = optionalNonNegativeSafeInteger(
    object.yield_time_ms,
    "yield_time_ms",
  );
  const maxOutputTokens = object.max_output_tokens;
  validateOutputBudget(maxOutputTokens, "max_output_tokens");
  return {
    code,
    ...(yieldTimeMs === undefined ? {} : { yieldTimeMs }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
  };
}

function optionalNonNegativeSafeInteger(
  value: unknown,
  name: string,
): number | undefined {
  if (value === undefined) return undefined;
  validateNonNegativeSafeInteger(value, name);
  return Number(value);
}

export function validateNonNegativeSafeInteger(
  value: unknown,
  name: string,
): void {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
}

export function validateYieldTime(
  value: unknown,
  name: string,
  maximum: number,
): void {
  validateNonNegativeSafeInteger(value, name);
  if (Number(value) > maximum) {
    throw new Error(`${name} must be at most ${maximum}`);
  }
}

import { isDeepStrictEqual } from "node:util";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { isRecord } from "./util.js";
import {
  boundModelOutput,
  MODEL_TEXT_BYTES,
} from "./code-mode/model-output.js";

/** Direct structured results have no duplicate JSON mirror; oversized results use the text guard.
 * No outputSchema is advertised at this boundary because a clipped result is explanatory text.
 */
export function directResult(
  name: string,
  value: unknown,
  failed = false,
  attachments: CallToolResult["content"] = [],
): CallToolResult {
  const state = failed ? { isError: true } : {};
  if (isRecord(value) && Array.isArray(value.content))
    return boundModelOutput({
      ...value,
      ...state,
      content: [...value.content, ...attachments],
    } as CallToolResult);
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (
    typeof value !== "string" &&
    isRecord(value) &&
    Buffer.byteLength(text) + 128 <= MODEL_TEXT_BYTES
  )
    return { content: attachments, structuredContent: value, ...state };
  // Keep command handles/exit status separately visible when the large JSON body is clipped.
  const status =
    isRecord(value) &&
    (name === "exec_command" ||
      name === "write_stdin" ||
      name === "apply_patch")
      ? Object.fromEntries(
          Object.entries(value).filter(([key]) => key !== "output"),
        )
      : {};
  const header =
    Buffer.byteLength(text) + 2 > MODEL_TEXT_BYTES
      ? [
          {
            type: "text" as const,
            text: `Tool ${name}\n${JSON.stringify(status)}\n`,
          },
        ]
      : [];
  return boundModelOutput({
    content: [...header, { type: "text", text }, ...attachments],
    ...state,
  });
}

/** Remove whitespace without changing number spelling, duplicate keys or escapes. */
function compactJson(text: string): string {
  return text.replace(/"(?:[^"\\]|\\.)*"|\s+/g, (token) =>
    token.startsWith('"') ? token : "",
  );
}
export function isJsonMirror(text: string, structured: unknown): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    return (
      JSON.stringify(parsed) === compactJson(text) &&
      isDeepStrictEqual(parsed, structured)
    );
  } catch {
    return false;
  }
}
export function normalizeResult(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.content)) return value;
  const { _meta: _private, ...result } = value;
  const hasStructured = Object.hasOwn(result, "structuredContent");
  result.content = value.content.filter((block: unknown) => {
    if (
      !hasStructured ||
      !isRecord(block) ||
      block.type !== "text" ||
      typeof block.text !== "string"
    )
      return true;
    if (Object.keys(block).some((key) => key !== "type" && key !== "text"))
      return true;
    return !isJsonMirror(block.text, result.structuredContent);
  });
  return result;
}
export function toolError(error: unknown): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: `执行失败：${error instanceof Error ? error.message : String(error)}`,
      },
    ],
    isError: true,
  };
}

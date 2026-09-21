import { isDeepStrictEqual } from "node:util";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { isRecord } from "./util.js";
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

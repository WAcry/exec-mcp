import type { CallToolResult } from "@modelcontextprotocol/client";
import { encodePayload } from "../limits.js";
import { normalizeResult } from "../results.js";
import type { CodeModeOutputItem } from "./types.js";

export function prepareNestedToolResult(value: unknown): Buffer {
  try {
    return encodePayload(normalizeResult(value));
  } catch (error) {
    throw new Error(
      `The tool ran, but its result cannot be delivered. Its side effects may have taken effect, so do not retry it automatically. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
export function outputItemsToCallToolResult(
  items: readonly CodeModeOutputItem[],
  isError: boolean,
): CallToolResult {
  const content: CallToolResult["content"] = items.map((item) => {
    if (item.type === "text") return { type: "text" as const, text: item.text };
    const url = item.type === "image" ? item.imageUrl : item.audioUrl;
    const match = /^data:([^;,]+);base64,([\s\S]*)$/.exec(url);
    if (!match)
      throw new Error(
        "Media output must be a base64 data URL: data:<MIME type>;base64,<data>.",
      );
    return {
      type: item.type,
      mimeType: match[1]!,
      data: match[2]!,
      ...(item.type === "image" && item.detail
        ? { _meta: { "openai/imageDetail": item.detail } }
        : {}),
    };
  });
  return {
    content,
    ...(isError ? { isError: true } : {}),
  };
}

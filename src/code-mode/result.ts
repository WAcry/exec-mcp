import type { CallToolResult } from "@modelcontextprotocol/client";
import { encodePayload } from "../limits.js";
import { normalizeResult } from "../results.js";
import type { CodeModeOutputItem } from "./types.js";

export async function prepareNestedToolResult(value: unknown): Promise<Buffer> {
  try {
    return encodePayload(normalizeResult(value));
  } catch (error) {
    throw new Error(
      `工具已经调用，但结果不可交付；操作可能已生效，请勿自动重试。${error instanceof Error ? error.message : String(error)}`,
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
    if (!match) throw new Error("媒体输出必须是 base64 data URL。");
    return {
      type: item.type,
      mimeType: match[1]!,
      data: match[2]!,
      ...(item.type === "image" && item.detail
        ? { _meta: { "openai/imageDetail": item.detail } }
        : {}),
    };
  });
  const result: CallToolResult = {
    content,
    ...(isError ? { isError: true } : {}),
  };
  encodePayload(result);
  return result;
}

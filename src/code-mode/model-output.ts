import type { CallToolResult } from "@modelcontextprotocol/client";
import { applyOutputBudget } from "./output-budget.js";

/** Conservative transport guard, not an assertion about a universal ChatGPT token limit.
 * UTF-8 bytes also bound character count without treating Chinese as one quarter token.
 * Nested tool results and native store/load never pass through this guard.
 */
export const MODEL_TEXT_BYTES = 36_000;
const NOTICE =
  "返回文本已达 36,000 字节上限，保留首尾；中间内容不会由 wait 补发。可在 exec 内筛选结果，或先 store 再分段 load。";

export function boundModelOutput(
  result: CallToolResult,
  maxBytes = MODEL_TEXT_BYTES,
): CallToolResult {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1024 ||
    maxBytes > MODEL_TEXT_BYTES
  )
    throw new Error("模型返回预算超出有效范围。");
  const texts = result.content.filter((item) => item.type === "text");
  // Include separation overhead: thousands of small text items also consume context.
  if (
    texts.reduce((sum, item) => sum + Buffer.byteLength(item.text) + 2, 0) <=
    maxBytes
  )
    return result;
  const first = result.content[0];
  const preserveStatus =
    first?.type === "text" &&
    first.text.startsWith("Script ") &&
    Buffer.byteLength(first.text) < Math.min(4096, maxBytes / 2);
  const status = preserveStatus ? first.text : "";
  const notice =
    maxBytes === MODEL_TEXT_BYTES
      ? NOTICE
      : "已为用户答复保留空间；其余文本按本次预算保留首尾。完整工具结果可在 exec 内筛选或提前 store。";
  const remaining = maxBytes - Buffer.byteLength(status + notice) - 32;
  // Only coalesce text for the fallback. Native media/resource blocks keep their order.
  const content = result.content.slice(preserveStatus ? 1 : 0);
  const text = content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n\n");
  const clipped = applyOutputBudget(
    [{ type: "text", text }],
    Math.floor(remaining / 4),
  );
  return {
    ...result,
    content: [
      { type: "text", text: status + notice + "\n" },
      ...clipped.items.filter((item) => item.type === "text"),
      ...content.filter((item) => item.type !== "text"),
    ],
  };
}

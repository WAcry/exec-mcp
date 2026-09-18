import type { CodeModeOutputItem } from "./types.js";

/** 与 Codex 的轻量估算一致，不引入模型专属 tokenizer。只约束显式文本，媒体不切片。 */
export function applyOutputBudget(
  items: readonly CodeModeOutputItem[],
  maxTokens: number | undefined,
): { items: CodeModeOutputItem[]; truncated: boolean } {
  if (maxTokens === undefined) return { items: [...items], truncated: false };
  validateOutputBudget(maxTokens);
  const total = items.reduce(
    (sum, item) =>
      sum + (item.type === "text" ? Buffer.byteLength(item.text) : 0),
    0,
  );
  const budget = Math.min(Number.MAX_SAFE_INTEGER, maxTokens * 4);
  if (total <= budget) return { items: [...items], truncated: false };
  const headEnd = Math.ceil(budget / 2);
  const tailStart = total - Math.floor(budget / 2);
  let position = 0;
  const result: CodeModeOutputItem[] = [];
  for (const item of items) {
    if (item.type !== "text") {
      result.push(item);
      continue;
    }
    const bytes = Buffer.from(item.text);
    const end = position + bytes.length;
    const head = utf8Slice(
      bytes,
      0,
      Math.max(0, Math.min(bytes.length, headEnd - position)),
    );
    const tail = utf8Slice(
      bytes,
      Math.max(0, Math.min(bytes.length, tailStart - position)),
      bytes.length,
    );
    if (head || tail)
      result.push({
        ...item,
        text:
          head && tail && end > headEnd && position < tailStart
            ? `${head}\n…\n${tail}`
            : head + tail,
      });
    position = end;
  }
  return { items: result, truncated: true };
}

function utf8Slice(bytes: Buffer, start: number, end: number): string {
  while (start < end && (bytes[start]! & 0xc0) === 0x80) start++;
  while (end > start && end < bytes.length && (bytes[end]! & 0xc0) === 0x80)
    end--;
  return bytes.toString("utf8", start, end);
}

export function validateOutputBudget(
  value: unknown,
): asserts value is number | undefined {
  if (
    value !== undefined &&
    (!Number.isSafeInteger(value) || Number(value) < 0)
  )
    throw new Error("输出 token 预算必须是非负安全整数。");
}

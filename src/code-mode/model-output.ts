import type { CallToolResult } from "@modelcontextprotocol/client";

/** Conservative transport guard, not an assertion about a universal ChatGPT token limit.
 * UTF-8 bytes also bound character count without treating Chinese as one quarter token.
 * Nested tool results and native store/load never pass through this guard.
 */
export const MODEL_TEXT_BYTES = 36_000;
const NOTICE = `Response text reached the ${MODEL_TEXT_BYTES.toLocaleString("en-US")}-byte limit; the beginning and end are kept. Later wait calls do not return the omitted middle. Filter results inside exec, or store them and load parts in later calls.`;

export function boundModelOutput(result: CallToolResult): CallToolResult {
  const texts = result.content.filter((item) => item.type === "text");
  // Include separation overhead: thousands of small text items also consume context.
  if (
    texts.reduce((sum, item) => sum + Buffer.byteLength(item.text) + 2, 0) <=
    MODEL_TEXT_BYTES
  )
    return result;
  const first = result.content[0];
  const preserveStatus =
    first?.type === "text" &&
    (first.text.startsWith("Script ") || first.text.startsWith("Tool ")) &&
    Buffer.byteLength(first.text) < 4096;
  const status = preserveStatus ? first.text : "";
  const remaining = MODEL_TEXT_BYTES - Buffer.byteLength(status + NOTICE) - 32;
  // Coalesce only adjacent plain text; metadata and media boundaries stay intact.
  const content: CallToolResult["content"] = [];
  for (const item of result.content.slice(preserveStatus ? 1 : 0)) {
    const previous = content.at(-1);
    if (
      item.type === "text" &&
      previous?.type === "text" &&
      Object.keys(item).length === 2 &&
      Object.keys(previous).length === 2
    ) {
      content[content.length - 1] = {
        type: "text",
        text: previous.text + "\n\n" + item.text,
      };
    } else content.push(item);
  }
  const total = content.reduce(
    (sum, item) =>
      sum + (item.type === "text" ? Buffer.byteLength(item.text) + 2 : 0),
    0,
  );
  const headEnd = Math.ceil(remaining / 2);
  const tailStart = total - Math.floor(remaining / 2);
  let position = 0;
  const clipped: CallToolResult["content"] = [];
  for (const item of content) {
    if (item.type !== "text") {
      clipped.push(item);
      continue;
    }
    const bytes = Buffer.from(item.text);
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
      clipped.push({
        ...item,
        text: head && tail ? head + "\n…\n" + tail : head + tail,
      });
    // Charge block separators too, including blocks dropped from the middle.
    position += bytes.length + 2;
  }
  return {
    ...result,
    content: [
      {
        ...(preserveStatus ? first : {}),
        type: "text",
        text: status + NOTICE + "\n",
      },
      ...clipped,
    ],
  };
}

function utf8Slice(bytes: Buffer, start: number, end: number): string {
  while (start < end && (bytes[start]! & 0xc0) === 0x80) start++;
  while (end > start && end < bytes.length && (bytes[end]! & 0xc0) === 0x80)
    end--;
  return bytes.toString("utf8", start, end);
}

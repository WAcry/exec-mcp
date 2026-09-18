import { open } from "node:fs/promises";
import { fileTypeFromBuffer } from "file-type";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { MAX_PAYLOAD_BYTES } from "../limits.js";

export async function viewImage(
  file: string,
  detail = "high",
): Promise<CallToolResult> {
  const handle = await open(file, "r");
  let data: Buffer;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("图片路径必须是普通文件。");
    const max = Math.floor((MAX_PAYLOAD_BYTES * 3) / 4) - 4096;
    if (stat.size > max)
      throw new Error("图片编码后将超过传输边界，请先缩小图片。");
    const chunks: Buffer[] = [];
    const stream = handle.createReadStream({
      autoClose: false,
      start: 0,
      end: max,
    });
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    data = Buffer.concat(chunks);
    if (data.length > max)
      throw new Error("图片在读取期间变大，超过传输边界。");
  } finally {
    await handle.close();
  }
  const type = await fileTypeFromBuffer(data);
  if (
    !type ||
    !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(type.mime)
  )
    throw new Error("仅支持 PNG、JPEG、WebP 或 GIF 图片。");
  return {
    content: [
      {
        type: "image",
        data: data.toString("base64"),
        mimeType: type.mime,
        _meta: { "codex/imageDetail": detail },
      },
    ],
  };
}

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
    if (!stat.isFile())
      throw new Error("The image path must point to a regular file.");
    const max = Math.floor((MAX_PAYLOAD_BYTES * 3) / 4) - 4096;
    if (stat.size > max)
      throw new Error(
        "The encoded image would be larger than the transport limit. Make the image smaller first.",
      );
    const chunks: Buffer[] = [];
    const stream = handle.createReadStream({
      autoClose: false,
      start: 0,
      end: max,
    });
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    data = Buffer.concat(chunks);
    if (data.length > max)
      throw new Error(
        "The image grew while it was read and is now larger than the transport limit.",
      );
  } finally {
    await handle.close();
  }
  const type = await fileTypeFromBuffer(data);
  if (
    !type ||
    !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(type.mime)
  )
    throw new Error("Only PNG, JPEG, WebP, and GIF images are supported.");
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

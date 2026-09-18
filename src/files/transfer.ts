import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  mkdir,
  open,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import type { HostFile } from "./contracts.js";
import type { OpenDownload } from "./download.js";

export const READ_FLAGS =
  constants.O_RDONLY |
  (constants.O_NOFOLLOW ?? 0) |
  (constants.O_NONBLOCK ?? 0);
export async function writeStream(
  source: Readable,
  target: FileHandle,
  maxBytes: number,
  signal: AbortSignal,
): Promise<{ size: number; sha256: string }> {
  let size = 0;
  const hash = createHash("sha256");
  const abort = () => source.destroy(new Error("文件传输已取消。"));
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    for await (const chunk of source) {
      signal.throwIfAborted();
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > maxBytes) throw new Error("文件超过配置的传输大小限制。");
      hash.update(bytes);
      let offset = 0;
      while (offset < bytes.length) {
        const written = await target.write(
          bytes,
          offset,
          bytes.length - offset,
        );
        if (!written.bytesWritten) throw new Error("无法写入文件。");
        offset += written.bytesWritten;
      }
    }
    signal.throwIfAborted();
    await target.sync();
    return { size, sha256: hash.digest("hex") };
  } finally {
    signal.removeEventListener("abort", abort);
    if (!source.readableEnded) source.destroy();
  }
}

export async function importBoundFile(
  reference: HostFile,
  destination: string,
  overwrite: boolean,
  maxBytes: number,
  download: OpenDownload,
  signal: AbortSignal,
): Promise<{ path: string; size: number; sha256: string }> {
  signal.throwIfAborted();
  if (reference.size !== undefined && reference.size > maxBytes)
    throw new Error("文件超过配置的传输大小限制。");
  if (destination.includes("\0")) throw new Error("目标文件路径无效。");
  await mkdir(path.dirname(destination), { recursive: true });
  const partial = path.join(
    path.dirname(destination),
    `.exec-mcp-import-${randomUUID()}.partial`,
  );
  let handle: FileHandle | undefined;
  let published = false;
  try {
    handle = await open(
      partial,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const response = await download(reference.download_url, signal);
    const rawLength = response.headers["content-length"];
    const length = rawLength === undefined ? undefined : Number(rawLength);
    if (
      length !== undefined &&
      (!Number.isSafeInteger(length) || length < 0 || length > maxBytes)
    ) {
      response.destroy();
      throw new Error("文件声明长度无效或超过传输大小限制。");
    }
    const result = await writeStream(response, handle, maxBytes, signal);
    if (
      (reference.size !== undefined && reference.size !== result.size) ||
      (length !== undefined && length !== result.size)
    )
      throw new Error("文件长度与宿主元数据或下载响应不符。");
    await handle.close();
    handle = undefined;
    signal.throwIfAborted();
    if (overwrite) await rename(partial, destination);
    else await link(partial, destination);
    published = true;
    if (!overwrite) await unlink(partial);
    return { path: destination, ...result };
  } catch (error) {
    if (published)
      throw new Error(
        "目标文件可能已写入，但收尾失败；请先检查文件，不要自动重试。",
      );
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error("目标文件已存在；默认不覆盖。");
    if (signal.aborted) throw new Error("文件导入已取消；目标文件未发布。");
    // Network/stream errors can contain signed URLs. Never forward the underlying message.
    throw new Error(
      "文件导入失败（检查下载有效期、大小与目标权限）；目标文件未发布，下载凭据未回显。",
    );
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(partial).catch(() => undefined);
  }
}

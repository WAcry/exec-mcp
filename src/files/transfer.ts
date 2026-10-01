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
const CREATE_FLAGS =
  constants.O_WRONLY |
  constants.O_CREAT |
  constants.O_EXCL |
  (constants.O_NOFOLLOW ?? 0);
/** link() errors from file systems without hard links, such as FAT and some network or FUSE mounts. */
const NO_HARD_LINKS = new Set([
  "EPERM",
  "ENOTSUP",
  "EOPNOTSUPP",
  "EXDEV",
  "ENOSYS",
  "EMLINK",
]);
export async function writeStream(
  source: Readable,
  target: FileHandle,
  maxBytes: number,
  signal: AbortSignal,
): Promise<{ size: number; sha256: string }> {
  let size = 0;
  const hash = createHash("sha256");
  const abort = () =>
    source.destroy(new Error("The file transfer was cancelled."));
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    for await (const chunk of source) {
      signal.throwIfAborted();
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > maxBytes)
        throw new Error(
          "The file is larger than the configured transfer limit (files.max_file_bytes).",
        );
      hash.update(bytes);
      let offset = 0;
      while (offset < bytes.length) {
        const written = await target.write(
          bytes,
          offset,
          bytes.length - offset,
        );
        if (!written.bytesWritten) throw new Error("Cannot write the file.");
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
    throw new Error(
      "The file is larger than the configured transfer limit (files.max_file_bytes).",
    );
  if (destination.includes("\0"))
    throw new Error("The destination path is not valid.");
  await mkdir(path.dirname(destination), { recursive: true });
  const partial = path.join(
    path.dirname(destination),
    `.exec-mcp-import-${randomUUID()}.partial`,
  );
  let handle: FileHandle | undefined;
  let published = false;
  try {
    handle = await open(partial, CREATE_FLAGS, 0o600);
    const response = await download(reference.download_url, signal);
    const rawLength = response.headers["content-length"];
    const length = rawLength === undefined ? undefined : Number(rawLength);
    if (
      length !== undefined &&
      (!Number.isSafeInteger(length) || length < 0 || length > maxBytes)
    ) {
      response.destroy();
      throw new Error(
        "The download reports a size that is not valid or is larger than the transfer limit (files.max_file_bytes).",
      );
    }
    const result = await writeStream(response, handle, maxBytes, signal);
    if (
      (reference.size !== undefined && reference.size !== result.size) ||
      (length !== undefined && length !== result.size)
    )
      throw new Error(
        "The downloaded size does not match the size in the file metadata or the download response.",
      );
    await handle.close();
    handle = undefined;
    signal.throwIfAborted();
    if (overwrite) await rename(partial, destination);
    else await publishNew(partial, destination, signal);
    published = true;
    if (!overwrite) await unlink(partial);
    return { path: destination, ...result };
  } catch (error) {
    if (published)
      throw new Error(
        "The destination file may have been written, but the import did not finish. Check the file before you import again.",
      );
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(
        "The destination file already exists. Set overwrite to true to replace it, or choose another destination.",
      );
    if (signal.aborted)
      throw new Error(
        "The file import was cancelled. The destination was not changed.",
      );
    // Network/stream errors can contain signed URLs. Never forward the underlying message.
    throw new Error(
      "The file import failed. Check that the download link has not expired, the file size, and that the destination is writable. The destination was not changed. The download link is not shown, because it holds a credential.",
    );
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(partial).catch(() => undefined);
  }
}

/** Publish without replacing an existing file, also where hard links are not available. */
async function publishNew(
  partial: string,
  destination: string,
  signal: AbortSignal,
): Promise<void> {
  try {
    await link(partial, destination);
    return;
  } catch (error) {
    if (!NO_HARD_LINKS.has((error as NodeJS.ErrnoException).code ?? ""))
      throw error;
  }
  // O_EXCL still refuses an existing destination. A failed copy removes only
  // the file that it created.
  const target = await open(destination, CREATE_FLAGS, 0o600);
  try {
    const source = await open(partial, READ_FLAGS);
    try {
      await writeStream(
        source.createReadStream({ autoClose: false, start: 0 }),
        target,
        Number.MAX_SAFE_INTEGER,
        signal,
      );
    } finally {
      await source.close();
    }
    await target.close();
  } catch (error) {
    await target.close().catch(() => undefined);
    await unlink(destination).catch(() => undefined);
    throw error;
  }
}

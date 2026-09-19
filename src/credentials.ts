import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

const MAX_TOKEN_FILE_BYTES = 64 * 1024;

/** Startup-only token read: bounded, accepts editor newline/BOM and symlinked secret mounts.
 * No watcher, per-request disk I/O, credential fallback, or secret-bearing error text.
 */
export function readTokenFile(filename: string, field: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(filename, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const info = fstatSync(fd);
    if (!info.isFile() || !info.size || info.size > MAX_TOKEN_FILE_BYTES)
      throw new Error();
    const bytes = Buffer.alloc(MAX_TOKEN_FILE_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size > MAX_TOKEN_FILE_BYTES) throw new Error();
    const token = bytes.subarray(0, size).toString("utf8").trim();
    if (!token) throw new Error();
    return token;
  } catch {
    throw new Error(
      `${field} 必须是可读、非空且不超过 64 KiB 的普通 token 文件；凭据未回显。`,
    );
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

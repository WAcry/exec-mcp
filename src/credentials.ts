import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { isUtf8 } from "node:buffer";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import path from "node:path";

const MAX_TOKEN_FILE_BYTES = 64 * 1024;
const MAX_ENCODED_FILE_BYTES = 96 * 1024;
const FAMILY = "exec-mcp:token:";
export const TOKEN_FILE_PREFIX = `${FAMILY}v1:`;
// Deliberately public and stable: protection against plain-text scans, NOT a secret vault.
// Changing this requires a new envelope version while retaining the old decoder.
const KEY = createHash("sha256")
  .update("exec-mcp/token-file/public-obfuscation-key/v1")
  .digest();

function snapshot(filename: string): { bytes: Buffer; info: Stats } {
  let fd: number | undefined;
  try {
    fd = openSync(filename, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const info = fstatSync(fd);
    if (!info.isFile() || !info.size || info.size > MAX_ENCODED_FILE_BYTES)
      throw new Error();
    const bytes = Buffer.alloc(MAX_ENCODED_FILE_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size > MAX_ENCODED_FILE_BYTES) throw new Error();
    return { bytes: bytes.subarray(0, size), info };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function plainToken(bytes: Buffer): string {
  if (!isUtf8(bytes) || bytes.length > MAX_TOKEN_FILE_BYTES) throw new Error();
  const token = bytes.toString("utf8").trim();
  if (!token || token.includes("\0")) throw new Error();
  return token;
}

function decode(text: string): string {
  if (!text.startsWith(TOKEN_FILE_PREFIX)) throw new Error();
  const encoded = text.slice(TOKEN_FILE_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error();
  const bytes = Buffer.from(encoded, "base64url");
  if (
    bytes.length <= 28 ||
    bytes.length > MAX_TOKEN_FILE_BYTES + 28 ||
    bytes.toString("base64url") !== encoded
  )
    throw new Error();
  const decipher = createDecipheriv("aes-256-gcm", KEY, bytes.subarray(0, 12), {
    authTagLength: 16,
  });
  decipher.setAAD(Buffer.from(TOKEN_FILE_PREFIX));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return plainToken(
    Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]),
  );
}

function encode(token: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", KEY, nonce, {
    authTagLength: 16,
  });
  cipher.setAAD(Buffer.from(TOKEN_FILE_PREFIX));
  const encrypted = Buffer.concat([
    cipher.update(token, "utf8"),
    cipher.final(),
  ]);
  return (
    TOKEN_FILE_PREFIX +
    Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString(
      "base64url",
    ) +
    "\n"
  );
}

/** Replace only the selected target, preserving symlinks and leaving no plaintext temporary copy. */
function protect(
  filename: string,
  target: string,
  original: ReturnType<typeof snapshot>,
  token: string,
) {
  if (!(original.info.mode & 0o222)) throw new Error();
  const temporary = path.join(
    path.dirname(target),
    `.exec-mcp-token-${randomBytes(12).toString("hex")}.tmp`,
  );
  let fd: number | undefined;
  let created = false;
  try {
    fd = openSync(temporary, "wx", 0o600);
    created = true;
    writeFileSync(fd, encode(token), "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    // Catch ordinary editor/rotation races; a failed migration never truncates the old file.
    if (realpathSync(filename) !== target) throw new Error();
    const current = snapshot(target);
    if (
      !current.bytes.equals(original.bytes) ||
      current.info.ino !== original.info.ino ||
      current.info.dev !== original.info.dev
    ) {
      // Two startup processes may race to protect the same unchanged value.
      if (decode(current.bytes.toString("utf8").trim()) === token) return;
      throw new Error();
    }
    renameSync(temporary, target);
    created = false;
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (created) unlinkSync(temporary);
  }
}

/** Startup-only, bounded read. Pasted plaintext is protected once; rotation is another plaintext paste.
 * Corrupt/version-unknown envelopes fail without rewriting or falling back to another credential.
 */
export function readTokenFile(filename: string, field: string): string {
  for (let attempt = 0; ; attempt++) {
    let stage: "read" | "decode" | "protect" = "read";
    try {
      const target = realpathSync(filename);
      const original = snapshot(target);
      if (!isUtf8(original.bytes)) throw new Error();
      const text = original.bytes.toString("utf8").trim();
      if (text.startsWith(FAMILY)) {
        stage = "decode";
        return decode(text);
      }
      const token = plainToken(original.bytes);
      stage = "protect";
      protect(filename, target, original, token);
      return token;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      // Windows replacement can briefly conflict with another startup's open file.
      // Retry only filesystem contention, re-reading the latest value each time;
      // malformed envelopes and detected edits remain errors, not credential fallback.
      if (
        process.platform === "win32" &&
        attempt < 5 &&
        ["EACCES", "EPERM", "EBUSY", "EEXIST", "ENOENT"].includes(code ?? "")
      ) {
        Atomics.wait(
          new Int32Array(new SharedArrayBuffer(4)),
          0,
          0,
          25 * 2 ** attempt,
        );
        continue;
      }
      const detail =
        stage === "decode"
          ? "加密 token 文件损坏或版本不支持；请使用兼容版本或用新明文 token 覆盖原文件。"
          : stage === "protect"
            ? "无法保存 token 文件的轻量加密；请确认文件及所在目录可写，或稍后重试。未回退使用明文。"
            : "必须是可读、非空的普通 token 文件；明文最多 64 KiB。";
      const reason =
        typeof code === "string" && /^E[A-Z0-9_]{1,30}$/.test(code)
          ? `（${code}）`
          : "";
      throw new Error(`${field}：${detail}${reason}凭据未回显。`);
    }
  }
}

import { createHmac, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { encodeTokenFile, readTokenFile } from "../credentials.js";
import { tokenMatches, WEB_SESSION_MAX_AGE_SECONDS } from "./security.js";

export function webTokenPath(configPath: string): string {
  const config = path.resolve(configPath);
  return path.join(
    path.dirname(config),
    ".exec-mcp",
    `${path.basename(config)}.web-token`,
  );
}

/** Only startup and explicit rotation write to disk. Publication is atomic,
 * including concurrent first starts; a failed rotation leaves the old key valid. */
function saveToken(filename: string, token: string, replace: boolean): void {
  const directory = path.dirname(filename);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(
    directory,
    `.web-token-${randomBytes(12).toString("hex")}.tmp`,
  );
  let fd: number | undefined;
  let created = false;
  try {
    fd = openSync(temporary, "wx", 0o600);
    created = true;
    writeFileSync(fd, encodeTokenFile(token), "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    if (replace) renameSync(temporary, filename);
    else {
      try {
        linkSync(temporary, filename);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
  } catch {
    throw new Error(
      "无法保存 Web 登录凭据；请确认配置目录可写。已有凭据未被替换。",
    );
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (created && existsSync(temporary)) unlinkSync(temporary);
  }
}

/** Stateless, sliding-expiry cookies. The bootstrap token stays out of cookies;
 * persisting its signing key keeps remembered browsers valid across restarts. */
export class WebSessionAuth {
  private value: string;
  private readonly filename: string | undefined;

  constructor(configPath: string, token?: string) {
    this.filename = token === undefined ? webTokenPath(configPath) : undefined;
    if (this.filename !== undefined) {
      if (!existsSync(this.filename))
        saveToken(this.filename, randomBytes(32).toString("base64url"), false);
      this.value = readTokenFile(this.filename, "Web 登录凭据");
    } else this.value = token!;
  }

  get token(): string {
    return this.value;
  }

  issueCookie(now = Date.now()): string {
    const expiry = Math.floor(now / 1000) + WEB_SESSION_MAX_AGE_SECONDS;
    const payload = `v1.${expiry}`;
    return `${payload}.${this.sign(payload)}`;
  }

  verifyCookie(cookie: string | undefined, now = Date.now()): boolean {
    if (!cookie) return false;
    const match = /^(v1[.]([0-9]{1,13}))[.]([A-Za-z0-9_-]{43})$/.exec(cookie);
    return (
      !!match &&
      Number(match[2]) > Math.floor(now / 1000) &&
      tokenMatches(match[3], this.sign(match[1]!))
    );
  }

  rotate(): string {
    const token = randomBytes(32).toString("base64url");
    if (this.filename !== undefined) saveToken(this.filename, token, true);
    this.value = token;
    return token;
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.value)
      .update(`exec-mcp/web-session/${payload}`)
      .digest("base64url");
  }
}

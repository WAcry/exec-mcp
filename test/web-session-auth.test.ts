import {
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
  mkdir,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSessionAuth, webTokenPath } from "../src/web/session-auth.js";
import { TOKEN_FILE_PREFIX } from "../src/credentials.js";
import { WEB_SESSION_MAX_AGE_SECONDS, webCookie } from "../src/web/security.js";

let root: string;
const day = 24 * 60 * 60 * 1000;
const start = Date.UTC(2026, 0, 1);
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "web-session-auth-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("remembered Web browser authentication", () => {
  it("uses a persistent HttpOnly cookie and enforces 30-day expiry on the server", () => {
    const auth = new WebSessionAuth(path.join(root, "config.toml"));
    const ticket = auth.issueCookie(start);
    expect(ticket).not.toContain(auth.token);
    expect(auth.verifyCookie(ticket, start)).toBe(true);
    expect(auth.verifyCookie(ticket, start + 30 * day - 1)).toBe(true);
    expect(auth.verifyCookie(ticket, start + 30 * day)).toBe(false);
    expect(auth.verifyCookie(auth.token, start)).toBe(false);
    expect(WEB_SESSION_MAX_AGE_SECONDS).toBe(2592000);
    expect(webCookie(ticket)).toContain(
      "Path=/api; HttpOnly; SameSite=Strict; Max-Age=2592000",
    );
    expect(webCookie("", true)).toContain("Max-Age=0");
  });

  it("renews beyond the original deadline without a fixed maximum login lifetime", () => {
    const auth = new WebSessionAuth(path.join(root, "config.toml"));
    let ticket = auth.issueCookie(start);
    for (let visit = 1; visit <= 12; visit++) {
      const now = start + visit * 29 * day;
      expect(auth.verifyCookie(ticket, now)).toBe(true);
      ticket = auth.issueCookie(now);
    }
    expect(auth.verifyCookie(ticket, start + (12 * 29 + 30) * day)).toBe(false);
  });

  it("rejects forged expiration, malformed signatures and another instance's ticket", () => {
    const auth = new WebSessionAuth(path.join(root, "one.toml"));
    const other = new WebSessionAuth(path.join(root, "two.toml"));
    const ticket = auth.issueCookie(start);
    const [version, expiry, signature] = ticket.split(".");
    for (const invalid of [
      undefined,
      "",
      auth.token,
      `${version}.${Number(expiry) + 1}.${signature}`,
      `v2.${expiry}.${signature}`,
      `${version}.${expiry}!${signature}`,
      `${ticket}x`,
      `${version}.${expiry}.${"a".repeat(43)}`,
      other.issueCookie(start),
    ])
      expect(auth.verifyCookie(invalid, start)).toBe(false);
  });

  it("retains the key across restarts, never rewrites it during renewal, and stores no plaintext token", async () => {
    const config = path.join(root, "my config.toml");
    const first = new WebSessionAuth(config);
    const filename = webTokenPath(config);
    const saved = await readFile(filename, "utf8");
    expect(saved.startsWith(TOKEN_FILE_PREFIX)).toBe(true);
    expect(saved).not.toContain(first.token);
    if (process.platform !== "win32")
      expect((await stat(filename)).mode & 0o777).toBe(0o600);
    const second = new WebSessionAuth(config);
    expect(second.token).toBe(first.token);
    expect(
      second.verifyCookie(first.issueCookie(start), start + 29 * day),
    ).toBe(true);
    second.issueCookie(start + day);
    expect(await readFile(filename, "utf8")).toBe(saved);
  });

  it("persists explicit rotation and invalidates earlier cookies", () => {
    const config = path.join(root, "config.toml");
    const first = new WebSessionAuth(config);
    const oldToken = first.token;
    const oldCookie = first.issueCookie(start);
    first.rotate();
    expect(first.token).not.toBe(oldToken);
    expect(first.verifyCookie(oldCookie, start)).toBe(false);
    const restarted = new WebSessionAuth(config);
    expect(restarted.token).toBe(first.token);
    expect(restarted.verifyCookie(oldCookie, start)).toBe(false);
    expect(restarted.verifyCookie(first.issueCookie(start), start)).toBe(true);
  });

  it("does not overwrite corrupt saved credentials or change the live token when saving fails", async () => {
    const config = path.join(root, "config.toml");
    const auth = new WebSessionAuth(config);
    const filename = webTokenPath(config);
    await writeFile(filename, `${TOKEN_FILE_PREFIX}broken`);
    expect(() => new WebSessionAuth(config)).toThrow("Web 登录凭据");
    expect(await readFile(filename, "utf8")).toBe(`${TOKEN_FILE_PREFIX}broken`);
    await rm(filename);
    await mkdir(filename);
    const old = auth.token;
    expect(() => auth.rotate()).toThrow("已有凭据未被替换");
    expect(auth.token).toBe(old);
    expect(auth.verifyCookie(auth.issueCookie(start), start)).toBe(true);
  });

  it("publishes one complete key when independent processes start concurrently", async () => {
    const config = path.join(root, "config.toml");
    const module = new URL("../src/web/session-auth.ts", import.meta.url).href;
    const source = `import {WebSessionAuth} from ${JSON.stringify(module)};const auth=new WebSessionAuth(${JSON.stringify(config)});console.log(auth.issueCookie(${start}));`;
    const run = promisify(execFile);
    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        run(
          process.execPath,
          ["--import", "tsx", "--input-type=module", "--eval", source],
          { timeout: 10000 },
        ),
      ),
    );
    expect(new Set(results.map((r) => r.stdout.trim())).size).toBe(1);
    expect(
      new WebSessionAuth(config).verifyCookie(results[0]!.stdout.trim(), start),
    ).toBe(true);
  });
});

import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fault = vi.hoisted(() => ({
  stage: "" as "" | "sync" | "rename" | "rotation",
  target: "",
  observedEncrypted: false,
  busyRenames: 0,
  renameCalls: 0,
}));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    fsyncSync(fd: number) {
      if (fault.stage === "sync") throw new Error("PRIVATE_FAILURE_CONTENT");
      fs.fsyncSync(fd);
      if (fault.stage === "rotation")
        fs.writeFileSync(fault.target, "newer-token-from-user");
    },
    renameSync(from: string, to: string) {
      fault.renameCalls++;
      if (fault.busyRenames > 0) {
        fault.busyRenames--;
        throw Object.assign(new Error("fixture file sharing conflict"), {
          code: "EBUSY",
        });
      }
      fault.observedEncrypted = fs
        .readFileSync(from, "utf8")
        .startsWith("exec-mcp:token:v1:");
      if (fault.stage === "rename") throw new Error("PRIVATE_FAILURE_CONTENT");
      fs.renameSync(from, to);
    },
  };
});
import { readTokenFile, TOKEN_FILE_PREFIX } from "../src/credentials.js";

const directories: string[] = [];
const token = "synthetic-api-key-token-0123456789";
const golden =
  "exec-mcp:token:v1:AAECAwQFBgcICQoLpLm3Y8NDpwZj8wwZi5iRNrWqr57CpfyrGeOQNRuZMpOglH9tHfZayFYXnQIcVzbJYCWhug";
beforeEach(() => {
  fault.stage = "";
  fault.target = "";
  fault.observedEncrypted = false;
  fault.busyRenames = 0;
  fault.renameCalls = 0;
});
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const root of directories.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function file() {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "exec token ' 中文-")),
  );
  directories.push(root);
  const target = path.join(root, "token.txt");
  await writeFile(target, token);
  return { root, target };
}

describe("lightweight token-file protection", () => {
  it("retries brief Windows replacement conflicts and keeps persistent failure bounded", async () => {
    const { root, target } = await file();
    const actualProcess = process;
    vi.stubGlobal(
      "process",
      new Proxy(actualProcess, {
        get: (object, key) =>
          key === "platform" ? "win32" : Reflect.get(object, key),
      }),
    );
    fault.busyRenames = 2;
    expect(readTokenFile(target, "fixture")).toBe(token);
    expect(fault.renameCalls).toBe(3);
    expect(await readdir(root)).toEqual(["token.txt"]);
    await writeFile(target, token);
    fault.renameCalls = 0;
    fault.busyRenames = 100;
    expect(() => readTokenFile(target, "fixture")).toThrow("EBUSY");
    expect(fault.renameCalls).toBe(6);
    expect(await readFile(target, "utf8")).toBe(token);
    expect(await readdir(root)).toEqual(["token.txt"]);
  });
  it("protects plaintext once, uses fresh nonces, and accepts a pasted replacement on the next startup", async () => {
    const first = await file();
    const second = await file();
    expect(readTokenFile(first.target, "fixture")).toBe(token);
    const encrypted = await readFile(first.target, "utf8");
    const info = await stat(first.target);
    expect(encrypted.startsWith(TOKEN_FILE_PREFIX)).toBe(true);
    expect(encrypted).not.toContain(token);
    expect(fault.observedEncrypted).toBe(true);
    expect(readTokenFile(first.target, "fixture")).toBe(token);
    expect(await readFile(first.target, "utf8")).toBe(encrypted);
    expect((await stat(first.target)).mtimeMs).toBe(info.mtimeMs);
    expect(readTokenFile(second.target, "fixture")).toBe(token);
    expect(await readFile(second.target, "utf8")).not.toBe(encrypted);
    await writeFile(first.target, "\uFEFFrotated-test-token\r\n");
    expect(readTokenFile(first.target, "fixture")).toBe("rotated-test-token");
    expect(await readFile(first.target, "utf8")).not.toContain(
      "rotated-test-token",
    );
    expect(await readdir(first.root)).toEqual(["token.txt"]);
  });
  it("retains the version-1 decoding contract and allows protected files to move between installations", async () => {
    const { target } = await file();
    await writeFile(target, golden + "\r\n");
    expect(readTokenFile(target, "fixture")).toBe(
      "synthetic-format-v1-token-0123456789",
    );
    const code = `import {readTokenFile} from ${JSON.stringify(new URL("../src/credentials.ts", import.meta.url).href)};console.log(readTokenFile(process.argv[1],'fixture')==='synthetic-format-v1-token-0123456789');`;
    const child = await promisify(execFile)(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", code, target],
      { encoding: "utf8", timeout: 10000 },
    );
    expect(child.stdout.trim()).toBe("true");
    expect(await readFile(target, "utf8")).toBe(golden + "\r\n");
  });
  it("rejects corruption, unknown versions and malformed envelopes without rewriting them", async () => {
    const { target } = await file();
    const values = [
      golden.replace("v1:", "v2:"),
      TOKEN_FILE_PREFIX,
      TOKEN_FILE_PREFIX + "***",
      golden + "=",
      golden.slice(0, -4),
      golden.slice(0, -5) + "AAAAA",
    ];
    for (const value of values) {
      await writeFile(target, value);
      expect(() => readTokenFile(target, "fixture")).toThrow(
        "损坏或版本不支持",
      );
      expect(await readFile(target, "utf8")).toBe(value);
    }
  });
  it("keeps the full 64 KiB plaintext allowance after encryption overhead is added", async () => {
    const { target } = await file();
    const largest = "a".repeat(64 * 1024);
    await writeFile(target, largest);
    expect(readTokenFile(target, "fixture")).toBe(largest);
    expect((await stat(target)).size).toBeGreaterThan(64 * 1024);
    expect(readTokenFile(target, "fixture")).toBe(largest);
    await writeFile(target, largest + "x");
    expect(() => readTokenFile(target, "fixture")).toThrow("64 KiB");
    await writeFile(target, Buffer.from([0xff, 0xfe, 0, 0]));
    expect(() => readTokenFile(target, "fixture")).toThrow("普通 token 文件");
  });
  it.each(["sync", "rename"] as const)(
    "leaves the original file intact and no temporary files on %s failure",
    async (stage) => {
      const { root, target } = await file();
      fault.stage = stage;
      expect(() => readTokenFile(target, "fixture")).toThrow("无法保存");
      let message = "";
      try {
        readTokenFile(target, "fixture");
      } catch (error) {
        message = String(error);
      }
      expect(message).not.toContain("PRIVATE_FAILURE_CONTENT");
      expect(message).not.toContain(token);
      expect(await readFile(target, "utf8")).toBe(token);
      expect(await readdir(root)).toEqual(["token.txt"]);
    },
  );
  it("does not replace a detected concurrent plaintext rotation", async () => {
    const { root, target } = await file();
    fault.stage = "rotation";
    fault.target = target;
    expect(() => readTokenFile(target, "fixture")).toThrow("无法保存");
    expect(await readFile(target, "utf8")).toBe("newer-token-from-user");
    expect(await readdir(root)).toEqual(["token.txt"]);
    fault.stage = "";
    expect(readTokenFile(target, "fixture")).toBe("newer-token-from-user");
  });
  it("allows concurrent process startups to migrate the same value without partial ciphertext", async () => {
    const { target } = await file();
    const code = `import {readTokenFile} from ${JSON.stringify(new URL("../src/credentials.ts", import.meta.url).href)};console.log(readTokenFile(process.argv[1],'fixture').length);`;
    const children = await Promise.all(
      Array.from({ length: 4 }, () =>
        promisify(execFile)(
          process.execPath,
          ["--import", "tsx", "--input-type=module", "--eval", code, target],
          { encoding: "utf8", timeout: 15000 },
        ),
      ),
    );
    expect(
      children.every((child) => child.stdout.trim() === String(token.length)),
    ).toBe(true);
    expect(readTokenFile(target, "fixture")).toBe(token);
  });
  it.skipIf(process.platform === "win32")(
    "restricts new ciphertext to owner access and preserves file symlinks",
    async () => {
      const { root, target } = await file();
      await chmod(target, 0o644);
      const alias = path.join(root, "alias");
      await symlink(target, alias);
      expect(readTokenFile(alias, "fixture")).toBe(token);
      expect((await lstat(alias)).isSymbolicLink()).toBe(true);
      expect((await stat(target)).mode & 0o777).toBe(0o600);
      await chmod(target, 0o400);
      expect(readTokenFile(alias, "fixture")).toBe(token);
    },
  );
  it.skipIf(process.platform === "win32")(
    "requires writable plaintext but supports already-encrypted read-only mounts",
    async () => {
      const { target } = await file();
      await chmod(target, 0o400);
      expect(() => readTokenFile(target, "fixture")).toThrow("无法保存");
      expect(await readFile(target, "utf8")).toBe(token);
      await chmod(target, 0o600);
      readTokenFile(target, "fixture");
      await chmod(target, 0o400);
      expect(readTokenFile(target, "fixture")).toBe(token);
    },
  );
});

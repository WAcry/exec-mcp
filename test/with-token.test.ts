import { spawn } from "node:child_process";
import {
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runWithToken } from "../src/with-token.js";
import { TOKEN_FILE_PREFIX } from "../src/credentials.js";

const directories: string[] = [];
afterEach(async () => {
  for (const root of directories.splice(0))
    await rm(root, { recursive: true, force: true });
});
const token = "synthetic-openai-runtime-token-0123456789012345";
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
async function setup() {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "exec with token ' 中文-")),
  );
  directories.push(root);
  const filename = path.join(root, "runtime token.txt");
  await writeFile(filename, token);
  const program = path.join(root, "client.cjs");
  await writeFile(
    program,
    `const {createHash}=require('node:crypto');console.log(JSON.stringify({hash:createHash('sha256').update(process.env.CONTROL_PLANE_API_KEY).digest('hex'),args:process.argv.slice(2),proxy:process.env.HTTPS_PROXY,cwd:process.cwd()}));process.exitCode=Number(process.env.EXEC_MCP_TEST_EXIT||0);`,
  );
  return { root, filename, program };
}
async function invoke(
  root: string,
  args: string[],
  environment: NodeJS.ProcessEnv = {},
) {
  const child = spawn(process.execPath, ["--import", "tsx", cli, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...environment },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "",
    stderr = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const timer = setTimeout(() => child.kill(), 15000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    return { code, stdout, stderr, root };
  } finally {
    clearTimeout(timer);
  }
}

describe("CLI adapter for external token consumers", () => {
  it("protects the file and passes plaintext only in the selected child environment, preserving native args and exit status", async () => {
    const { root, filename, program } = await setup();
    const previous = process.env.CONTROL_PLANE_API_KEY;
    const args = [
      "--profile",
      "exec-mcp",
      "--config",
      "a file.toml",
      "--help",
      "quoted'\" and spaces",
      "C:\\path\\",
      "中文",
      "",
    ];
    const result = await invoke(
      root,
      [
        "with-token",
        "CONTROL_PLANE_API_KEY",
        filename,
        "--",
        process.execPath,
        program,
        ...args,
      ],
      {
        CONTROL_PLANE_API_KEY: "inherited-other-token",
        HTTPS_PROXY: "http://proxy.fixture.test:8080",
        EXEC_MCP_TEST_EXIT: "7",
      },
    );
    expect(result.code, result.stderr).toBe(7);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      hash: createHash("sha256").update(token).digest("hex"),
      args,
      proxy: "http://proxy.fixture.test:8080",
      cwd: process.cwd(),
    });
    const encrypted = await readFile(filename, "utf8");
    expect(encrypted.startsWith(TOKEN_FILE_PREFIX)).toBe(true);
    expect(encrypted).not.toContain(token);
    expect(result.stdout + result.stderr).not.toContain(token);
    expect(process.env.CONTROL_PLANE_API_KEY).toBe(previous);
    expect((await readdir(root)).sort()).toEqual([
      "client.cjs",
      "runtime token.txt",
    ]);
  });
  it("decrypts on repeated startup and protects a newly pasted key at the same path", async () => {
    const { root, filename, program } = await setup();
    const args = [
      "with-token",
      "CONTROL_PLANE_API_KEY",
      filename,
      "--",
      process.execPath,
      program,
    ];
    expect((await invoke(root, args)).code).toBe(0);
    const protectedFirst = await readFile(filename, "utf8");
    expect((await invoke(root, args)).code).toBe(0);
    expect(await readFile(filename, "utf8")).toBe(protectedFirst);
    const replacement = token + "-rotated";
    await writeFile(filename, "\uFEFF" + replacement + "\r\n");
    const result = await invoke(root, args);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).hash).toBe(
      createHash("sha256").update(replacement).digest("hex"),
    );
    expect(await readFile(filename, "utf8")).not.toContain(replacement);
  });
  it("fails before launching a client for malformed/corrupt input and never falls back to the inherited token", async () => {
    const { root, filename, program } = await setup();
    const invocation = [
      "with-token",
      "CONTROL_PLANE_API_KEY",
      filename,
      "--",
      process.execPath,
      program,
    ];
    await writeFile(filename, TOKEN_FILE_PREFIX + "CORRUPT");
    const result = await invoke(root, invocation, {
      CONTROL_PLANE_API_KEY: "still-not-a-fallback",
    });
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("损坏或版本不支持");
    expect(result.stderr).not.toContain("CORRUPT");
    expect(result.stderr).not.toContain("still-not-a-fallback");
    expect(await readFile(filename, "utf8")).toBe(
      TOKEN_FILE_PREFIX + "CORRUPT",
    );
    for (const args of [
      [],
      ["BAD=ENV", filename, "--", process.execPath],
      ["TOKEN", filename, "wrong", process.execPath],
    ])
      await expect(runWithToken(args)).rejects.toThrow("用法");
    await expect(
      runWithToken(["TOKEN", filename, "--", path.join(root, "absent-client")]),
    ).rejects.toThrow("可用的原生可执行文件");
  });
  it("offers help without reading any token or launching a process", async () => {
    const { root } = await setup();
    const result = await invoke(root, ["with-token", "--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("环境变量名 token文件 -- 可执行文件");
    await expect(runWithToken([], AbortSignal.abort())).rejects.toThrow();
  });
  it("cancels its own foreground helper while leaving the encrypted source intact", async () => {
    const { root, filename, program } = await setup();
    const ready = path.join(root, "ready");
    await writeFile(
      program,
      `require('node:fs').writeFileSync(process.argv[2],String(process.pid));setInterval(()=>{},1000);`,
    );
    const controller = new AbortController();
    const running = runWithToken(
      [
        "CONTROL_PLANE_API_KEY",
        filename,
        "--",
        process.execPath,
        program,
        ready,
      ],
      controller.signal,
    );
    let pid = 0;
    try {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        try {
          pid = Number(await readFile(ready, "utf8"));
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      expect(pid).toBeGreaterThan(0);
    } finally {
      controller.abort();
      await running;
    }
    expect(() => process.kill(pid, 0)).toThrow();
    expect(
      (await readFile(filename, "utf8")).startsWith(TOKEN_FILE_PREFIX),
    ).toBe(true);
  });
});

import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const rootScript = new URL("../scripts/fix-node-pty.mjs", import.meta.url).href;
const directories: string[] = [];
async function root() {
  const directory = await mkdtemp(path.join(tmpdir(), "exec-mcp-install-"));
  directories.push(directory);
  return directory;
}
async function repair(directory: string, platform = "darwin", arch = "arm64") {
  return run(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `const {fixNodePtyPermissions}=await import(${JSON.stringify(rootScript)});await fixNodePtyPermissions(${JSON.stringify(directory)},${JSON.stringify(platform)},${JSON.stringify(arch)});`,
    ],
    { timeout: 5000 },
  );
}
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("installing the pinned native PTY dependency", () => {
  it("starts the CLI from a symlinked directory and keeps module imports side-effect-free", async () => {
    const directory = await root();
    const alias = path.join(directory, "linked checkout");
    await symlink(
      process.cwd(),
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    const help = await run(
      process.execPath,
      ["--import", "tsx", path.join(alias, "src", "cli.ts"), "--help"],
      { timeout: 10_000 },
    );
    expect(help.stdout).toContain("init|serve|doctor");
    const imported = await run(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        `await import(${JSON.stringify(new URL("../src/cli.ts", import.meta.url).href)});console.log("only-imported");`,
      ],
      { timeout: 10_000 },
    );
    expect(imported.stdout.trim()).toBe("only-imported");
  });
  it("does nothing for platforms that do not use the macOS helper", async () => {
    const directory = await root();
    await expect(
      repair(path.join(directory, "not-installed"), "linux"),
    ).resolves.toMatchObject({ stdout: "", stderr: "" });
    await expect(
      repair(path.join(directory, "not-installed"), "win32"),
    ).resolves.toMatchObject({ stdout: "", stderr: "" });
  });
  it("reports missing helper files instead of claiming a working install", async () => {
    await expect(repair(await root())).rejects.toThrow("spawn-helper");
  });
  it.skipIf(process.platform === "win32")(
    "repairs executable bits only on the installed architecture and source build helpers, idempotently",
    async () => {
      const directory = await root();
      const files = [
        "prebuilds/darwin-arm64/spawn-helper",
        "build/Release/spawn-helper",
        "prebuilds/darwin-x64/spawn-helper",
        "unrelated",
      ];
      for (const relative of files) {
        const file = path.join(directory, relative);
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, "test helper");
        await chmod(file, 0o644);
      }
      await repair(directory);
      await repair(directory);
      expect((await lstat(path.join(directory, files[0]!))).mode & 0o777).toBe(
        0o755,
      );
      expect((await lstat(path.join(directory, files[1]!))).mode & 0o777).toBe(
        0o755,
      );
      expect((await lstat(path.join(directory, files[2]!))).mode & 0o777).toBe(
        0o644,
      );
      expect((await lstat(path.join(directory, files[3]!))).mode & 0o777).toBe(
        0o644,
      );
    },
  );
  it.skipIf(process.platform === "win32")(
    "does not follow an unexpected helper symlink when changing permissions",
    async () => {
      const directory = await root();
      const target = path.join(directory, "outside");
      await writeFile(target, "do not change");
      await chmod(target, 0o600);
      const helper = path.join(
        directory,
        "prebuilds/darwin-arm64/spawn-helper",
      );
      await mkdir(path.dirname(helper), { recursive: true });
      await symlink(target, helper);
      await expect(repair(directory)).rejects.toThrow("普通文件");
      expect((await lstat(target)).mode & 0o777).toBe(0o600);
    },
  );
});

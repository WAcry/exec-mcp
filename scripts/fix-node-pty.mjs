import { chmod, lstat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** node-pty 1.1.0 ships macOS spawn-helper as 0644 (microsoft/node-pty#850).
 * Repair only this installed dependency's regular helper files, including source builds.
 * This is part of installation, not a CI-only workaround or a runtime chmod.
 */
export async function fixNodePtyPermissions(
  root,
  platform = process.platform,
  arch = process.arch,
) {
  if (platform !== "darwin") return;
  root ??= path.dirname(
    createRequire(import.meta.url).resolve("node-pty/package.json"),
  );
  let found = false;
  for (const directory of [
    "build/Release",
    "build/Debug",
    `prebuilds/darwin-${arch}`,
  ]) {
    const file = path.join(root, directory, "spawn-helper");
    let info;
    try {
      info = await lstat(file);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (!info.isFile())
      throw new Error("node-pty spawn-helper 必须是普通文件。");
    found = true;
    if ((info.mode & 0o111) !== 0o111)
      await chmod(file, (info.mode & 0o777) | 0o111);
  }
  if (!found)
    throw new Error(
      "找不到 node-pty 的 macOS spawn-helper；请检查原生依赖安装。",
    );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  await fixNodePtyPermissions();
}

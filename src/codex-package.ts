import { accessSync, constants, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

export const PINNED_CODEX_VERSION = "0.150.0";
const require = createRequire(import.meta.url);
const TARGETS: Record<string, string> = {
  "linux-x64": "x86_64-unknown-linux-musl",
  "linux-arm64": "aarch64-unknown-linux-musl",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
  "win32-x64": "x86_64-pc-windows-msvc",
  "win32-arm64": "aarch64-pc-windows-msvc",
};
export function codexTarget(
  platform = process.platform as string,
  arch = process.arch as string,
): { suffix: string; target: string } {
  const suffix = `${platform}-${arch}`;
  const target = TARGETS[suffix];
  if (!target) throw new Error(`不支持的平台：${suffix}`);
  return { suffix, target };
}
export function resolveCodexBinary(
  name: "codex" | "codex-code-mode-host",
): string {
  const { suffix, target } = codexTarget();
  const manifest = require.resolve(`@openai/codex-${suffix}/package.json`);
  const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { version: string };
  if (pkg.version !== `${PINNED_CODEX_VERSION}-${suffix}`)
    throw new Error(
      `Codex 平台包版本不匹配：需要 ${PINNED_CODEX_VERSION}-${suffix}`,
    );
  const binary = path.join(
    path.dirname(manifest),
    "vendor",
    target,
    "bin",
    `${name}${process.platform === "win32" ? ".exe" : ""}`,
  );
  accessSync(binary, constants.X_OK);
  return binary;
}

import { accessSync, constants, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/**
 * The @openai/codex version that exec-mcp runs. Tests keep it equal to the
 * package.json dependency, the lockfile, and the tag in proto/PROVENANCE.json.
 */
export const PINNED_CODEX_VERSION = "0.155.1";
/** The codex-package.json layout that this locator can read. */
const PACKAGE_LAYOUT_VERSION = 1;
const REINSTALL =
  "Reinstall exec-mcp, or run npm ci in its directory, to install the pinned Codex package.";
const UPDATE =
  "This exec-mcp version cannot read this Codex package layout. Reinstall exec-mcp, and update it if the problem continues.";
const require = createRequire(import.meta.url);
type CodexBinaryName = "codex" | "codex-code-mode-host";
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
  if (!target)
    throw new Error(
      `Codex does not support the platform ${suffix}. Supported platforms: ${Object.keys(TARGETS).join(", ")}.`,
    );
  return { suffix, target };
}

/** Returns the path of a binary in the installed Codex platform package. */
export function resolveCodexBinary(name: CodexBinaryName): string {
  const { suffix } = codexTarget();
  const packageName = `@openai/codex-${suffix}`;
  let manifest: string;
  try {
    manifest = require.resolve(`${packageName}/package.json`);
  } catch {
    throw new Error(
      `Cannot find the Codex platform package ${packageName}. ${REINSTALL}`,
    );
  }
  return codexBinaryInPackage(path.dirname(manifest), name);
}

/**
 * Checks the Codex platform package in packageDir against the pinned version
 * and its vendor/<target>/codex-package.json, then returns the binary path.
 */
export function codexBinaryInPackage(
  packageDir: string,
  name: CodexBinaryName,
  platform = process.platform as string,
  arch = process.arch as string,
): string {
  const { suffix, target } = codexTarget(platform, arch);
  const exe = platform === "win32" ? ".exe" : "";
  const manifest = path.join(packageDir, "package.json");
  const pkg = readJsonObject(manifest);
  expectField(manifest, pkg, "version", `${PINNED_CODEX_VERSION}-${suffix}`);

  const vendorDir = path.join(packageDir, "vendor", target);
  const layoutFile = path.join(vendorDir, "codex-package.json");
  const layout = readJsonObject(layoutFile);
  expectField(
    layoutFile,
    layout,
    "layoutVersion",
    PACKAGE_LAYOUT_VERSION,
    UPDATE,
  );
  expectField(layoutFile, layout, "version", PINNED_CODEX_VERSION);
  expectField(layoutFile, layout, "target", target);
  // Layout 1 puts codex-code-mode-host in bin/, next to the codex entrypoint.
  expectField(layoutFile, layout, "entrypoint", `bin/codex${exe}`, UPDATE);
  const binary = path.join(vendorDir, "bin", `${name}${exe}`);
  try {
    accessSync(binary, constants.X_OK);
  } catch (error) {
    throw new Error(
      `The Codex binary ${binary} is missing or cannot run (${reason(error)}). ${REINSTALL}`,
    );
  }
  return binary;
}

function readJsonObject(file: string): Record<string, unknown> {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(
      `Cannot read the Codex package file ${file} (${reason(error)}). ${REINSTALL}`,
    );
  }
  if (typeof data !== "object" || data === null || Array.isArray(data))
    throw new Error(
      `The Codex package file ${file} does not contain a JSON object. ${REINSTALL}`,
    );
  return data as Record<string, unknown>;
}

function expectField(
  file: string,
  data: Record<string, unknown>,
  field: string,
  expected: string | number,
  action = REINSTALL,
): void {
  const actual = data[field];
  if (actual === expected) return;
  const found = actual === undefined ? "no value" : JSON.stringify(actual);
  throw new Error(
    `The Codex package file ${file} has the wrong "${field}" value. Expected ${JSON.stringify(expected)}, found ${found}. ${action}`,
  );
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

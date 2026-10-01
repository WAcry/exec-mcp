import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PINNED_CODEX_VERSION,
  codexBinaryInPackage,
  codexTarget,
  resolveCodexBinary,
} from "../src/codex-package.js";

const UPGRADE =
  "A Codex upgrade must update the pin, proto/codex.code_mode.v1.proto, and proto/PROVENANCE.json together.";
const BINARIES = ["codex", "codex-code-mode-host"] as const;

async function readJson(file: string) {
  return JSON.parse(
    await readFile(new URL(`../${file}`, import.meta.url), "utf8"),
  );
}

describe("pinned Codex runtime", () => {
  it("keeps the Code Mode proto equal to its recorded upstream source", async () => {
    const provenance = await readJson("proto/PROVENANCE.json");
    expect(provenance, UPGRADE).toMatchObject({
      file: "codex.code_mode.v1.proto",
      repository: "https://github.com/openai/codex",
      tag: `rust-v${PINNED_CODEX_VERSION}`,
      commit: expect.stringMatching(/^[0-9a-f]{40}$/),
      path: expect.stringMatching(/\/codex\.code_mode\.v1\.proto$/),
    });
    const proto = await readFile(
      new URL(`../proto/${provenance.file}`, import.meta.url),
    );
    expect(createHash("sha256").update(proto).digest("hex"), UPGRADE).toBe(
      provenance.sha256,
    );
  });

  it("uses one Codex version in the runtime, package.json, and package-lock.json", async () => {
    const manifest = await readJson("package.json");
    const lock = await readJson("package-lock.json");
    expect(manifest.dependencies["@openai/codex"], UPGRADE).toBe(
      PINNED_CODEX_VERSION,
    );
    const codex = lock.packages["node_modules/@openai/codex"];
    expect(codex.version).toBe(PINNED_CODEX_VERSION);
    const platforms = Object.entries(
      codex.optionalDependencies as Record<string, string>,
    );
    expect(platforms.length).toBeGreaterThan(0);
    for (const [name, spec] of platforms) {
      const version = `${PINNED_CODEX_VERSION}-${name.replace("@openai/codex-", "")}`;
      expect(spec).toBe(`npm:@openai/codex@${version}`);
      expect(lock.packages[`node_modules/${name}`].version).toBe(version);
    }
  });

  it("finds both binaries in the installed platform package", () => {
    const { target } = codexTarget();
    const exe = process.platform === "win32" ? ".exe" : "";
    for (const name of BINARIES)
      expect(
        resolveCodexBinary(name).endsWith(
          path.join("vendor", target, "bin", `${name}${exe}`),
        ),
      ).toBe(true);
  });
});

describe("Codex platform package checks", () => {
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(
      directories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  /** Writes the published layout 1 package; changes replace single fields. */
  async function fakePackage(
    platform: string,
    arch: string,
    changes: {
      pkg?: Record<string, unknown>;
      layout?: Record<string, unknown>;
    } = {},
  ) {
    const { suffix, target } = codexTarget(platform, arch);
    const exe = platform === "win32" ? ".exe" : "";
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "exec-mcp-codex-package-"),
    );
    directories.push(directory);
    const vendor = path.join(directory, "vendor", target);
    await mkdir(path.join(vendor, "bin"), { recursive: true });
    await writeFile(
      path.join(directory, "package.json"),
      JSON.stringify({
        name: "@openai/codex",
        version: `${PINNED_CODEX_VERSION}-${suffix}`,
        ...changes.pkg,
      }),
    );
    await writeFile(
      path.join(vendor, "codex-package.json"),
      JSON.stringify({
        layoutVersion: 1,
        version: PINNED_CODEX_VERSION,
        target,
        variant: "codex",
        entrypoint: `bin/codex${exe}`,
        resourcesDir: "codex-resources",
        pathDir: "codex-path",
        ...changes.layout,
      }),
    );
    for (const name of BINARIES)
      await writeFile(path.join(vendor, "bin", `${name}${exe}`), "", {
        mode: 0o755,
      });
    return { directory, vendor, exe };
  }

  it.each([
    [process.platform, process.arch],
    ["win32", "x64"],
  ])("accepts the published layout for %s-%s", async (platform, arch) => {
    const { directory, vendor, exe } = await fakePackage(platform, arch);
    for (const name of BINARIES)
      expect(codexBinaryInPackage(directory, name, platform, arch)).toBe(
        path.join(vendor, "bin", `${name}${exe}`),
      );
  });

  const { suffix, target } = codexTarget();
  const exe = process.platform === "win32" ? ".exe" : "";
  it.each([
    {
      changes: { pkg: { version: `0.154.0-${suffix}` } },
      file: "package.json",
      field: "version",
      expected: `"${PINNED_CODEX_VERSION}-${suffix}"`,
      found: `"0.154.0-${suffix}"`,
      action: "Reinstall exec-mcp",
    },
    {
      changes: { layout: { layoutVersion: 2 } },
      file: "codex-package.json",
      field: "layoutVersion",
      expected: "1",
      found: "2",
      action: "cannot read this Codex package layout",
    },
    {
      changes: { layout: { layoutVersion: undefined } },
      file: "codex-package.json",
      field: "layoutVersion",
      expected: "1",
      found: "no value",
      action: "cannot read this Codex package layout",
    },
    {
      changes: { layout: { version: "0.154.0" } },
      file: "codex-package.json",
      field: "version",
      expected: `"${PINNED_CODEX_VERSION}"`,
      found: '"0.154.0"',
      action: "Reinstall exec-mcp",
    },
    {
      changes: { layout: { target: "other-target" } },
      file: "codex-package.json",
      field: "target",
      expected: `"${target}"`,
      found: '"other-target"',
      action: "Reinstall exec-mcp",
    },
    {
      changes: { layout: { entrypoint: `codex${exe}` } },
      file: "codex-package.json",
      field: "entrypoint",
      expected: `"bin/codex${exe}"`,
      found: `"codex${exe}"`,
      action: "cannot read this Codex package layout",
    },
  ])(
    "rejects $file with an unexpected $field ($found)",
    async ({ changes, file, field, expected, found, action }) => {
      const { directory } = await fakePackage(
        process.platform,
        process.arch,
        changes,
      );
      const run = () => codexBinaryInPackage(directory, "codex-code-mode-host");
      expect(run).toThrow(
        `${file} has the wrong "${field}" value. Expected ${expected}, found ${found}.`,
      );
      expect(run).toThrow(action);
    },
  );

  it("rejects a package without codex-package.json", async () => {
    const { directory, vendor } = await fakePackage(
      process.platform,
      process.arch,
    );
    await rm(path.join(vendor, "codex-package.json"));
    expect(() => codexBinaryInPackage(directory, "codex")).toThrow(
      `Cannot read the Codex package file ${path.join(vendor, "codex-package.json")}`,
    );
  });
});

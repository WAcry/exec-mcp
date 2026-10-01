import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ConfigEditor } from "../src/web/config-edit.js";

vi.mock("../src/config.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/config.js")>();
  // The same shape as the validation error class in config.ts.
  class ConfigError extends Error {}
  return {
    ...original,
    parseConfig(text: string, filename: string) {
      if (text.includes("validation-failure"))
        throw new ConfigError("- server.port: Expected a number.");
      if (text.includes("other-failure"))
        throw new Error("secret-value-from-the-file");
      return original.parseConfig(text, filename);
    },
  };
});

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

async function read(source: string) {
  dir = await mkdtemp(path.join(tmpdir(), "exec-config-errors-"));
  const filename = path.join(dir, "config.toml");
  await writeFile(filename, source);
  return new ConfigEditor(filename).read();
}

it("shows configuration validation messages and hides other read errors", async () => {
  await expect(read("# validation-failure\n")).rejects.toMatchObject({
    status: 422,
    code: "config_unreadable",
    message: "- server.port: Expected a number.",
  });
  const hidden = read("# other-failure\n");
  await expect(hidden).rejects.toMatchObject({ code: "config_unreadable" });
  await expect(hidden).rejects.not.toThrow("secret-value");
});

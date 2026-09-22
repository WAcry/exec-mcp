import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { VERSION } from "../src/version.js";

it("keeps runtime and package versions synchronized without changing dependency versions", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  const lock = JSON.parse(
    await readFile(new URL("../package-lock.json", import.meta.url), "utf8"),
  );
  expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  expect(manifest.version).toBe(VERSION);
  expect(lock.version).toBe(VERSION);
  expect(lock.packages[""].version).toBe(VERSION);
  expect(lock.packages[""].dependencies).toEqual(manifest.dependencies);
});

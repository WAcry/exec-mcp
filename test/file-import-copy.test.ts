import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const links = vi.hoisted(() => ({ code: "EPERM" as string | undefined }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    link: async (...args: Parameters<typeof actual.link>) => {
      if (links.code === undefined) return actual.link(...args);
      throw Object.assign(new Error("hard links are not available"), {
        code: links.code,
      });
    },
  };
});

const { importBoundFile } = await import("../src/files/transfer.js");

const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0))
    await rm(dir, { recursive: true, force: true });
});

function download(data: string) {
  return async () => {
    const value = Readable.from([Buffer.from(data)]) as IncomingMessage;
    value.headers = {};
    return value;
  };
}

async function run(destination: string, data: string) {
  return importBoundFile(
    { download_url: "https://files.example.test/a", file_id: "a" },
    destination,
    false,
    1024,
    download(data),
    new AbortController().signal,
  );
}

describe("import without overwrite where hard links are not available", () => {
  it.each(["EPERM", "ENOTSUP", "EXDEV"])(
    "copies the file with O_EXCL after %s",
    async (code) => {
      links.code = code;
      const dir = await mkdtemp(path.join(tmpdir(), "exec-mcp-copy-"));
      directories.push(dir);
      const target = path.join(dir, "input.txt");

      const result = await run(target, "new data");

      expect(result.path).toBe(target);
      expect(await readFile(target, "utf8")).toBe("new data");
      expect(await readdir(dir)).toEqual(["input.txt"]);
    },
  );

  it("still refuses an existing destination", async () => {
    links.code = "EPERM";
    const dir = await mkdtemp(path.join(tmpdir(), "exec-mcp-copy-"));
    directories.push(dir);
    const target = path.join(dir, "input.txt");
    await writeFile(target, "old data");

    await expect(run(target, "new data")).rejects.toThrow("already exists");
    expect(await readFile(target, "utf8")).toBe("old data");
    expect(await readdir(dir)).toEqual(["input.txt"]);
  });

  it("reports other link errors without copying", async () => {
    links.code = "EACCES";
    const dir = await mkdtemp(path.join(tmpdir(), "exec-mcp-copy-"));
    directories.push(dir);

    await expect(run(path.join(dir, "input.txt"), "data")).rejects.toThrow(
      "The file import failed",
    );
    expect(await readdir(dir)).toEqual([]);
  });
});

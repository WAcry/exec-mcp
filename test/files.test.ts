import { createHash } from "node:crypto";
import {
  mkdtemp,
  writeFile,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  truncate,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../src/files/artifacts.js";
import {
  FILE_CONFIG_SCHEMA,
  RESOURCE_FILE_BYTES,
  type HostFile,
  type FileConfig,
} from "../src/files/contracts.js";
import {
  downloadUrl,
  isPublicAddress,
  openDownload,
} from "../src/files/download.js";
import { parseRange } from "../src/files/gateway.js";

const stores: ArtifactStore[] = [];
const directories: string[] = [];
async function directory() {
  const dir = await mkdtemp(path.join(tmpdir(), "exec-mcp-files-test-"));
  directories.push(dir);
  return dir;
}
function store(
  config?: Partial<FileConfig>,
  options: ConstructorParameters<typeof ArtifactStore>[1] = {},
) {
  const value = new ArtifactStore(config, options);
  stores.push(value);
  return value;
}
function response(data: Buffer | string, length?: number): IncomingMessage {
  const value = Readable.from([Buffer.from(data)]) as IncomingMessage;
  value.headers =
    length === undefined ? {} : { "content-length": String(length) };
  value.statusCode = 200;
  return value;
}
const reference: HostFile = {
  download_url: "https://files.example.com/object?signature=PRIVATE_TEST_VALUE",
  file_id: "test-file",
};
const digest = (data: Buffer | string) =>
  createHash("sha256").update(data).digest("hex");
afterEach(async () => {
  await Promise.all(stores.splice(0).map((value) => value.close()));
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("streaming file import", () => {
  it("imports bytes with an explicit Unicode destination and does not expose host credentials", async () => {
    const dir = await directory();
    const bytes = Buffer.from([0, 255, 1, 2, 10]);
    let calls = 0;
    const files = store(undefined, {
      download: async (url) => {
        calls++;
        expect(url).toBe(reference.download_url);
        return response(bytes, bytes.length);
      },
    });
    expect(calls).toBe(0);
    const result = await files.importFile(
      { ...reference, size: bytes.length },
      "嵌套 目录/输入.bin",
      dir,
    );
    expect(await readFile(result.path)).toEqual(bytes);
    expect(result).toEqual({
      path: path.join(dir, "嵌套 目录/输入.bin"),
      size: bytes.length,
      sha256: digest(bytes),
    });
    expect(JSON.stringify(result)).not.toMatch(
      /PRIVATE_TEST_VALUE|download_url|file_id/,
    );
    expect(await readdir(path.dirname(result.path))).toEqual(["输入.bin"]);
  });
  it("refuses overwrite, then explicitly replaces the destination", async () => {
    const dir = await directory();
    await writeFile(path.join(dir, "input"), "old");
    const files = store(undefined, { download: async () => response("new") });
    await expect(files.importFile(reference, "input", dir)).rejects.toThrow(
      "不覆盖",
    );
    expect(await readFile(path.join(dir, "input"), "utf8")).toBe("old");
    await files.importFile(reference, "input", dir, true);
    expect(await readFile(path.join(dir, "input"), "utf8")).toBe("new");
    expect(await readdir(dir)).toEqual(["input"]);
  });
  it.each(["metadata", "response", "stream", "network"])(
    "cleans partials and preserves an old target on %s failure",
    async (mode) => {
      const dir = await directory();
      await writeFile(path.join(dir, "input"), "original");
      const files = store(
        { max_file_bytes: 4 },
        {
          download: async () => {
            if (mode === "network") throw new Error(reference.download_url);
            return response(
              mode === "stream" ? "12345" : "abc",
              mode === "response" ? 4 : undefined,
            );
          },
        },
      );
      const native = {
        ...reference,
        ...(mode === "metadata" ? { size: 4 } : {}),
      };
      let message = "";
      try {
        await files.importFile(native, "input", dir, true);
      } catch (error) {
        message = String(error);
      }
      expect(message).toContain("导入失败");
      expect(message).not.toContain("PRIVATE_TEST_VALUE");
      expect(await readFile(path.join(dir, "input"), "utf8")).toBe("original");
      expect(await readdir(dir)).toEqual(["input"]);
    },
  );
  it("cancels an incomplete stream without publishing a target", async () => {
    const dir = await directory();
    const abort = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>((r) => (started = r));
    const incoming = new Readable({
      read() {
        this.push("chunk");
        this._read = () => {};
        started();
      },
    }) as IncomingMessage;
    incoming.headers = {};
    const files = store(undefined, { download: async () => incoming });
    const operation = files.importFile(
      reference,
      "input",
      dir,
      false,
      abort.signal,
    );
    await ready;
    abort.abort();
    await expect(operation).rejects.toThrow("取消");
    expect(await readdir(dir)).toEqual([]);
  });
  it("does no download on pre-cancel or oversized host metadata", async () => {
    let calls = 0;
    const files = store(
      { max_file_bytes: 4 },
      {
        download: async () => {
          calls++;
          return response("x");
        },
      },
    );
    const dir = await directory();
    const abort = AbortSignal.abort();
    await expect(
      files.importFile(reference, "input", dir, false, abort),
    ).rejects.toThrow();
    await expect(
      files.importFile({ ...reference, size: 5 }, "input", dir),
    ).rejects.toThrow("大小限制");
    expect(calls).toBe(0);
  });
});

describe("private export snapshots", () => {
  it("keeps an immutable binary snapshot independently of the source and cell", async () => {
    const dir = await directory();
    const bytes = Buffer.from([255, 0, 1, 2, 3]);
    await writeFile(path.join(dir, "original.bin"), bytes);
    const files = store(undefined, { temporaryDirectory: dir });
    const result = await files.exportFile("original.bin", dir, "conversation");
    expect(result.content).toMatchObject({
      type: "resource_link",
      mimeType: "application/octet-stream",
      size: bytes.length,
    });
    expect(result.info.sha256).toBe(digest(bytes));
    expect(JSON.stringify(result)).not.toContain(dir);
    await writeFile(path.join(dir, "original.bin"), "changed source");
    for (let i = 0; i < 2; i++) {
      const read = await files.readResource(result.info.uri, "conversation");
      expect(Buffer.from(read.contents[0]!.blob, "base64")).toEqual(bytes);
    }
    const root = (await readdir(dir)).find((name) =>
      name.startsWith("exec-mcp-files-"),
    )!;
    if (process.platform !== "win32")
      expect((await stat(path.join(dir, root))).mode & 0o777).toBe(0o700);
    await files.close();
    expect(await readdir(dir)).toEqual(["original.bin"]);
  });
  it("uses the private MCP ingress when resource reads omit the optional conversation hint", async () => {
    const dir = await directory();
    await writeFile(path.join(dir, "file.txt"), "data");
    const files = store();
    const exported = await files.exportFile("file.txt", dir, "owner");
    await expect(
      files.readResource(exported.info.uri, "another"),
    ).rejects.toThrow("不属于");
    expect((await files.readResource(exported.info.uri)).contents).toHaveLength(
      1,
    );
    await expect(files.revoke(exported.info.id, "another")).rejects.toThrow(
      "不属于",
    );
    await expect(files.revoke(exported.info.id)).rejects.toThrow("不属于");
    await files.revoke(exported.info.id, "owner");
    await expect(
      files.readResource(exported.info.uri, "owner"),
    ).rejects.toThrow("失效");
  });
  it("expires exports and does not transfer handles between service instances", async () => {
    let now = 1000;
    const dir = await directory();
    await writeFile(path.join(dir, "file"), "data");
    const files = store({ ttl_seconds: 1 }, { now: () => now });
    const other = store();
    const exported = await files.exportFile("file", dir);
    await expect(other.readResource(exported.info.uri)).rejects.toThrow(
      "不存在",
    );
    now = 2001;
    await expect(files.readResource(exported.info.uri)).rejects.toThrow("失效");
  });
  it("reserves snapshot space under concurrent exports and reclaims it on revocation", async () => {
    const dir = await directory();
    await writeFile(path.join(dir, "file"), "data");
    const files = store({ max_export_bytes: 4100 });
    const results = await Promise.allSettled([
      files.exportFile("file", dir),
      files.exportFile("file", dir),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const item = results.find((r) => r.status === "fulfilled")!;
    if (item.status !== "fulfilled") throw new Error("missing export");
    await files.revoke(item.value.info.id);
    expect((await files.exportFile("file", dir)).info.size).toBe(4);
  });
  it("rejects directories, unsafe names and unconfigured public delivery", async () => {
    const dir = await directory();
    await writeFile(path.join(dir, "file"), "data");
    const files = store();
    await expect(files.exportFile(dir, dir)).rejects.toThrow("普通文件");
    await expect(
      files.exportFile("file", dir, undefined, "resource", "../bad"),
    ).rejects.toThrow("文件名");
    await expect(
      files.exportFile("file", dir, undefined, "resource", "bad\r\nHeader"),
    ).rejects.toThrow("文件名");
    await expect(
      files.exportFile("missing", dir, undefined, "url"),
    ).rejects.toThrow("未配置");
  });
  it.skipIf(process.platform === "win32")(
    "refuses source symlinks",
    async () => {
      const dir = await directory();
      await writeFile(path.join(dir, "real"), "data");
      await symlink(path.join(dir, "real"), path.join(dir, "link"));
      await expect(store().exportFile("link", dir)).rejects.toThrow();
    },
  );
  it("supports empty files and refuses large MCP blobs before copying", async () => {
    const dir = await directory();
    await writeFile(path.join(dir, "empty"), "");
    const files = store();
    const empty = await files.exportFile("empty", dir);
    expect((await files.readResource(empty.info.uri)).contents[0]!.blob).toBe(
      "",
    );
    await truncate(path.join(dir, "empty"), RESOURCE_FILE_BYTES + 1);
    await expect(files.exportFile("empty", dir)).rejects.toThrow("32 MiB");
  });
});

describe("file ingress and download request validation", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "100.64.0.1",
    "192.168.1.1",
    "198.18.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
    "2002:7f00:1::",
    "2001:db8::1",
    "3fff::1",
  ])("blocks non-public address %s", (ip) =>
    expect(isPublicAddress(ip)).toBe(false),
  );
  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])(
    "accepts public address %s",
    (ip) => expect(isPublicAddress(ip)).toBe(true),
  );
  it.each([
    "http://example.com/a",
    "https://user:password@example.com/a",
    "https://example.com:8443/a",
    "file:///tmp/a",
    "https://example.com/a#fragment",
  ])("rejects invalid download URL shape", (value) =>
    expect(() => downloadUrl(value)).toThrow(),
  );
  it("rejects local addresses without establishing a download connection", async () => {
    await expect(
      openDownload("https://127.0.0.1/x", new AbortController().signal),
    ).rejects.toThrow("私网");
    await expect(
      openDownload("https://[::1]/x", new AbortController().signal),
    ).rejects.toThrow("私网");
  });
  it("requires an explicit HTTPS download base without inline credentials", () => {
    for (const base_url of [
      "http://example.com/files",
      "https://user:password@example.com/files",
      "https://example.com/files?token=x",
    ])
      expect(
        FILE_CONFIG_SCHEMA.safeParse({ download: { base_url } }).success,
      ).toBe(false);
    expect(
      FILE_CONFIG_SCHEMA.parse({
        download: { base_url: "https://example.com/files" },
      }).download!.port,
    ).toBe(8892);
  });
  it("parses bounded single ranges without accepting ambiguous ranges", () => {
    expect(parseRange("bytes=2-4", 10)).toEqual({ start: 2, end: 4 });
    expect(parseRange("bytes=-3", 10)).toEqual({ start: 7, end: 9 });
    expect(parseRange("bytes=3-", 10)).toEqual({ start: 3, end: 9 });
    expect(parseRange("bytes=0-100", 10)).toEqual({ start: 0, end: 9 });
    for (const value of [
      "bytes=",
      "bytes=3-2",
      "bytes=10-",
      "bytes=-0",
      "bytes=0-1,3-5",
      "bytes=99999999999999999999-",
    ])
      expect(parseRange(value, 10)).toBeNull();
  });
});

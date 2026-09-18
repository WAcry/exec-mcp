import { createServer, get, type IncomingMessage } from "node:http";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type ResourceLink,
} from "@modelcontextprotocol/client";
import { ArtifactStore } from "../src/files/artifacts.js";
import { FILE_CONFIG_SCHEMA } from "../src/files/contracts.js";
import { startServer } from "../src/server.js";
import { cellId, jsonOutput, texts } from "./helpers.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function setup(legacy = false, urls = false) {
  const dir = await mkdtemp(path.join(tmpdir(), "exec-mcp-file-bridge-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const bytes = Buffer.from("用户文件\nalpha,beta\n1,2\n");
  let downloads = 0;
  const origin = createServer((_request, response) => {
    downloads++;
    response.writeHead(200, { "Content-Length": bytes.length });
    response.end(bytes);
  });
  await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        origin.close(() => resolve());
        origin.closeAllConnections();
      }),
  );
  const config = FILE_CONFIG_SCHEMA.parse(
    urls
      ? {
          download: {
            base_url: "https://downloads.example.test/reports",
            port: 0,
          },
        }
      : {},
  );
  const artifacts = new ArtifactStore(config, {
    download: async (_url, signal) =>
      new Promise<IncomingMessage>((resolve, reject) => {
        get(
          `http://127.0.0.1:${(origin.address() as AddressInfo).port}/input`,
          { signal },
          resolve,
        ).on("error", reject);
      }),
  });
  const server = await startServer(
    {
      host: "127.0.0.1",
      port: 0,
      access: "openai-tunnel",
      mcpServers: [],
      files: config,
    },
    { artifacts },
  );
  cleanups.push(() => server.close());
  const client = new Client(
    { name: "file-bridge-test", version: "1" },
    { versionNegotiation: { mode: legacy ? "legacy" : "auto" } },
  );
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
  cleanups.push(() => client.close());
  const file = {
    download_url: "https://files.example.test/input?signature=PRIVATE_BINDING",
    file_id: "native-test-file",
    file_name: "input.csv",
    size: bytes.length,
  };
  const exec = (
    source: string,
    extra: Record<string, unknown> = {},
    scope = "conversation",
  ) =>
    client.callTool({
      name: "exec",
      arguments: { source, workdir: dir, ...extra },
      _meta: { "openai/session": scope },
    });
  const read = async (uri: string, scope = "conversation") =>
    client.readResource({ uri, _meta: { "openai/session": scope } });
  return {
    dir,
    bytes,
    file,
    client,
    server,
    exec,
    read,
    downloads: () => downloads,
  };
}
const links = (result: CallToolResult): ResourceLink[] =>
  result.content.filter(
    (item): item is ResourceLink => item.type === "resource_link",
  );

describe.each([false, true])(
  "file bridge over actual MCP (legacy=%s)",
  (legacy) => {
    it("declares native top-level file binding and imports/exports without binary text or duplicate JSON", async () => {
      const t = await setup(legacy);
      const tools = (await t.client.listTools()).tools;
      expect(tools.map((tool) => tool.name)).toEqual(["exec", "wait"]);
      expect(tools[0]!._meta).toMatchObject({ "openai/fileParams": ["files"] });
      expect(tools[0]!.inputSchema).toMatchObject({
        properties: {
          files: {
            type: "array",
            items: {
              required: ["download_url", "file_id"],
              properties: {
                download_url: { type: "string" },
                file_id: { type: "string" },
                mime_type: { type: "string" },
                file_name: { type: "string" },
              },
            },
          },
        },
      });
      const result = await t.exec(
        'await tools.import_file({index:0,destination:"输入.csv"}); await tools.export_file({path:"输入.csv",name:"结果.csv"});',
        {
          files: [t.file, { download_url: "unused", file_id: "unused" }],
          max_output_tokens: 0,
        },
      );
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(t.downloads()).toBe(1);
      expect(await readFile(path.join(t.dir, "输入.csv"))).toEqual(t.bytes);
      expect(result.structuredContent).toBeUndefined();
      expect(JSON.stringify(result)).not.toMatch(
        /PRIVATE_BINDING|download_url|"blob"/,
      );
      expect(links(result)).toHaveLength(1);
      const link = links(result)[0]!;
      expect(link).toMatchObject({
        name: "结果.csv",
        mimeType: "text/csv",
        size: t.bytes.length,
      });
      const contents = (await t.read(link.uri)).contents;
      expect(
        Buffer.from((contents[0] as { blob: string }).blob, "base64"),
      ).toEqual(t.bytes);
      expect((await t.client.listResources()).resources).toEqual([]);
    });
    it("does not import unused files or expose binding credentials to JavaScript", async () => {
      const t = await setup(legacy);
      const result = await t.exec(
        'text({files:typeof files,leaked:JSON.stringify(ALL_TOOLS).includes("PRIVATE_BINDING")});',
        { files: [t.file] },
      );
      expect(jsonOutput(result)).toEqual({ files: "undefined", leaked: false });
      expect(t.downloads()).toBe(0);
      const missing = await t.exec(
        'await tools.import_file({index:0,destination:"never"});',
      );
      expect(missing.isError).toBe(true);
      expect(t.downloads()).toBe(0);
    });
    it("delivers export links across yields exactly once and beyond the completed cell lifetime", async () => {
      const t = await setup(legacy);
      await writeFile(path.join(t.dir, "one"), "first");
      await writeFile(path.join(t.dir, "two"), "second");
      const first = await t.exec(
        'await tools.export_file({path:"one"}); yield_control(); await new Promise(r=>setTimeout(r,150)); await tools.export_file({path:"two"});',
        { max_output_tokens: 0 },
      );
      const id = cellId(first);
      const final = await t.client.callTool({
        name: "wait",
        arguments: { cell_id: id, max_tokens: 0 },
        _meta: { "openai/session": "conversation" },
      });
      expect(final.isError).not.toBe(true);
      const all = [...links(first), ...links(final)];
      expect(all.map((item) => item.name).sort()).toEqual(["one", "two"]);
      for (const link of all)
        expect((await t.read(link.uri)).contents).toHaveLength(1);
      const ended = await t.client.callTool({
        name: "wait",
        arguments: { cell_id: id, yield_time_ms: 0 },
        _meta: { "openai/session": "conversation" },
      });
      expect(ended.isError).toBe(true);
      expect(links(ended)).toEqual([]);
    });
    it("keeps native links on script errors but removes explicitly revoked pending links", async () => {
      const t = await setup(legacy);
      await writeFile(path.join(t.dir, "file"), "data");
      const failed = await t.exec(
        'await tools.export_file({path:"file"});throw new Error("after export");',
        { max_output_tokens: 0 },
      );
      expect(failed.isError).toBe(true);
      expect(links(failed)).toHaveLength(1);
      expect((await t.read(links(failed)[0]!.uri)).contents).toHaveLength(1);
      const revoked = await t.exec(
        'const file=await tools.export_file({path:"file"});await tools.revoke_file({id:file.id});',
      );
      expect(revoked.isError).not.toBe(true);
      expect(links(revoked)).toEqual([]);
    });
    it("retains input bindings through waits without reattaching or downloading other files", async () => {
      const t = await setup(legacy);
      const first = await t.exec(
        'yield_control(); await new Promise(r=>setTimeout(r,120)); const saved=await tools.import_file({index:0,destination:"late.csv"});text(saved.size);await tools.export_file({path:"late.csv"});',
        { files: [t.file] },
      );
      const final = await t.client.callTool({
        name: "wait",
        arguments: { cell_id: cellId(first) },
        _meta: { "openai/session": "conversation" },
      });
      expect(final.isError, JSON.stringify(final)).not.toBe(true);
      expect(t.downloads()).toBe(1);
      expect(links(final)).toHaveLength(1);
      expect(await readFile(path.join(t.dir, "late.csv"))).toEqual(t.bytes);
    });
  },
);

describe("isolated downloadable files endpoint", () => {
  it("serves private snapshots with safe headers, HEAD, ranges and revocation, never the MCP endpoint", async () => {
    const t = await setup(false, true);
    await writeFile(
      path.join(t.dir, "report.html"),
      "<script>example</script>",
    );
    const exported = await t.exec(
      'text(await tools.export_file({path:"report.html",name:"报告.html",delivery:"url"}));',
    );
    const info = jsonOutput<{ id: string; uri: string }>(exported);
    expect(info.uri.startsWith("https://downloads.example.test/reports/")).toBe(
      true,
    );
    expect(links(exported)[0]!.uri).toBe(info.uri);
    const url = t.server.downloadAddress! + new URL(info.uri).pathname;
    const head = await fetch(url, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(head.headers.get("content-disposition")).toContain("attachment;");
    expect(head.headers.get("x-content-type-options")).toBe("nosniff");
    expect(head.headers.get("content-security-policy")).toContain("sandbox");
    expect(head.headers.get("cache-control")).toContain("no-store");
    const full = await fetch(url);
    expect(await full.text()).toBe("<script>example</script>");
    const ranged = await fetch(url, { headers: { Range: "bytes=0-7" } });
    expect(ranged.status).toBe(206);
    expect(await ranged.text()).toBe("<script>");
    expect(
      (await fetch(url, { headers: { Range: "bytes=999-" } })).status,
    ).toBe(416);
    expect((await fetch(url, { method: "POST" })).status).toBe(405);
    expect((await fetch(t.server.downloadAddress! + "/mcp")).status).toBe(404);
    expect(
      (
        await fetch(
          t.server.downloadAddress! + "/reports/" + info.id + "/report.html",
        )
      ).status,
    ).toBe(404);
    await t.exec(`await tools.revoke_file({id:${JSON.stringify(info.id)}});`);
    expect((await fetch(url)).status).toBe(404);
  });
  it("never silently publishes a file when URL delivery has not been enabled", async () => {
    const t = await setup();
    await writeFile(path.join(t.dir, "file"), "data");
    const result = await t.exec(
      'await tools.export_file({path:"file",delivery:"url"});',
    );
    expect(result.isError).toBe(true);
    expect(texts(result).join("\n")).toContain("未配置");
    expect(links(result)).toEqual([]);
    expect(t.server.downloadAddress).toBeUndefined();
  });
  it("keeps attachments separated between concurrent exec cells", async () => {
    const t = await setup();
    await writeFile(path.join(t.dir, "one"), "first");
    await writeFile(path.join(t.dir, "two"), "second");
    const [one, two] = await Promise.all([
      t.exec('await tools.export_file({path:"one"});'),
      t.exec('await tools.export_file({path:"two"});'),
    ]);
    expect(links(one).map((link) => link.name)).toEqual(["one"]);
    expect(links(two).map((link) => link.name)).toEqual(["two"]);
  });
  it("round-trips a multi-megabyte resource through the SDK without putting bytes in tools/call", async () => {
    const t = await setup();
    const bytes = Buffer.alloc(4 * 1024 * 1024, 0xa5);
    await writeFile(path.join(t.dir, "large.bin"), bytes);
    const exported = await t.exec(
      'await tools.export_file({path:"large.bin"});',
    );
    expect(JSON.stringify(exported).length).toBeLessThan(4096);
    const read = await t.read(links(exported)[0]!.uri);
    const returned = Buffer.from(
      (read.contents[0] as { blob: string }).blob,
      "base64",
    );
    // Vitest's generic deep equality enumerates millions of Buffer properties;
    // use exact native byte equality, not a slower or weaker content assertion.
    expect(returned.equals(bytes)).toBe(true);
  });
  it("streams a file larger than the resource limit over the separate URL gateway", async () => {
    const t = await setup(false, true);
    const bytes = Buffer.alloc(33 * 1024 * 1024, 0x5a);
    await writeFile(path.join(t.dir, "large.bin"), bytes);
    const exported = await t.exec(
      'await tools.export_file({path:"large.bin",delivery:"url"});',
      { max_output_tokens: 0 },
    );
    expect(exported.isError).not.toBe(true);
    expect(JSON.stringify(exported).length).toBeLessThan(4096);
    const publicUrl = new URL(links(exported)[0]!.uri);
    const download = await fetch(
      t.server.downloadAddress! + publicUrl.pathname,
    );
    expect(download.status).toBe(200);
    const hash = createHash("sha256");
    let size = 0;
    const reader = download.body!.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value);
        size += value.length;
      }
    } finally {
      reader.releaseLock();
    }
    expect(size).toBe(bytes.length);
    expect(hash.digest("hex")).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
  });
  it("refuses an occupied download port without touching its owner", async () => {
    const owner = createServer((_request, response) =>
      response.end("still alive"),
    );
    await new Promise<void>((resolve) => owner.listen(0, "127.0.0.1", resolve));
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          owner.close(() => resolve());
          owner.closeAllConnections();
        }),
    );
    const port = (owner.address() as AddressInfo).port;
    await expect(
      startServer({
        host: "127.0.0.1",
        port: 0,
        access: "openai-tunnel",
        mcpServers: [],
        files: FILE_CONFIG_SCHEMA.parse({
          download: { base_url: "https://files.example.test/files", port },
        }),
      }),
    ).rejects.toThrow();
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe(
      "still alive",
    );
  });
});

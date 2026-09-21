import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DownstreamMcpRegistry } from "../src/downstream/registry.js";
import {
  RESOURCE_LIST_SCHEMA,
  RESOURCE_READ_SCHEMA,
  resourceResultBytes,
} from "../src/downstream/resources.js";
import { MAX_PAYLOAD_BYTES } from "../src/limits.js";
import { describeContract, nativeContracts } from "../src/catalog.js";
import { sessionScopeKey } from "../src/code-mode/service.js";
import { startWebServer } from "../src/web/server.js";
import { ActivityStore } from "../src/web/activity.js";
import { cellId, connect, jsonOutput, texts } from "./helpers.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});
const nextCursor = "  opaque/下一页+==  ";
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=";
type Rpc = {
  method: string;
  id?: number | string;
  params?: Record<string, unknown>;
};

async function fixture(name = "docs", resources = true) {
  const requests: Rpc[] = [];
  const state = {
    generation: 1,
    initialized: 0,
    authenticated: false,
    read: async (uri: string): Promise<Record<string, unknown>> => ({
      _meta: { private: "PRIVATE_RESULT_META" },
      contents: [
        {
          uri,
          mimeType: "text/plain",
          text: `${name} 原文\n\t${uri} \\n`,
          _meta: { public: "retain" },
        },
        { uri: "asset://pixel", mimeType: "image/png", blob: png },
      ],
    }),
    list: async (
      method: string,
      cursor: unknown,
    ): Promise<Record<string, unknown>> => {
      const page = cursor === nextCursor ? 2 : 1;
      const key =
        method === "resources/list" ? "resources" : "resourceTemplates";
      return {
        [key]: [
          {
            name: `${name}-${page}`,
            ...(key === "resources"
              ? { uri: `memo://shared/${page}` }
              : { uriTemplate: `memo://item/${page}/{id}{?language}` }),
            description: "上下文",
            mimeType: "text/plain",
            title: "完整标题",
            annotations: { audience: ["assistant"], priority: 0.6 },
            _meta: { marker: "public" },
          },
        ],
        ...(page === 1 ? { nextCursor } : {}),
      };
    },
    delayMs: 0,
  };
  const http = createServer((req, res) => {
    void (async () => {
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      let source = "";
      for await (const data of req) source += data.toString();
      const message = JSON.parse(source) as Rpc;
      requests.push(message);
      res.setHeader("Content-Type", "application/json");
      const reply = (value: Record<string, unknown>) =>
        res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, ...value }));
      if (message.method === "server/discover") {
        reply({ error: { code: -32601, message: "legacy fixture" } });
        return;
      }
      if (message.method === "initialize") {
        state.initialized++;
        state.authenticated =
          req.headers.authorization === "Bearer test-resource-credential";
        res.setHeader("mcp-session-id", String(state.generation));
        reply({
          result: {
            protocolVersion: "2025-11-25",
            serverInfo: { name, version: "1" },
            capabilities: resources ? { resources: {} } : {},
          },
        });
        return;
      }
      if (message.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      if (req.headers["mcp-session-id"] !== String(state.generation)) {
        res.writeHead(404).end();
        return;
      }
      if (state.delayMs)
        await new Promise((resolve) => setTimeout(resolve, state.delayMs));
      try {
        const result =
          message.method === "resources/read"
            ? await state.read(message.params?.uri as string)
            : await state.list(message.method, message.params?.cursor);
        reply({ result });
      } catch {
        reply({
          error: {
            code: -32002,
            message: "PRIVATE_PROVIDER_KEY must not appear in model errors",
          },
        });
      }
    })().catch(() => res.destroy());
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        http.close(() => resolve());
        http.closeAllConnections();
      }),
  );
  const config = {
    name,
    transport: "streamable-http" as const,
    url: `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`,
    headers: { Authorization: "Bearer test-resource-credential" },
  };
  return {
    config,
    state,
    requests,
    resourceRequests: () =>
      requests.filter((r) => r.method.startsWith("resources/")),
  };
}

async function registry(...sources: Awaited<ReturnType<typeof fixture>>[]) {
  const r = new DownstreamMcpRegistry({
    servers: sources.map((s) => s.config),
  });
  cleanup.push(() => r.close());
  await r.initialize();
  return r;
}

describe("MCP resource protocol bridge", () => {
  it("uses the startup connection and auth without eager resource reads; single server means exactly one page", async () => {
    const f = await fixture();
    const r = await registry(f);
    expect(f.resourceRequests()).toEqual([]);
    expect(f.state.authenticated).toBe(true);
    const first = await r.listResources({ server: "docs" });
    expect(first).toEqual({
      server: "docs",
      ...(await f.state.list("resources/list", undefined)),
      resources: [
        {
          ...(
            (await f.state.list("resources/list", undefined))
              .resources as object[]
          )[0],
          server: "docs",
        },
      ],
    });
    expect(f.resourceRequests()).toHaveLength(1);
    const second = await r.listResources({
      server: "docs",
      cursor: first.nextCursor!,
    });
    expect(second.resources).toHaveLength(1);
    expect(second.resources[0]!.uri).toBe("memo://shared/2");
    expect(second.nextCursor).toBeUndefined();
    expect(f.resourceRequests()[1]!.params?.cursor).toBe(nextCursor);
    expect(f.state.initialized).toBe(1);
    expect(f.requests.some((r) => r.method === "tools/list")).toBe(false);
  });

  it("aggregates all pages by exact server identity and keeps template metadata", async () => {
    const z = await fixture("z-docs"),
      a = await fixture("a docs");
    const r = await registry(z, a);
    const result = await r.listResources({});
    expect(result.errors).toEqual({});
    expect(result.resources.map((row) => [row.server, row.uri])).toEqual([
      ["a docs", "memo://shared/1"],
      ["a docs", "memo://shared/2"],
      ["z-docs", "memo://shared/1"],
      ["z-docs", "memo://shared/2"],
    ]);
    const templates = await r.listResourceTemplates({ server: "a docs" });
    expect(templates.nextCursor).toBe(nextCursor);
    expect(templates.resourceTemplates[0]).toMatchObject({
      server: "a docs",
      uriTemplate: "memo://item/1/{id}{?language}",
      annotations: { priority: 0.6 },
      _meta: { marker: "public" },
    });
    const all = await r.listResourceTemplates({});
    expect(all.resourceTemplates).toHaveLength(4);
    expect(all.nextCursor).toBeUndefined();
  });

  it("handles no resources capability without sending RPCs; unknown or disabled servers never fall back", async () => {
    const f = await fixture("tool-only", false);
    const r = await registry(f);
    expect(await r.listResources({})).toEqual({ resources: [], errors: {} });
    expect(await r.listResourceTemplates({ server: "tool-only" })).toEqual({
      server: "tool-only",
      resourceTemplates: [],
    });
    await expect(
      r.readResource({ server: "tool-only", uri: "file:///etc/passwd" }),
    ).rejects.toThrow("未声明 resources");
    await expect(r.listResources({ server: "disabled" })).rejects.toThrow(
      "未启用",
    );
    await expect(
      r.readResource({ server: "TOOL-ONLY", uri: "https://example.test" }),
    ).rejects.toThrow("未启用");
    expect(f.resourceRequests()).toEqual([]);
    expect(f.state.initialized).toBe(1);
    await r.listResources({ server: "tool-only" });
    expect(f.state.initialized).toBe(1);
  });

  it("passes known linked/template URIs verbatim without listing, caching or decoding content", async () => {
    const f = await fixture();
    const r = await registry(f);
    const uri = "memo://item/1/part%2Fa?language=zh&literal=%2520";
    const result = await r.readResource({ server: "docs", uri });
    expect(result).toEqual({
      server: "docs",
      uri,
      contents: (await f.state.read(uri)).contents,
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_RESULT_META");
    expect(f.resourceRequests().map((r) => r.method)).toEqual([
      "resources/read",
    ]);
    f.state.read = async (uri) => ({
      ttlMs: 100000,
      cacheScope: "private",
      contents: [{ uri, text: "updated" }],
    });
    expect(
      (await r.readResource({ server: "docs", uri })).contents[0],
    ).toMatchObject({ text: "updated" });
    f.state.read = async (uri) => ({
      contents: [{ uri, text: "updated again" }],
    });
    expect(
      (await r.readResource({ server: "docs", uri })).contents[0],
    ).toMatchObject({ text: "updated again" });
    expect(f.resourceRequests().map((r) => r.params?.uri)).toEqual([
      uri,
      uri,
      uri,
    ]);
  });

  it("reports per-server failures without presenting a partial page walk as a complete catalog", async () => {
    const good = await fixture("good"),
      broken = await fixture("broken");
    const r = await registry(good, broken);
    const original = broken.state.list;
    broken.state.list = async (method, cursor) => {
      if (cursor !== undefined) throw new Error("provider failure");
      return original(method, cursor);
    };
    const result = await r.listResources({});
    expect(result.resources).toHaveLength(2);
    expect(result.resources.every((row) => row.server === "good")).toBe(true);
    expect(result.errors).toEqual({
      broken: expect.stringContaining("协议错误 -32002"),
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_PROVIDER_KEY");
    await expect(
      r.listResources({ server: "broken", cursor: nextCursor }),
    ).rejects.toThrow("协议错误 -32002");
    expect(broken.state.initialized).toBe(1);
  });

  it("reads a templates-only server and does not confuse unrelated extension fields with the requested list", async () => {
    const f = await fixture();
    const r = await registry(f);
    f.state.list = async (method) =>
      method === "resources/list"
        ? { resources: [] }
        : {
            resourceTemplates: [
              { name: "Dynamic", uriTemplate: "memo://{id}" },
            ],
            resources: "unrelated extension",
          };
    expect((await r.listResources({})).resources).toEqual([]);
    const templates = await r.listResourceTemplates({ server: "docs" });
    expect(templates.resourceTemplates).toEqual([
      { server: "docs", name: "Dynamic", uriTemplate: "memo://{id}" },
    ]);
    expect(
      (await r.readResource({ server: "docs", uri: "memo://42" })).contents[0],
    ).toMatchObject({ uri: "memo://42" });
  });

  it("detects repeated and unbounded pagination and preserves even an empty opaque cursor", async () => {
    const f = await fixture();
    const r = await registry(f);
    f.state.list = async () => ({ resources: [], nextCursor: "" });
    const single = await r.listResources({ server: "docs" });
    expect(single.nextCursor).toBe("");
    await r.listResources({ server: "docs", cursor: "" });
    expect(f.resourceRequests().at(-1)!.params?.cursor).toBe("");
    expect((await r.listResources({})).errors?.docs).toContain("游标重复");
    f.state.list = async (_method, cursor) => ({
      resources: [],
      nextCursor: String(Number(cursor ?? 0) + 1),
    });
    const before = f.resourceRequests().length;
    expect((await r.listResources({})).errors?.docs).toContain("100 页");
    expect(f.resourceRequests().length - before).toBe(100);
    expect(f.state.initialized).toBe(1);
  });

  it("uses one timeout across all pages and does not retry failed requests", async () => {
    const f = await fixture();
    const r = new DownstreamMcpRegistry({
      servers: [{ ...f.config, toolTimeoutMs: 300 }],
    });
    cleanup.push(() => r.close());
    await r.initialize();
    f.state.delayMs = 200;
    const result = await r.listResources({});
    expect(result.resources).toEqual([]);
    expect(result.errors?.docs).toContain("超时");
    expect(f.resourceRequests()).toHaveLength(2);
  });

  it("can reconnect on the next resource request without searching tools or replaying the failed read", async () => {
    const f = await fixture();
    const r = await registry(f);
    await r.readResource({ server: "docs", uri: "memo://one" });
    f.state.generation++;
    await expect(
      r.readResource({ server: "docs", uri: "memo://one" }),
    ).rejects.toThrow("失败");
    expect(f.resourceRequests()).toHaveLength(2);
    const restored = await r.readResource({
      server: "docs",
      uri: "memo://one",
    });
    expect(restored.contents).toHaveLength(2);
    expect(f.state.initialized).toBe(2);
    expect(f.resourceRequests()).toHaveLength(3);
  });

  it("cancels in-flight resources on caller cancellation and on registry shutdown", async () => {
    const f = await fixture();
    const r = await registry(f);
    f.state.delayMs = 500;
    const abort = new AbortController();
    const pending = r.readResource(
      { server: "docs", uri: "memo://slow" },
      abort.signal,
    );
    const rejected = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.waitFor(() => expect(f.resourceRequests()).toHaveLength(1));
    abort.abort();
    await rejected;
    const closing = r.readResource({ server: "docs", uri: "memo://slow" });
    const closed = expect(closing).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.waitFor(() => expect(f.resourceRequests()).toHaveLength(2));
    await r.close();
    await closed;
    expect(f.resourceRequests()).toHaveLength(2);
  });

  it("bounds resource payloads without truncating text or Base64", () => {
    expect(resourceResultBytes({ contents: [{ text: "中文\\n" }] })).toBe(
      Buffer.byteLength(JSON.stringify({ contents: [{ text: "中文\\n" }] })),
    );
    expect(() =>
      resourceResultBytes({
        contents: [{ blob: "x".repeat(MAX_PAYLOAD_BYTES) }],
      }),
    ).toThrow("48 MiB");
  });

  it("rejects misplaced cursors and unknown fields but leaves opaque identifiers unchanged", () => {
    expect(RESOURCE_LIST_SCHEMA.safeParse({ cursor: "abc" }).success).toBe(
      false,
    );
    expect(
      RESOURCE_LIST_SCHEMA.parse({ server: "a docs", cursor: nextCursor }),
    ).toEqual({ server: "a docs", cursor: nextCursor });
    expect(
      RESOURCE_READ_SCHEMA.safeParse({
        server: "docs",
        uri: "memo://one",
        path: "/tmp",
      }).success,
    ).toBe(false);
    for (const field of ["server", "uri"])
      expect(
        RESOURCE_READ_SCHEMA.safeParse({
          server: "docs",
          uri: "memo://one",
          [field]: "",
        }).success,
      ).toBe(false);
  });
});

describe.each([false, true])(
  "resources through real Code Mode MCP (legacy=%s)",
  (legacy) => {
    it("advertises all three contracts inside exec, reads template contents and preserves media and Web audit", async () => {
      const f = await fixture();
      const t = await connect(
        {
          mcpServers: [f.config],
          web: { enabled: true, host: "127.0.0.1", port: 0 },
        },
        legacy,
        { activity: new ActivityStore() },
      );
      cleanup.push(() => t.close());
      const web = await startWebServer(
        t.runtime,
        {
          host: "127.0.0.1",
          port: 0,
          access: "openai-tunnel",
          mcpServers: [f.config],
        },
        { port: 0 },
      );
      cleanup.push(() => web.close());
      const listed = (await t.client.listTools()).tools;
      expect(listed.map((t) => t.name)).toEqual(["exec", "wait"]);
      for (const contract of nativeContracts(t.runtime.terminal.shell).filter(
        (c) => c.name.includes("mcp_resource"),
      ))
        expect(listed[0]!.description).toContain(describeContract(contract));
      const scope = "resource-conversation";
      const exec = (source: string, conversation = scope) =>
        t.client.callTool({
          name: "exec",
          arguments: { source },
          _meta: { "openai/session": conversation },
        });
      const result = await exec(`
      const [resources, templates] = await Promise.all([tools.list_mcp_resources({}), tools.list_mcp_resource_templates({server:'docs'})]);
      const template = templates.resourceTemplates[0];
      const r = await tools.read_mcp_resource({server:template.server,uri:'memo://item/1/42?language=zh'});
      const binary = r.contents.find(c=>c.blob);
      image('data:'+binary.mimeType+';base64,'+binary.blob);
      text({resources,templates,contents:r.contents,contracts:ALL_TOOLS.filter(t=>t.name.includes('mcp_resource'))});
    `);
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      const value = jsonOutput<{
        resources: { resources: unknown[] };
        contracts: { name: string }[];
      }>(result);
      expect(value.resources.resources).toHaveLength(2);
      expect(value.contracts.map((t) => t.name)).toEqual([
        "list_mcp_resources",
        "list_mcp_resource_templates",
        "read_mcp_resource",
      ]);
      expect(result.content.find((c) => c.type === "image")).toMatchObject({
        data: png,
      });
      const audit = t.runtime.activity.getCalls().items[0]!;
      expect(
        audit.subcalls.find((c) => c.name === "read_mcp_resource")?.input,
      ).toEqual({ server: "docs", uri: "memo://item/1/42?language=zh" });
      const response = await fetch(
        new URL("api/calls/" + audit.id, web.loopbackUrl),
      );
      expect((await response.json()).subcalls).toHaveLength(3);
      const note = await fetch(
        new URL(
          `api/sessions/${sessionScopeKey(scope)}/notes`,
          web.loopbackUrl,
        ),
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-exec-web": "1" },
          body: JSON.stringify({
            id: "resource-note",
            text: "资源读取时的用户补充",
          }),
        },
      );
      expect(note.status).toBe(200);
      const other = await exec(
        "text(await tools.list_mcp_resources({}));",
        "other-resource-conversation",
      );
      expect(texts(other).join("")).not.toContain("资源读取时的用户补充");
      const same = await exec("text(await tools.list_mcp_resources({}));");
      expect(texts(same).join("")).toContain(
        "用户额外补充：\n资源读取时的用户补充",
      );
    });

    it("keeps a large resource available to JS/store before the final output budget and returns via wait", async () => {
      const f = await fixture();
      const t = await connect({ mcpServers: [f.config] }, legacy);
      cleanup.push(() => t.close());
      f.state.read = async (uri) => ({
        contents: [{ uri, text: "BEGIN " + "x".repeat(80_000) + " END" }],
      });
      const req = (source: string, extra: Record<string, unknown> = {}) =>
        t.client.callTool({
          name: "exec",
          arguments: { source, ...extra },
          _meta: { "openai/session": "large-resource" },
        });
      const first = await req(
        "const r=await tools.read_mcp_resource({server:'docs',uri:'memo://large'});store('resource',r);text({size:r.contents[0].text.length,tail:r.contents[0].text.slice(-4)});",
      );
      expect(jsonOutput(first)).toEqual({ size: 80010, tail: " END" });
      const restored = await req(
        "text(load('resource').contents[0].text.slice(0,5));",
      );
      expect(texts(restored)).toContain("BEGIN");
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      f.state.read = async (uri) => {
        await gate;
        return { contents: [{ uri, text: "AFTER_WAIT" }] };
      };
      try {
        const pending = await req(
          "text(await tools.read_mcp_resource({server:'docs',uri:'memo://slow'}));",
          { yield_time_ms: 0 },
        );
        const id = cellId(pending);
        release();
        const completed = await t.client.callTool({
          name: "wait",
          arguments: { cell_id: id },
          _meta: { "openai/session": "large-resource" },
        });
        expect(jsonOutput(completed)).toMatchObject({
          server: "docs",
          contents: [{ text: "AFTER_WAIT" }],
        });
      } finally {
        release();
      }
    });
  },
);

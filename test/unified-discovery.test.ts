import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { startServer } from "../src/server.js";
import { startWebServer } from "../src/web/server.js";
import type { CodeModeToolDefinition } from "../src/code-mode/types.js";
import { jsonOutput } from "./helpers.js";
import { TOP_LEVEL_TOOL_NAMES } from "../src/tool-names.js";
import { describeContract, nativeContracts } from "../src/catalog.js";
import { resolveShell } from "../src/host/shell.js";

const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

async function setup(
  legacy: boolean,
  web = true,
  downstream = false,
  extraTools = 0,
) {
  const root = await mkdtemp(path.join(tmpdir(), "exec-catalog-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const source = `
    import {Server} from '@modelcontextprotocol/server';
    import {serveStdio} from '@modelcontextprotocol/server/stdio';
    serveStdio(()=>{const s=new Server({name:'catalog-fixture',version:'1'},{capabilities:{tools:{}}});
    s.setRequestHandler('tools/list',async()=>({tools:[
      {name:'lookup_fixture',description:'读取夹具数值 / Find a fixture value.',inputSchema:{type:'object',properties:{value:{$ref:'#/$defs/value'}},$defs:{value:{type:'number',minimum:0,description:'待查询数值'}},required:['value'],additionalProperties:false},outputSchema:{type:'object',properties:{value:{type:'number'},name:{type:'string'}},required:['value','name']}},
      {name:'apply_patch',description:'Provider-specific independent method.',inputSchema:{type:'object'}},
      ...Array.from({length:${extraTools}},(_,i)=>({name:'fixture_'+i,description:'Catalog fixture '+i,inputSchema:{type:'object',properties:{value:{type:'number'}},required:['value'],additionalProperties:false}}))]}));
    s.setRequestHandler('tools/call',async(req)=>({content:[],structuredContent:{value:req.params.arguments?.value,name:req.params.name}}));return s;});`;
  const config = {
    host: "127.0.0.1" as const,
    port: 0,
    access: "openai-tunnel" as const,
    web: { enabled: web, host: "127.0.0.1" as const, port: 0 },
    mcpServers: downstream
      ? [
          {
            name: "fixture",
            transport: "stdio" as const,
            command: process.execPath,
            args: ["--input-type=module", "--eval", source],
            cwd: process.cwd(),
            env: {},
          },
        ]
      : [],
  };
  const server = await startServer(config);
  cleanups.push(() => server.close());
  const console = web
    ? await startWebServer(server.runtime, config)
    : undefined;
  if (console) cleanups.push(() => console.close());
  const client = new Client(
    { name: "catalog-test", version: "1" },
    { versionNegotiation: { mode: legacy ? "legacy" : "auto" } },
  );
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
  cleanups.push(() => client.close());
  const call = (source: string) =>
    client.callTool({
      name: "exec",
      arguments: { source, workdir: root },
      _meta: { "openai/session": "catalog-conversation" },
    });
  return { root, server, console, client, call };
}

const inspectCatalog = `
  text({names:ALL_TOOLS.map(t=>t.name),rows:ALL_TOOLS.map(tool=>({
    name:tool.name,bound:typeof tools[tool.name],keys:Object.keys(tool).sort(),
    complete:tool.description.includes('JSON Schema')
  })),removed:typeof tools.tool_search});`;

describe.each([false, true])(
  "one catalog over real MCP (legacy=%s)",
  (legacy) => {
    it.each([false, true])(
      "advertises every native tool and exposes every bound method in ALL_TOOLS (Web=%s)",
      async (web) => {
        const s = await setup(legacy, web, true);
        const advertised = (await s.client.listTools()).tools;
        expect(advertised.map((tool) => tool.name)).toEqual(
          TOP_LEVEL_TOOL_NAMES,
        );
        const description = advertised[0]!.description!;
        const headings = nativeContracts(resolveShell()).map(
          (tool) => tool.name,
        );
        expect(description).toContain("输入 JSON Schema");
        const result = await s.call(inspectCatalog);
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        const value = jsonOutput<{
          names: string[];
          rows: {
            name: string;
            bound: string;
            keys: string[];
            complete: boolean;
          }[];
          removed: string;
        }>(result);
        expect(headings).toEqual(
          value.names.filter((name) => !name.startsWith("mcp__")),
        );
        for (const name of headings) expect(description).toContain(name);
        expect(value.rows).toHaveLength(headings.length + 2);
        for (const row of value.rows) {
          expect(row.bound).toBe("function");
          expect(row.keys).toEqual(["description", "name"]);
          expect(row.complete).toBe(true);
        }
        expect(value.removed).toBe("undefined");
        for (const name of ["tool_search", "get_user_input", "revoke_file"]) {
          expect(value.names).not.toContain(name);
          expect(description).not.toContain(name);
        }
      },
    );

    it("filters by names and descriptions, reads full contracts and calls native/downstream entries by exact name", async () => {
      const s = await setup(legacy, true, true);
      const entries = jsonOutput<{ name: string; description: string }[]>(
        await s.call(
          'text(ALL_TOOLS.filter(t => /读取夹具|lookup_fixture/i.test(t.name + " " + t.description)));',
        ),
      );
      expect(entries).toHaveLength(1);
      const entry = entries[0]!;
      expect(entry.name).toBe("mcp__fixture__lookup_fixture");
      const definition = s.server.runtime.discovery
        .snapshot()
        .find((t) => t.name === entry.name)!;
      expect(entry.description).toBe(definition.description);
      expect(entry.description).toContain(
        JSON.stringify(definition.inputSchema),
      );
      expect(entry.description).toContain('"$defs"');
      expect(entry.description).toContain('"minimum":0');
      expect(entry.description).toContain("structuredContent 契约");
      const native = jsonOutput<{ name: string; description: string }>(
        await s.call('text(ALL_TOOLS.find(t => t.name === "apply_patch"));'),
      );
      expect(native.description).toBe(
        describeContract(
          nativeContracts(resolveShell()).find(
            (t) => t.name === "apply_patch",
          )!,
        ),
      );
      const patch =
        "*** Begin Patch\n*** Add File: matched.txt\n+matched\n*** End Patch\n";
      const result = await s.call(`
      const exact=ALL_TOOLS.find(t => t.name === 'apply_patch');
      const patched=await tools[exact.name](${JSON.stringify(patch)});
      const external=ALL_TOOLS.find(t => t.name === ${JSON.stringify(entry.name)});
      const reply=await tools[external.name]({value:42});
      text({exact:exact.name,patched,reply});`);
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(jsonOutput(result)).toMatchObject({
        exact: "apply_patch",
        patched: { success: true },
        reply: { structuredContent: { value: 42, name: "lookup_fixture" } },
      });
      expect(await readFile(path.join(s.root, "matched.txt"), "utf8")).toBe(
        "matched\n",
      );
    });

    it("executes the advertised filter example against a large catalog and validates the selected call", async () => {
      const s = await setup(legacy, false, true, 80);
      const exec = (await s.client.listTools()).tools.find(
        (t) => t.name === "exec",
      )!;
      const example = exec.description!.match(
        /目录筛选示例：(text\(ALL_TOOLS\.filter\([^\n]+?\)\))；/,
      );
      expect(example).not.toBeNull();
      const matched = jsonOutput<{ name: string; description: string }[]>(
        await s.call(example![1]!.replace("关键词", "fixture_79")),
      );
      expect(matched).toHaveLength(1);
      expect(matched[0]!.name).toBe("mcp__fixture__fixture_79");
      expect(matched[0]!.description).toContain('"required":["value"]');
      const invoked = await s.call(
        'const t=ALL_TOOLS.find(t=>t.name==="mcp__fixture__fixture_79");text(await tools[t.name]({value:79}));',
      );
      expect(jsonOutput(invoked)).toMatchObject({
        structuredContent: { value: 79, name: "fixture_79" },
      });
      const invalid = await s.call(
        'await tools.mcp__fixture__fixture_79({value:"invalid"});',
      );
      expect(invalid.isError).toBe(true);
      expect(JSON.stringify(invalid)).toContain("未发送调用");
    });

    it("keeps metadata and bindings on an executing cell's snapshot; the next exec sees catalog updates", async () => {
      const s = await setup(legacy, false);
      const make = (name: string): CodeModeToolDefinition => ({
        name,
        description: `Generation ${name}`,
        inputSchema: { type: "object" },
        call: async () => name,
      });
      const first = make("catalog_first"),
        next = make("catalog_second");
      const snapshot = vi
        .spyOn(s.server.runtime.discovery, "snapshot")
        .mockReturnValue([first]);
      const advance: CodeModeToolDefinition = {
        ...make("advance_catalog"),
        call: async () => {
          snapshot.mockReturnValue([next]);
          return true;
        },
      };
      snapshot.mockReturnValue([first, advance]);
      const result = await s.call(`
      const before=ALL_TOOLS.filter(t => t.name.includes('catalog'));
      await tools.advance_catalog({});
      const after=ALL_TOOLS.filter(t => t.name.includes('catalog'));
      text({names:ALL_TOOLS.map(t=>t.name),before,after,value:await tools.catalog_first({}),next:typeof tools.catalog_second});`);
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      const value = jsonOutput<{
        names: string[];
        before: { name: string }[];
        after: { name: string }[];
        next: string;
        value: string;
      }>(result);
      expect(value.after).toEqual(value.before);
      expect(value.after.some((tool) => tool.name === "catalog_first")).toBe(
        true,
      );
      expect(value.after.every((tool) => value.names.includes(tool.name))).toBe(
        true,
      );
      expect(value.next).toBe("undefined");
      expect(value.value).toBe("catalog_first");
      const later = jsonOutput<{
        rows: { name: string; bound: string }[];
        names: string[];
      }>(await s.call(inspectCatalog));
      expect(later.names).toContain("catalog_second");
      expect(later.names).not.toContain("catalog_first");
      expect(later.rows.every((row) => row.bound === "function")).toBe(true);
    });

    it("lists full downstream contracts in Web without a separate search endpoint or model tool", async () => {
      const s = await setup(legacy, true, true);
      const catalog = await fetch(
        new URL("api/mcp-servers", s.console!.loopbackUrl),
      );
      expect(catalog.status).toBe(200);
      const body = (await catalog.json()) as {
        tools: { name: string; description: string }[];
        errors: Record<string, string>;
      };
      expect(body.errors).toEqual({});
      const expected = jsonOutput(
        await s.call(
          'text(ALL_TOOLS.filter(t => t.name.startsWith("mcp__")));',
        ),
      );
      expect(
        body.tools.map(({ name, description }) => ({ name, description })),
      ).toEqual(expected);
      vi.spyOn(s.server.runtime.downstream, "catalogErrors").mockReturnValue({
        fixture: "连接已断开；目录保留上次快照。",
      });
      const disconnected = await fetch(
        new URL("api/mcp-servers", s.console!.loopbackUrl),
      );
      expect((await disconnected.json()).errors).toEqual({
        fixture: "连接已断开；目录保留上次快照。",
      });
      const response = await fetch(
        new URL("api/mcp-servers/test-search", s.console!.loopbackUrl),
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-exec-web": "1" },
          body: JSON.stringify({ query: "apply_patch", limit: 1 }),
        },
      );
      expect(response.status).toBe(404);
      const rejected = await s.client
        .callTool({ name: "tool_search", arguments: { query: "fixture" } })
        .catch(() => ({ isError: true }));
      expect(rejected.isError).toBe(true);
    });
  },
);

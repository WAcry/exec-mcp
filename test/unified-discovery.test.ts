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

const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

async function setup(legacy: boolean, web = true, downstream = false) {
  const root = await mkdtemp(path.join(tmpdir(), "exec-catalog-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const source = `
    import {Server} from '@modelcontextprotocol/server';
    import {serveStdio} from '@modelcontextprotocol/server/stdio';
    serveStdio(()=>{const s=new Server({name:'catalog-fixture',version:'1'},{capabilities:{tools:{}}});
    s.setRequestHandler('tools/list',async()=>({tools:[
      {name:'lookup_fixture',description:'Find a fixture value.',inputSchema:{type:'object',properties:{value:{type:'number'}},required:['value'],additionalProperties:false}},
      {name:'apply_patch',description:'Provider-specific independent method.',inputSchema:{type:'object'}}]}));
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

const allSearches = `
  const rows=await Promise.all(ALL_TOOLS.map(async tool=>{
    const hit=(await tools.tool_search({query:tool.name,limit:1})).tools[0];
    return {name:tool.name,matched:hit?.name===tool.name,same:hit?.description===tool.description};
  }));
  text({names:ALL_TOOLS.map(t=>t.name),rows,removed:typeof tools.get_user_input});`;

describe.each([false, true])(
  "one catalog over real MCP (legacy=%s)",
  (legacy) => {
    it.each([false, true])(
      "advertises every native tool and searches every bound method with its exact contract (Web=%s)",
      async (web) => {
        const s = await setup(legacy, web, true);
        const advertised = (await s.client.listTools()).tools;
        expect(advertised.map((tool) => tool.name)).toEqual(
          TOP_LEVEL_TOOL_NAMES,
        );
        const description = advertised[0]!.description!;
        const headings = advertised.slice(2).map((tool) => tool.name);
        expect(description).not.toContain("输入 JSON Schema");
        const result = await s.call(allSearches);
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        const value = jsonOutput<{
          names: string[];
          rows: { name: string; matched: boolean; same: boolean }[];
          removed: string;
        }>(result);
        expect(headings).toEqual(
          value.names.filter((name) => !name.startsWith("mcp__")),
        );
        for (const name of headings) expect(description).toContain(name);
        expect(value.rows).toHaveLength(10);
        expect(
          value.rows.every((row) => row.matched && row.same),
          JSON.stringify(value.rows),
        ).toBe(true);
        expect(value.removed).toBe("undefined");
        for (const name of [
          "get_user_input",
          "request_user_input_async",
          "revoke_file",
        ]) {
          expect(value.names).not.toContain(name);
          expect(description).not.toContain(name);
        }
      },
    );

    it("searches English and Chinese purposes, then calls native freeform and downstream hits in the same exec", async () => {
      const s = await setup(legacy, true, true);
      const patch =
        "*** Begin Patch\n*** Add File: matched.txt\n+matched\n*** End Patch\n";
      const result = await s.call(`
      const english=await tools.tool_search({query:'apply patch',limit:8});
      const chinese=await tools.tool_search({query:'修改文本文件',limit:8});
      const exact=await tools.tool_search({query:'apply_patch',limit:1});
      const patched=await tools[exact.tools[0].name](${JSON.stringify(patch)});
      const external=await tools.tool_search({query:'mcp__fixture__lookup_fixture',limit:1});
      const reply=await tools[external.tools[0].name]({value:42});
      text({english:english.tools.map(t=>t.name),chinese:chinese.tools.map(t=>t.name),exact:exact.tools[0].name,patched,reply});`);
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(jsonOutput(result)).toMatchObject({
        english: expect.arrayContaining(["apply_patch"]),
        chinese: expect.arrayContaining(["apply_patch"]),
        exact: "apply_patch",
        patched: { success: true },
        reply: { structuredContent: { value: 42, name: "lookup_fixture" } },
      });
      expect(await readFile(path.join(s.root, "matched.txt"), "utf8")).toBe(
        "matched\n",
      );
    });

    it("keeps search on an executing cell's snapshot even after a catalog change; the next exec sees the update", async () => {
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
      const before=await tools.tool_search({query:'catalog',limit:50});
      await tools.advance_catalog({});
      const after=await tools.tool_search({query:'catalog',limit:50});
      text({names:ALL_TOOLS.map(t=>t.name),before:before.tools,after:after.tools,next:typeof tools.catalog_second});`);
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      const value = jsonOutput<{
        names: string[];
        before: { name: string }[];
        after: { name: string }[];
        next: string;
      }>(result);
      expect(value.after).toEqual(value.before);
      expect(value.after.some((tool) => tool.name === "catalog_first")).toBe(
        true,
      );
      expect(value.after.every((tool) => value.names.includes(tool.name))).toBe(
        true,
      );
      expect(value.next).toBe("undefined");
      const later = jsonOutput<{
        rows: { name: string; matched: boolean; same: boolean }[];
        names: string[];
      }>(await s.call(allSearches));
      expect(later.names).toContain("catalog_second");
      expect(later.names).not.toContain("catalog_first");
      expect(later.rows.every((row) => row.matched && row.same)).toBe(true);
    });

    it("uses the same complete search scope in the Web diagnostic", async () => {
      const s = await setup(legacy);
      const response = await fetch(
        new URL("api/mcp-servers/test-search", s.console!.loopbackUrl),
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-exec-web": "1" },
          body: JSON.stringify({ query: "apply_patch", limit: 1 }),
        },
      );
      expect(response.status).toBe(200);
      const expected = jsonOutput(
        await s.call(
          'text(await tools.tool_search({query:"apply_patch",limit:1}));',
        ),
      );
      expect(await response.json()).toEqual(expected);
    });
  },
);
import { TOP_LEVEL_TOOL_NAMES } from "../src/tool-names.js";

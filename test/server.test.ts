import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { connect, cellId, jsonOutput, nodeCommand, texts } from "./helpers.js";
import { startServer } from "../src/server.js";
import type { DownstreamMcpServerConfig } from "../src/downstream/config.js";
import { createDownstreamCodeName } from "../src/downstream/registry.js";

const connections: Awaited<ReturnType<typeof connect>>[] = [];
const dirs: string[] = [];
async function connection(config = {}, legacy = false) {
  const value = await connect(config, legacy);
  connections.push(value);
  return value;
}
async function directory() {
  const value = await mkdtemp(path.join(tmpdir(), "exec-mcp-server-"));
  dirs.push(value);
  return value;
}
afterEach(async () => {
  await Promise.all(connections.splice(0).map((item) => item.close()));
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
function fixture(marker: string): DownstreamMcpServerConfig {
  const source = `
import { appendFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
const marker=${JSON.stringify(marker)};
appendFileSync(marker,'started\\n');
serveStdio(()=>{
 const server=new Server({name:'fixture',version:'1'},{capabilities:{tools:{}}});
 server.setRequestHandler('tools/list',async()=>({tools:[{name:'add',description:'整数求和 arithmetic add',inputSchema:{type:'object',properties:{value:{type:'integer'}},required:['value'],additionalProperties:false}}]}));
 server.setRequestHandler('tools/call',async request=>{
  appendFileSync(marker,'call\\n');
  const value=request.params.arguments.value; const data={value:value+1};
  return {structuredContent:data,content:[{type:'text',text:JSON.stringify(data)},{type:'text',text:'distinct note'}],...(value<0?{isError:true}:{})};
 });
 return server;
});`;
  return {
    name: "fixture",
    transport: "stdio",
    command: process.execPath,
    args: ["--input-type=module", "--eval", source],
    env: {},
    cwd: process.cwd(),
    startupTimeoutMs: 3000,
  };
}
const exec = (
  client: Awaited<ReturnType<typeof connect>>["client"],
  source: string,
  extra = {},
) => client.callTool({ name: "exec", arguments: { source, ...extra } });

describe.each([false, true])("MCP transport (legacy=%s)", (legacy) => {
  it("exposes exactly two Chinese tools without UI or duplicated payloads", async () => {
    const { client } = await connection({}, legacy);
    const tools = (await client.listTools()).tools;
    expect(tools.map((tool) => tool.name)).toEqual(["exec", "wait"]);
    expect(tools[0]!.description).toContain("apply_patch");
    expect(tools[1]!.description).toContain("110");
    const result = await exec(client, "text({n:3});");
    expect(jsonOutput(result)).toEqual({ n: 3 });
    expect(result.structuredContent).toBeUndefined();
  });
  it("keeps processes usable through later exec calls and applies string patches under workdir", async () => {
    const { client } = await connection({}, legacy);
    const cwd = await directory();
    const patch =
      "*** Begin Patch\n*** Add File: file.txt\n+created\n*** End Patch\n";
    const result = await exec(
      client,
      `text(await tools.apply_patch(${JSON.stringify(patch)}));`,
      { workdir: cwd },
    );
    expect(jsonOutput(result)).toMatchObject({ success: true });
    expect(await readFile(path.join(cwd, "file.txt"), "utf8")).toBe(
      "created\n",
    );
    const command = nodeCommand(
      'process.stdin.once("data",x=>{process.stdout.write(x);process.exit(0)})',
    );
    const first = await exec(
      client,
      `text(await tools.exec_command({cmd:${JSON.stringify(command)},yield_time_ms:0}));`,
      { workdir: cwd },
    );
    const id = jsonOutput<{ session_id: string }>(first).session_id;
    const last = await exec(
      client,
      `text(await tools.write_stdin({session_id:${JSON.stringify(id)},chars:"ok",yield_time_ms:3000}));`,
    );
    expect(jsonOutput(last)).toMatchObject({ output: "ok", exit_code: 0 });
  });
  it("returns progress and final output through the wait tool", async () => {
    const { client } = await connection({}, legacy);
    const first = await exec(
      client,
      'text("progress");await new Promise(r=>setTimeout(r,100));text("done");',
      { yield_time_ms: 0 },
    );
    const last = await client.callTool({
      name: "wait",
      arguments: { cell_id: cellId(first) },
    });
    expect(texts(last).join("\n")).toContain("done");
  });
});
describe("lazy discovery over actual MCP", () => {
  it("discovers on demand, calls only on the next snapshot, validates and deduplicates", async () => {
    const marker = path.join(await directory(), "calls.txt");
    const { client } = await connection({ mcpServers: [fixture(marker)] });
    await client.listTools();
    await exec(client, "text(ALL_TOOLS.map(t=>t.name));");
    await expect(stat(marker)).rejects.toThrow();
    const search = await exec(
      client,
      'const r=await tools.tool_search({query:"求和"});text({r,bound:typeof tools.mcp__fixture__add});',
    );
    expect(jsonOutput(search)).toMatchObject({
      bound: "undefined",
      r: { errors: {}, tools: [{ name: "mcp__fixture__add" }] },
    });
    expect(JSON.stringify(jsonOutput(search))).toContain("下一次 exec");
    const result = await exec(
      client,
      "text(await tools.mcp__fixture__add({value:2}));",
    );
    expect(jsonOutput(result)).toMatchObject({
      structuredContent: { value: 3 },
      content: [{ type: "text", text: "distinct note" }],
    });
    const before = await readFile(marker, "utf8");
    const invalid = await exec(
      client,
      'text(await tools.mcp__fixture__add({value:"bad"}));',
    );
    expect(invalid.isError).toBe(true);
    expect(texts(invalid).join("\n")).toContain("未发送调用");
    expect(await readFile(marker, "utf8")).toBe(before);
    const failed = await exec(
      client,
      "text(await tools.mcp__fixture__add({value:-1}));",
    );
    expect(jsonOutput(failed)).toMatchObject({ isError: true });
  });
  it("does not block local calls on an unrelated unavailable downstream", async () => {
    const { client } = await connection({
      mcpServers: [
        {
          name: "offline",
          transport: "streamable-http",
          url: "http://127.0.0.1:1/mcp",
          headers: {},
          startupTimeoutMs: 100,
        },
      ],
    });
    const result = await exec(client, "text(42)");
    expect(jsonOutput(result)).toBe(42);
    const search = await exec(
      client,
      'text(await tools.tool_search({query:"anything"}));',
    );
    expect(
      jsonOutput<{ errors: Record<string, string> }>(search).errors.offline,
    ).toBeTruthy();
  });
  it("keeps names stable and disambiguates normalization collisions", () => {
    expect(createDownstreamCodeName("a", "b")).toBe("mcp__a__b");
    expect(createDownstreamCodeName("a-b", "c")).not.toBe(
      createDownstreamCodeName("a_b", "c"),
    );
    expect(createDownstreamCodeName("a__b", "c")).not.toBe(
      createDownstreamCodeName("a", "b__c"),
    );
  });
});
describe("ingress boundaries", () => {
  it("rejects hostile Origin and Host, and only serves the MCP path", async () => {
    const server = await connection();
    expect(
      (await fetch(server.url, { headers: { Origin: "https://evil.example" } }))
        .status,
    ).toBe(403);
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(
        server.url,
        { headers: { Host: "evil.example" } },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
    expect((await fetch(server.url.replace("/mcp", "/unknown"))).status).toBe(
      404,
    );
    expect((await fetch(server.url.replace("/mcp", "/readyz"))).status).toBe(
      200,
    );
  });
  it("refuses to take an occupied port without disturbing its owner", async () => {
    const server = await connection();
    const port = Number(new URL(server.url).port);
    await expect(
      startServer({
        host: "127.0.0.1",
        port,
        access: "openai-tunnel",
        mcpServers: [],
      }),
    ).rejects.toThrow();
    expect(jsonOutput(await exec(server.client, "text(7)"))).toBe(7);
  });
  it("cancels an MCP wait without killing the cell", async () => {
    const { client } = await connection({}, true);
    const first = await exec(
      client,
      'await new Promise(r=>setTimeout(r,500));text("finished");',
      { yield_time_ms: 0 },
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 50);
    try {
      await client.callTool(
        { name: "wait", arguments: { cell_id: cellId(first) } },
        { signal: controller.signal },
      );
    } catch {
    } finally {
      clearTimeout(timer);
    }
    const result: CallToolResult = await client.callTool({
      name: "wait",
      arguments: { cell_id: cellId(first) },
    });
    expect(texts(result).join("\n")).toContain("finished");
  });
});

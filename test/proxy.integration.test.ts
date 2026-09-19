import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import path from "node:path";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { DownstreamMcpRegistry } from "../src/downstream/registry.js";
import { ProxyFixtures } from "./proxy-fixtures.js";
import { nodeCommand } from "./helpers.js";
import { z } from "zod/v4";

let fixtures: ProxyFixtures;
const close: (() => Promise<void>)[] = [];
beforeEach(() => {
  fixtures = new ProxyFixtures();
});
afterEach(async () => {
  for (const fn of close.splice(0).reverse()) await fn();
  await fixtures.close();
});

describe("proxy settings across actual execution paths", () => {
  it("routes discovery, tool calls and connection shutdown of a remote MCP through the configured proxy", async () => {
    let calls = 0;
    const handler = createMcpHandler(() => {
      const server = new McpServer({ name: "proxy-fixture", version: "1" });
      server.registerTool(
        "example",
        { inputSchema: z.object({}), description: "Proxy fixture" },
        async () => {
          calls++;
          return { content: [{ type: "text", text: "PROXIED_MCP_RESULT" }] };
        },
      );
      return server;
    });
    close.push(() => handler.close());
    const httpHandler = toNodeHandler(handler);
    const origin = await fixtures.server((request, response) => {
      void httpHandler(request as Parameters<typeof httpHandler>[0], response);
    });
    const proxy = await fixtures.proxy((authority) => {
      expect(authority).toBe("127.0.0.1:" + origin.port);
      return origin.port;
    });
    const registry = new DownstreamMcpRegistry({
      env: { HTTP_PROXY: proxy.url },
      servers: [
        {
          name: "proxy-test",
          transport: "streamable-http",
          url: origin.url + "/mcp",
          headers: {},
        },
      ],
    });
    close.push(() => registry.close());
    const tools = await registry.listTools();
    expect(tools).toHaveLength(1);
    expect(await registry.callTool(tools[0]!.id)).toMatchObject({
      content: [{ type: "text", text: "PROXIED_MCP_RESULT" }],
    });
    expect(calls).toBe(1);
    expect(proxy.calls.length).toBeGreaterThan(0);
    await registry.close();
  });

  it("streams a ChatGPT-bound file through HTTPS_PROXY with the original bytes, hostname and signed query", async () => {
    const bytes = Buffer.alloc(2 * 1024 * 1024, 0xb5);
    const paths: string[] = [];
    const origin = await fixtures.server((request, response) => {
      paths.push(request.url ?? "");
      expect(request.headers.host).toBe("files.example.test");
      expect(request.headers["proxy-authorization"]).toBeUndefined();
      response.writeHead(200, { "Content-Length": bytes.length });
      response.end(bytes);
    }, true);
    const proxy = await fixtures.proxy((authority) => {
      expect(authority).toBe("files.example.test:443");
      return origin.port;
    });
    const directory = await fixtures.directory();
    const run = await fixtures.child(
      `
      import {ArtifactStore} from './src/files/artifacts.ts';
      import {readFile} from 'node:fs/promises';import {createHash} from 'node:crypto';
      const store = new ArtifactStore();
      try {
        const file = await store.importFile({download_url:'https://files.example.test/input?signature=fixture',file_id:'bound-file',size:${bytes.length}},'output.bin',${JSON.stringify(directory)});
        console.log(JSON.stringify({size:file.size,sha256:file.sha256,disk:createHash('sha256').update(await readFile(file.path)).digest('hex')}));
      } finally { await store.close(); }
    `,
      { HTTPS_PROXY: proxy.url },
    );
    const digest = createHash("sha256").update(bytes).digest("hex");
    expect(JSON.parse(run.stdout)).toEqual({
      size: bytes.length,
      sha256: digest,
      disk: digest,
    });
    expect(paths).toEqual(["/input?signature=fixture"]);
    expect(proxy.calls).toHaveLength(1);
  });

  it("does not bypass a configured proxy on import failure and leaves neither a target nor a partial", async () => {
    let directHits = 0;
    const origin = await fixtures.server((_request, response) => {
      directHits++;
      response.end("no");
    }, true);
    const proxy = await fixtures.proxy(() => origin.port, { reject: true });
    const directory = await fixtures.directory();
    const targetDir = path.join(directory, "failed");
    const run = await fixtures.child(
      `
      import {ArtifactStore} from './src/files/artifacts.ts';import {readdir} from 'node:fs/promises';
      const store = new ArtifactStore();let error='';
      try{await store.importFile({download_url:'https://files.example.test/input?signature=PRIVATE_TEST',file_id:'bound-file'},'output.bin',${JSON.stringify(targetDir)});}
      catch(e){error=e.message;}finally{await store.close();}
      console.log(JSON.stringify({error,files:await readdir(${JSON.stringify(targetDir)})}));
    `,
      { HTTPS_PROXY: proxy.url },
    );
    const output = JSON.parse(run.stdout);
    expect(output.files).toEqual([]);
    expect(output.error).toContain("导入失败");
    expect(output.error).not.toContain("PRIVATE_TEST");
    expect(proxy.calls).toHaveLength(1);
    expect(directHits).toBe(0);
  });
  it("respects the file-download NO_PROXY rule and retains direct DNS validation", async () => {
    const proxy = await fixtures.proxy(() => 1, { reject: true });
    const run = await fixtures.child(
      `
      import {openDownload} from './src/files/download.ts';
      try{const stream=await openDownload('https://localhost/file',new AbortController().signal);stream.destroy();console.log('unexpected');}
      catch{console.log('private-direct-target-rejected');}
    `,
      { HTTPS_PROXY: proxy.url, NO_PROXY: "localhost" },
    );
    expect(run.stdout.trim()).toBe("private-direct-target-rejected");
    expect(proxy.calls).toHaveLength(0);
  });

  it("does not follow a file redirect or decompress it implicitly when the proxy is active", async () => {
    let requests = 0;
    const origin = await fixtures.server((_request, response) => {
      requests++;
      response.writeHead(302, {
        Location: "https://other.example.test/secret",
      });
      response.end();
    }, true);
    const proxy = await fixtures.proxy(() => origin.port);
    const run = await fixtures.child(
      `
      import {openDownload} from './src/files/download.ts';
      try{const stream=await openDownload('https://files.example.test/redirect',new AbortController().signal);stream.destroy();console.log('unexpected');}
      catch(error){console.log(error.message);}
    `,
      { HTTPS_PROXY: proxy.url },
    );
    expect(run.stdout).toContain("HTTP 302");
    expect(requests).toBe(1);
    expect(proxy.calls).toHaveLength(1);
  });

  it("keeps local Code Mode IPC usable with proxy variables present and exposes those variables to a real command", async () => {
    const proxy = await fixtures.proxy(() => 1, { reject: true });
    const command = nodeCommand(
      `console.log(JSON.stringify({proxy:process.env.HTTPS_PROXY,token:process.env.EXEC_MCP_TEST_API_KEY}));`,
    );
    const run = await fixtures.child(
      `
      import {CodeModeService} from './src/code-mode/service.ts';
      import {TerminalManager} from './src/host/terminal.ts';
      const mode=new CodeModeService();const terminal=new TerminalManager();
      try {
        const value=await mode.exec({source:'text(42)',tools:[]});
        if(value.isError || !value.content.some(x=>x.type==='text'&&x.text==='42'))throw new Error('local IPC failed');
        let part=await terminal.execCommand({cmd:${JSON.stringify(command)},yield_time_ms:0},process.cwd());
        let output=part.output;const deadline=Date.now()+10000;
        while(part.session_id&&Date.now()<deadline){part=await terminal.writeStdin({session_id:part.session_id,yield_time_ms:1000});output+=part.output;}
        if(part.exit_code!==0)throw new Error('command incomplete');
        const child=JSON.parse(output);
        console.log(JSON.stringify({codeMode:true,inherited:child.proxy===${JSON.stringify(proxy.url)}&&child.token==='synthetic-key'}));
      }finally{await mode.close();await terminal.close();}
    `,
      {
        HTTP_PROXY: proxy.url,
        HTTPS_PROXY: proxy.url,
        http_proxy: proxy.url,
        https_proxy: proxy.url,
        grpc_proxy: proxy.url,
        EXEC_MCP_TEST_API_KEY: "synthetic-key",
      },
    );
    expect(JSON.parse(run.stdout)).toEqual({ codeMode: true, inherited: true });
    expect(proxy.calls).toHaveLength(0);
  });

  it("honors proxy settings inherited by a downstream MCP child using an HTTP-aware client", async () => {
    const origin = await fixtures.server((_request, response) =>
      response.end("child-via-proxy"),
    );
    const proxy = await fixtures.proxy(() => origin.port);
    const source = `
import {Server} from '@modelcontextprotocol/server';import {serveStdio} from '@modelcontextprotocol/server/stdio';
import {EnvironmentHttpClient} from './src/network/http.ts';const network=new EnvironmentHttpClient();
serveStdio(()=>{const server=new Server({name:'proxied-child',version:'1'},{capabilities:{tools:{}}});
 server.setRequestHandler('tools/list',async()=>({tools:[{name:'call',inputSchema:{type:'object'}}]}));
 server.setRequestHandler('tools/call',async()=>({content:[],structuredContent:{body:await(await network.fetch('http://child.example.test/')).text(),env:process.env.EXEC_MCP_CHILD_API_KEY}}));
 return server;});`;
    const registry = new DownstreamMcpRegistry({
      env: {
        ...process.env,
        HTTP_PROXY: proxy.url,
        http_proxy: proxy.url,
        NO_PROXY: "",
        no_proxy: "",
        EXEC_MCP_CHILD_API_KEY: "synthetic-key",
      },
      servers: [
        {
          name: "child",
          transport: "stdio",
          command: process.execPath,
          args: ["--import", "tsx", "--input-type=module", "--eval", source],
          cwd: process.cwd(),
          env: {},
        },
      ],
    });
    close.push(() => registry.close());
    const tools = await registry.listTools();
    expect(await registry.callTool(tools[0]!.id)).toMatchObject({
      structuredContent: { body: "child-via-proxy", env: "synthetic-key" },
    });
    expect(proxy.calls).toHaveLength(1);
  });
});

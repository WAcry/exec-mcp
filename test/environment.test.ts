import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import { inheritedEnvironment } from "../src/environment.js";
import { TerminalManager } from "../src/host/terminal.js";
import { resolveShell } from "../src/host/shell.js";
import { DownstreamMcpRegistry } from "../src/downstream/registry.js";
import { nodeCommand, observeTerminal } from "./helpers.js";

const resources: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of resources.splice(0).reverse()) await close();
});
const fixture = {
  EXEC_MCP_TEST_API_KEY: "fixture-not-a-real-key",
  EXEC_MCP_TEST_SECRET_TOKEN: "fixture-not-a-real-token",
  EXEC_MCP_TEST_FUNCTION_VALUE: "() { fixture; }",
  EXEC_MCP_TEST_PATH_SETTING: "some directory with 空格",
  EXEC_MCP_TEST_EMPTY: "",
};

describe("trusted subprocess environment inheritance", () => {
  it("retains every defined value without filtering names, secrets, proxy variables or function-like strings", () => {
    const source = {
      ...fixture,
      HTTP_PROXY: "http://proxy.example.test:8080",
      HTTPS_PROXY: "http://proxy.example.test:8443",
      NO_PROXY: "localhost,.example.test",
      absent: undefined,
    };
    const result = inheritedEnvironment(source);
    expect(result).toEqual({
      ...fixture,
      HTTP_PROXY: source.HTTP_PROXY,
      HTTPS_PROXY: source.HTTPS_PROXY,
      NO_PROXY: source.NO_PROXY,
    });
    expect(source.absent).toBeUndefined();
    expect(Object.hasOwn(result, "absent")).toBe(false);
    expect(result).not.toBe(source);
  });
  it("lets explicit stdio config override inherited variables and handles Windows case-insensitivity", () => {
    const source = { Path: "old-path", EXAMPLE_API_KEY: "old", KEEP: "same" };
    expect(
      inheritedEnvironment(
        source,
        { PATH: "new-path", EXAMPLE_API_KEY: "new" },
        "win32",
      ),
    ).toEqual({ PATH: "new-path", EXAMPLE_API_KEY: "new", KEEP: "same" });
    expect(inheritedEnvironment(source, { PATH: "new-path" }, "linux")).toEqual(
      { ...source, PATH: "new-path" },
    );
    expect(source.Path).toBe("old-path");
  });

  it.each([false, true])(
    "inherits values into a real command and its child (PTY=%s), without login profiles",
    async (tty) => {
      const saved = new Map(
        Object.keys(fixture).map((key) => [key, process.env[key]]),
      );
      Object.assign(process.env, fixture);
      const terminal = new TerminalManager({
        shell: resolveShell({ login: false }),
      });
      resources.push(() => terminal.close());
      try {
        const keys = Object.keys(fixture);
        const capture = `console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map(key=>[key,process.env[key]]))))`;
        const command = nodeCommand(
          `const {execFileSync}=require('node:child_process');const child=execFileSync(process.execPath,['-e',${JSON.stringify(capture)}],{encoding:'utf8'});const captured={direct:Object.fromEntries(${JSON.stringify(keys)}.map(key=>[key,process.env[key]])),child:JSON.parse(child)};console.log('ENV_SHA256:'+require('node:crypto').createHash('sha256').update(JSON.stringify(captured)).digest('hex'));`,
        );
        const first = await terminal.execCommand(
          { cmd: command, tty, yield_time_ms: 0 },
          process.cwd(),
        );
        const result = await observeTerminal(first, (input) =>
          terminal.writeStdin(input),
        );
        expect(result.exit_code).toBe(0);
        // ConPTY legitimately returns terminal controls. Check all captured bytes
        // via a short digest that cannot be split by the default terminal width.
        const expected = createHash("sha256")
          .update(JSON.stringify({ direct: fixture, child: fixture }))
          .digest("hex");
        expect(stripVTControlCharacters(result.output).trim()).toBe(
          `ENV_SHA256:${expected}`,
        );
      } finally {
        for (const [key, value] of saved) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    },
  );

  it("explicitly passes the full environment past the MCP SDK's default allowlist", async () => {
    const env = {
      ...inheritedEnvironment(),
      ...fixture,
      EXEC_MCP_TEST_OVERRIDE: "old",
      HTTP_PROXY: "http://proxy.fixture.test:8080",
      HTTPS_PROXY: "http://proxy.fixture.test:8443",
      NO_PROXY: "localhost,.fixture.test",
    };
    const expected = {
      ...fixture,
      EXEC_MCP_TEST_OVERRIDE: "from-config",
      HTTP_PROXY: env.HTTP_PROXY,
      HTTPS_PROXY: env.HTTPS_PROXY,
      NO_PROXY: env.NO_PROXY,
    };
    const source = `
import { Server } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
serveStdio(()=>{
 const server=new Server({name:'env-fixture',version:'1'},{capabilities:{tools:{}}});
 server.setRequestHandler('tools/list',async()=>({tools:[{name:'inspect',inputSchema:{type:'object'}}]}));
 server.setRequestHandler('tools/call',async()=>({content:[],structuredContent:Object.fromEntries(${JSON.stringify(Object.keys(expected))}.map(key=>[key,process.env[key]]))}));
 return server;
});`;
    const registry = new DownstreamMcpRegistry({
      env,
      servers: [
        {
          name: "fixture",
          transport: "stdio",
          command: process.execPath,
          args: ["--input-type=module", "--eval", source],
          env: { EXEC_MCP_TEST_OVERRIDE: "from-config" },
          cwd: process.cwd(),
        },
      ],
    });
    resources.push(() => registry.close());
    const tools = await registry.listTools();
    expect(tools).toHaveLength(1);
    const result = await registry.callTool(tools[0]!.id);
    expect(result.structuredContent).toEqual(expected);
  });
});

import { createServer, type Server as HttpServer } from "node:http";

import { toNodeHandler } from "@modelcontextprotocol/node";
import {
  createMcpHandler,
  McpServer,
  type McpHttpHandler,
} from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";

import { DownstreamMcpRegistry } from "../src/downstream/registry.js";

const registries: DownstreamMcpRegistry[] = [];
const httpServers: HttpServer[] = [];
const handlers: McpHttpHandler[] = [];
const strayPids: number[] = [];

afterEach(async () => {
  await Promise.allSettled(
    registries.splice(0).map(async (registry) => registry.close()),
  );
  await Promise.allSettled(
    handlers.splice(0).map(async (handler) => handler.close()),
  );
  await Promise.allSettled(
    httpServers.splice(0).map(
      async (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
  for (const pid of strayPids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone, which is the expected result.
    }
  }
});

describe("DownstreamMcpRegistry official SDK integration", () => {
  it("negotiates with a v2 stdio server, lists a tool, calls it, and closes", async () => {
    const serverSource = `
import { Server } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

serveStdio(() => {
  const server = new Server(
    {
      name: "registry-integration-fixture",
      title: "Registry integration fixture",
      version: "1.0.0",
    },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler("tools/list", async (request) => request.params?.cursor === "page-2"
    ? {
        tools: [{ name: "second", inputSchema: { type: "object" } }],
      }
    : {
        tools: [{
          name: "echo",
          description: "Return a fixed response.",
          inputSchema: { type: "object" },
        }],
        nextCursor: "page-2",
      });
  server.setRequestHandler("tools/call", async () => ({
      content: [{ type: "text", text: "official-sdk-ok" }],
      structuredContent: { ok: true },
    }));
  return server;
});
`;
    const registry = new DownstreamMcpRegistry({
      servers: [
        {
          name: "fixture",
          transport: "stdio",
          command: process.execPath,
          args: ["--input-type=module", "--eval", serverSource],
          env: {},
          cwd: process.cwd(),
        },
      ],
      connectTimeoutMs: 5_000,
      toolTimeoutMs: 5_000,
    });
    registries.push(registry);

    await registry.initialize();
    expect(registry.catalogErrors()).toEqual({});
    const tools = registry.bindingSnapshot();
    expect(tools).toHaveLength(2);
    const echo = tools.find(({ tool }) => tool.name === "echo");
    expect(echo).toMatchObject({
      serverId: "fixture",
      serverName: "registry-integration-fixture",
      serverTitle: "Registry integration fixture",
      tool: { name: "echo", description: "Return a fixed response." },
    });

    const result = await registry.callTool(echo!.id);
    expect(result).toMatchObject({
      content: [{ type: "text", text: "official-sdk-ok" }],
      structuredContent: { ok: true },
    });
  });

  it("reconnects after a real stdio server exits and binds only its fresh catalog", async () => {
    const serverSource = `
import { Server } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

serveStdio(() => {
  const server = new Server(
    { name: "exiting-fixture", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler("tools/list", async () => {
    setTimeout(() => process.exit(0), 25);
    return { tools: [{ name: "pid_" + process.pid, inputSchema: { type: "object" } }] };
  });
  return server;
});
`;
    const registry = new DownstreamMcpRegistry({
      servers: [
        {
          name: "fixture",
          transport: "stdio",
          command: process.execPath,
          args: ["--input-type=module", "--eval", serverSource],
          env: {},
          cwd: process.cwd(),
        },
      ],
      connectTimeoutMs: 5_000,
    });
    registries.push(registry);

    await registry.initialize();
    const [first] = registry.bindingSnapshot();
    await waitUntil(async () => registry.catalogErrors().fixture !== undefined);

    // The next call reconnects first, so it sees that the old tool is gone.
    await expect(registry.callTool(first!.id)).rejects.toThrow(
      /no longer in the catalog.*The request was not sent/u,
    );
    const [second] = registry.bindingSnapshot();
    expect(first!.tool.name).toMatch(/^pid_\d+$/u);
    expect(second!.tool.name).toMatch(/^pid_\d+$/u);
    expect(second!.tool.name).not.toBe(first!.tool.name);
  });

  it.skipIf(process.platform === "win32")(
    "stops the processes that a stdio server started when it closes",
    async () => {
      const serverSource = `
import { spawn } from "node:child_process";
import { Server } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";

const helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
});
serveStdio(() => {
  const server = new Server(
    { name: "wrapper-fixture", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler("tools/list", async () => ({
    tools: [{ name: "helper_" + helper.pid, inputSchema: { type: "object" } }],
  }));
  return server;
});
`;
      const registry = new DownstreamMcpRegistry({
        servers: [
          {
            name: "fixture",
            transport: "stdio",
            command: process.execPath,
            args: ["--input-type=module", "--eval", serverSource],
            env: {},
            cwd: process.cwd(),
          },
        ],
        connectTimeoutMs: 5_000,
      });
      registries.push(registry);
      await registry.initialize();
      const pid = Number(
        /^helper_(\d+)$/u.exec(registry.bindingSnapshot()[0]!.tool.name)?.[1],
      );
      strayPids.push(pid);
      expect(alive(pid)).toBe(true);

      await registry.close();
      await waitUntil(async () => !alive(pid));
    },
  );

  it("uses Streamable HTTP with static and environment headers", async () => {
    const observed: Record<string, string | undefined> = {};
    let toolName = "echo";
    const handler = createMcpHandler(
      () => fixtureServer("http-sdk-ok", toolName),
      {
        responseMode: "json",
      },
    );
    handlers.push(handler);
    const nodeHandler = toNodeHandler(handler);
    const server = createServer((request, response) => {
      for (const name of ["x-registry-test", "x-env-test", "authorization"]) {
        const header = request.headers[name];
        observed[name] = Array.isArray(header) ? header.join(",") : header;
      }
      // Node's IncomingMessage method is optional in @types/node, while the
      // SDK adapter requires the field its HTTP server always supplies.
      void nodeHandler(request as Parameters<typeof nodeHandler>[0], response);
    });
    httpServers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("Missing HTTP address");

    const registry = new DownstreamMcpRegistry({
      servers: [
        {
          name: "remote",
          transport: "streamable-http",
          url: `http://127.0.0.1:${address.port}/mcp`,
          headers: { "X-Registry-Test": "present", authorization: "static" },
          envHeaders: { "X-Env-Test": "REGISTRY_HEADER", "X-Unset": "UNSET" },
          bearerTokenEnvVar: "REGISTRY_TOKEN",
        },
      ],
      env: {
        ...process.env,
        REGISTRY_HEADER: "from-env",
        REGISTRY_TOKEN: "token-1",
      },
      connectTimeoutMs: 5_000,
      toolTimeoutMs: 5_000,
    });
    registries.push(registry);

    await registry.initialize();
    const [tool] = registry.bindingSnapshot();
    expect(tool?.tool.name).toBe("echo");
    expect(await registry.callTool(tool!.id)).toMatchObject({
      content: [{ type: "text", text: "http-sdk-ok" }],
    });
    expect(observed).toEqual({
      "x-registry-test": "present",
      "x-env-test": "from-env",
      authorization: "Bearer token-1",
    });

    toolName = "renamed";
    handler.notify.toolsChanged();
    await waitUntil(async () =>
      registry
        .bindingSnapshot()
        .some(({ tool: value }) => value.name === "renamed"),
    );
    expect(
      registry.bindingSnapshot().map(({ tool: value }) => value.name),
    ).toEqual(["renamed"]);
  });

  it("names a missing bearer token variable without starting the server", async () => {
    const registry = new DownstreamMcpRegistry({
      servers: [
        {
          name: "remote",
          transport: "streamable-http",
          url: "http://127.0.0.1:9/mcp",
          headers: {},
          bearerTokenEnvVar: "REGISTRY_MISSING_TOKEN",
        },
      ],
      env: {},
      connectTimeoutMs: 1_000,
    });
    registries.push(registry);

    await expect(registry.initialize()).rejects.toThrow(
      "the environment variable REGISTRY_MISSING_TOKEN named by bearer_token_env_var is not set",
    );
    expect(registry.catalogErrors().remote).toContain("REGISTRY_MISSING_TOKEN");
  });

  it("sends a call again once after an expired HTTP session, because the server did not run it", async () => {
    const { registry, state } = await legacyHttpFixture();
    const [tool] = registry.bindingSnapshot();
    await registry.callTool(tool!.id);
    state.generation += 1;

    expect(await registry.callTool(tool!.id)).toMatchObject({
      content: [{ type: "text", text: "session-2" }],
    });
    expect(state.initializes).toBe(2);
    expect(state.callSessions).toEqual(["session-1", "session-1", "session-2"]);
    expect(registry.catalogErrors()).toEqual({});
    expect(registry.bindingSnapshot()[0]!.tool.description).toBe(
      "Session generation 2",
    );
  });

  it("rejects a stale bound contract after reconnect without sending it", async () => {
    const { registry, state } = await legacyHttpFixture();
    const [old] = registry.bindingSnapshot();
    state.generation += 1;

    await expect(
      registry.callTool(old!.id, {}, undefined, undefined, old!.tool),
    ).rejects.toThrow(/changed or could not be confirmed.*was not sent/u);
    expect(state.callSessions).toEqual(["session-1"]);
    const [fresh] = registry.bindingSnapshot();
    expect(fresh!.tool.description).not.toBe(old!.tool.description);
    await expect(
      registry.callTool(fresh!.id, {}, undefined, undefined, fresh!.tool),
    ).resolves.toMatchObject({
      content: [{ type: "text", text: "session-2" }],
    });
    expect(state.callSessions).toEqual(["session-1", "session-2"]);
  });

  it("reports the recorded reason when the server cannot reconnect", async () => {
    const { registry, state } = await legacyHttpFixture();
    const [tool] = registry.bindingSnapshot();
    state.generation += 1;
    state.failInitialize = true;

    await expect(registry.callTool(tool!.id)).rejects.toThrow(
      /^The request was not sent: tools\/call for "echo" on downstream MCP server "fixture" could not start\. Downstream MCP server "fixture": connection and tool discovery failed: /u,
    );
    expect(registry.catalogErrors()).toEqual({
      fixture: expect.stringContaining('Downstream MCP server "fixture"'),
    });
    expect(state.callSessions).toEqual(["session-1"]);

    state.failInitialize = false;
    expect(await registry.callTool(tool!.id)).toMatchObject({
      content: [{ type: "text", text: "session-2" }],
    });
    expect(state.callSessions).toEqual(["session-1", "session-2"]);
  });

  it("keeps the session and the server's message after a rejected call", async () => {
    const { registry, state } = await legacyHttpFixture();
    const [tool] = registry.bindingSnapshot();
    state.protocolError = true;

    await expect(registry.callTool(tool!.id)).rejects.toThrow(
      'The downstream MCP server "fixture" rejected tools/call for "echo" (MCP error -32602: Invalid tool arguments). It did not run the request.',
    );
    expect(registry.catalogErrors()).toEqual({});
    state.protocolError = false;
    await registry.callTool(tool!.id);

    expect(state.initializes).toBe(1);
    expect(state.callSessions).toEqual(["session-1", "session-1"]);
  });

  it("does not send a call again when the connection drops after sending it", async () => {
    const { registry, state } = await legacyHttpFixture();
    const [tool] = registry.bindingSnapshot();
    state.dropCall = true;

    await expect(registry.callTool(tool!.id)).rejects.toThrow(
      /^The request was sent, but the connection to the downstream MCP server "fixture" failed before a result arrived for tools\/call for "echo" .*It was not retried\.$/u,
    );
    expect(state.callSessions).toEqual(["session-1"]);
  });

  it("reports a timeout as sent with an unknown result", async () => {
    const { registry, state } = await legacyHttpFixture();
    const [tool] = registry.bindingSnapshot();
    state.hangCall = true;

    await expect(
      registry.callTool(tool!.id, {}, undefined, 200),
    ).rejects.toThrow(
      /^The request was sent, but the downstream MCP server "fixture" did not answer tools\/call for "echo" within 0\.2 s \(tool_timeout_sec\)\. The tool may have done part or all of its work/u,
    );
    expect(state.callSessions).toEqual(["session-1"]);
    expect(registry.catalogErrors()).toEqual({});
  });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function legacyHttpFixture(): Promise<{
  registry: DownstreamMcpRegistry;
  state: {
    generation: number;
    initializes: number;
    failInitialize: boolean;
    protocolError: boolean;
    dropCall: boolean;
    hangCall: boolean;
    callSessions: (string | undefined)[];
  };
}> {
  const state = {
    generation: 1,
    initializes: 0,
    failInitialize: false,
    protocolError: false,
    dropCall: false,
    hangCall: false,
    callSessions: [] as (string | undefined)[],
  };
  const server = createServer(async (request, response) => {
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    let body = "";
    for await (const chunk of request) body += String(chunk);
    const message = JSON.parse(body) as {
      id?: string | number;
      method: string;
    };
    const sessionHeader = request.headers["mcp-session-id"];
    const session = Array.isArray(sessionHeader)
      ? sessionHeader[0]
      : sessionHeader;
    response.setHeader("content-type", "application/json");
    const reply = (value: Record<string, unknown>): void => {
      response.end(
        JSON.stringify({ jsonrpc: "2.0", id: message.id, ...value }),
      );
    };
    if (message.method === "server/discover") {
      reply({ error: { code: -32_601, message: "Legacy server" } });
    } else if (message.method === "initialize") {
      state.initializes += 1;
      if (state.failInitialize) {
        response.writeHead(503).end("Unavailable");
        return;
      }
      response.setHeader("mcp-session-id", `session-${state.generation}`);
      reply({
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "legacy-http-fixture", version: "1.0.0" },
        },
      });
    } else if (message.method.startsWith("notifications/")) {
      response.writeHead(202).end();
    } else {
      if (message.method === "tools/call") state.callSessions.push(session);
      if (session !== `session-${state.generation}`) {
        response.writeHead(404).end("Session not found");
      } else if (message.method === "tools/list") {
        reply({
          result: {
            tools: [
              {
                name: "echo",
                description: `Session generation ${state.generation}`,
                inputSchema: { type: "object" },
              },
            ],
          },
        });
      } else if (message.method === "tools/call" && state.dropCall) {
        request.socket.destroy();
      } else if (message.method === "tools/call" && state.hangCall) {
        // Never answer; the client times out.
      } else if (message.method === "tools/call" && state.protocolError) {
        reply({
          error: {
            code: -32_602,
            message: "Invalid tool arguments",
            data: { status: 404 },
          },
        });
      } else {
        reply({ result: { content: [{ type: "text", text: session }] } });
      }
    }
  });
  httpServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Missing HTTP address");
  const registry = new DownstreamMcpRegistry({
    servers: [
      {
        name: "fixture",
        transport: "streamable-http",
        url: `http://127.0.0.1:${address.port}/mcp`,
        headers: {},
      },
    ],
    connectTimeoutMs: 1_000,
    toolTimeoutMs: 1_000,
  });
  registries.push(registry);
  await registry.initialize();
  return { registry, state };
}

function fixtureServer(text: string, toolName = "echo"): McpServer {
  const server = new McpServer({ name: "http-fixture", version: "1.0.0" });
  server.registerTool(
    toolName,
    { description: "Return a fixed response." },
    async () => ({
      content: [{ type: "text", text }],
    }),
  );
  return server;
}

async function waitUntil(
  condition: () => Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Condition was not met before timeout");
}

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
          server.close(() => resolve());
        }),
    ),
  );
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

    const inventory = await registry.inventory();
    expect(inventory.errors).toEqual({});
    expect(inventory.tools).toHaveLength(2);
    const echo = inventory.tools.find(({ tool }) => tool.name === "echo");
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

  it("reconnects after a real stdio server exits and never returns its stale catalog", async () => {
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

    const first = (await registry.listTools())[0]!.tool.name;
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = (await registry.listTools())[0]!.tool.name;

    expect(first).toMatch(/^pid_\d+$/u);
    expect(second).toMatch(/^pid_\d+$/u);
    expect(second).not.toBe(first);
  });

  it("uses Streamable HTTP and configured headers", async () => {
    let observedHeader: string | undefined;
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
      const header = request.headers["x-registry-test"];
      observedHeader = Array.isArray(header) ? header.join(",") : header;
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
          headers: { "X-Registry-Test": "present" },
        },
      ],
      connectTimeoutMs: 5_000,
      toolTimeoutMs: 5_000,
    });
    registries.push(registry);

    const [tool] = await registry.listTools();
    expect(tool?.tool.name).toBe("echo");
    expect(await registry.callTool(tool!.id)).toMatchObject({
      content: [{ type: "text", text: "http-sdk-ok" }],
    });
    expect(observedHeader).toBe("present");

    toolName = "renamed";
    handler.notify.toolsChanged();
    await waitUntil(async () =>
      (await registry.listTools()).some(
        ({ tool: value }) => value.name === "renamed",
      ),
    );
    expect(
      (await registry.listTools()).map(({ tool: value }) => value.name),
    ).toEqual(["renamed"]);
  });

  it.each(["inventory", "call"] as const)(
    "reconnects an expired HTTP session on the next %s without retrying the failed call",
    async (nextOperation) => {
      const { registry, state } = await legacyHttpFixture();
      const [tool] = await registry.listTools();
      await registry.callTool(tool!.id);
      state.generation += 1;

      await expect(registry.callTool(tool!.id)).rejects.toThrow(
        /可能已部分或全部生效.*未自动重试/u,
      );
      expect(state.initializes).toBe(1);
      expect(state.callSessions).toEqual(["session-1", "session-1"]);

      if (nextOperation === "inventory") {
        const inventory = await registry.inventory();
        expect(inventory.errors).toEqual({});
        expect(inventory.tools[0]!.tool.description).toBe(
          "Session generation 2",
        );
      }
      expect(await registry.callTool(tool!.id)).toMatchObject({
        content: [{ type: "text", text: "session-2" }],
      });
      expect(state.initializes).toBe(2);
      expect(state.callSessions).toEqual([
        "session-1",
        "session-1",
        "session-2",
      ]);
    },
  );

  it("rejects a stale bound contract before sending a call after reconnect", async () => {
    const { registry, state } = await legacyHttpFixture();
    const [old] = await registry.listTools();
    state.generation += 1;
    await expect(registry.callTool(old!.id)).rejects.toThrow("未自动重试");
    const [fresh] = (await registry.inventory()).tools;
    expect(fresh!.tool.description).not.toBe(old!.tool.description);
    const sent = [...state.callSessions];
    await expect(
      registry.callTool(old!.id, {}, undefined, undefined, old!.tool),
    ).rejects.toThrow("契约已变更");
    expect(state.callSessions).toEqual(sent);
    await expect(
      registry.callTool(fresh!.id, {}, undefined, undefined, fresh!.tool),
    ).resolves.toMatchObject({
      content: [{ type: "text", text: "session-2" }],
    });
  });

  it("reports an unavailable server instead of its expired HTTP catalog", async () => {
    const { registry, state } = await legacyHttpFixture();
    const [tool] = await registry.listTools();
    state.generation += 1;
    state.failInitialize = true;

    await expect(registry.callTool(tool!.id)).rejects.toThrow("未自动重试");
    expect(await registry.inventory()).toEqual({
      tools: [],
      errors: { fixture: 'MCP server "fixture" failed to connect' },
    });
    expect(state.callSessions).toEqual(["session-1"]);

    state.failInitialize = false;
    expect(await registry.callTool(tool!.id)).toMatchObject({
      content: [{ type: "text", text: "session-2" }],
    });
    expect(state.callSessions).toEqual(["session-1", "session-2"]);
  });

  it("keeps a valid HTTP session after an ordinary tool protocol error", async () => {
    const { registry, state } = await legacyHttpFixture();
    const [tool] = await registry.listTools();
    state.protocolError = true;

    await expect(registry.callTool(tool!.id)).rejects.toThrow("未自动重试");
    expect((await registry.inventory()).errors).toEqual({});
    state.protocolError = false;
    await registry.callTool(tool!.id);

    expect(state.initializes).toBe(1);
    expect(state.callSessions).toEqual(["session-1", "session-1"]);
  });
});

async function legacyHttpFixture(): Promise<{
  registry: DownstreamMcpRegistry;
  state: {
    generation: number;
    initializes: number;
    failInitialize: boolean;
    protocolError: boolean;
    callSessions: (string | undefined)[];
  };
}> {
  const state = {
    generation: 1,
    initializes: 0,
    failInitialize: false,
    protocolError: false,
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
    } else if (message.method === "notifications/initialized") {
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

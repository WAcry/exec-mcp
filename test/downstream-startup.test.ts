import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { startServer } from "../src/server.js";
import { ExecRuntime } from "../src/runtime.js";
import { parseConfig, CONFIG_TEMPLATE } from "../src/config.js";
import type { DownstreamMcpServerConfig } from "../src/downstream/config.js";
import {
  Client,
  StreamableHTTPClientTransport,
  type Tool,
} from "@modelcontextprotocol/client";
import { jsonOutput } from "./helpers.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const pause = (ms = 10) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
async function eventually(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("fixture condition timed out");
    await pause();
  }
}
const tool = (name: string): Tool => ({
  name,
  description: `${name} fixture`,
  inputSchema: { type: "object" },
});

async function httpFixture(
  name = "fixture",
  options: {
    pages?: Tool[][];
    waitForInit?: Promise<void>;
    pageDelay?: number;
    initDelay?: number;
    authAt?: "initialize" | "tools/list";
    status?: number;
    resourcesOnly?: boolean;
    timeout?: number;
  } = {},
) {
  const state = {
    generation: 1,
    initialized: 0,
    lists: 0,
    calls: 0,
    requests: 0,
    authPassed: false,
  };
  const pages = options.pages ?? [[tool("echo")]];
  const server = createServer((request, response) => {
    void (async () => {
      state.requests++;
      if (request.method !== "POST") {
        response.writeHead(405).end();
        return;
      }
      let raw = "";
      for await (const part of request) raw += part.toString();
      const message = JSON.parse(raw) as {
        id?: string | number;
        method: string;
        params?: { cursor?: string };
      };
      response.setHeader("Content-Type", "application/json");
      const reply = (value: Record<string, unknown>) =>
        response.end(
          JSON.stringify({ jsonrpc: "2.0", id: message.id, ...value }),
        );
      if (message.method === "server/discover") {
        reply({ error: { code: -32601, message: "Legacy fixture" } });
        return;
      }
      if (
        message.method === options.authAt &&
        request.headers.authorization !== "Bearer fixture-credential"
      ) {
        response
          .writeHead(options.status ?? 401, {
            "WWW-Authenticate":
              'Bearer resource_metadata="https://issuer.example.test/private?key=DO_NOT_ECHO"',
          })
          .end("DO_NOT_ECHO_AUTH_PAYLOAD");
        return;
      }
      if (message.method === "initialize") {
        state.initialized++;
        if (options.waitForInit) await options.waitForInit;
        if (options.initDelay) await pause(options.initDelay);
        state.authPassed =
          request.headers.authorization === "Bearer fixture-credential";
        response.setHeader("mcp-session-id", `s${state.generation}`);
        reply({
          result: {
            protocolVersion: "2025-11-25",
            capabilities: options.resourcesOnly
              ? { resources: {} }
              : { tools: {} },
            serverInfo: { name, version: "1" },
          },
        });
        return;
      }
      if (message.method === "notifications/initialized") {
        response.writeHead(202).end();
        return;
      }
      if (message.method === "tools/call") state.calls++;
      if (request.headers["mcp-session-id"] !== `s${state.generation}`) {
        response.writeHead(404).end();
        return;
      }
      if (message.method === "tools/list") {
        state.lists++;
        if (options.pageDelay) await pause(options.pageDelay);
        const index = Number(message.params?.cursor ?? 0);
        reply({
          result: {
            tools: pages[index] ?? [],
            ...(index < pages.length - 1
              ? { nextCursor: String(index + 1) }
              : {}),
          },
        });
        return;
      }
      reply({
        result: {
          structuredContent: { generation: state.generation },
          content: [],
        },
      });
    })().catch(() => response.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  const definition: DownstreamMcpServerConfig = {
    name,
    transport: "streamable-http",
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    headers: {},
    startupTimeoutMs: options.timeout ?? 3000,
  };
  return { state, definition, server };
}

async function start(
  definitions: DownstreamMcpServerConfig[],
  options: Parameters<typeof startServer>[1] = {},
) {
  const server = await startServer(
    {
      host: "127.0.0.1",
      port: 0,
      access: "openai-tunnel",
      mcpServers: definitions,
    },
    options,
  );
  cleanup.push(() => server.close());
  return server;
}
async function clientFor(url: string) {
  const client = new Client({ name: "startup-test", version: "1" });
  cleanup.push(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}

describe("complete downstream startup before readiness", () => {
  it("initializes all servers in parallel, reads all pages, and never probes tools/call", async () => {
    const release = gate();
    const a = await httpFixture("a", {
      waitForInit: release.promise,
      pages: [[tool("one")], [tool("two")], [tool("three")]],
    });
    const b = await httpFixture("b", { waitForInit: release.promise });
    const events: string[] = [];
    const pending = start([a.definition, b.definition], {
      onDownstreamProgress: (event) =>
        events.push(`${event.server}:${event.status}`),
    });
    try {
      await eventually(
        () => a.state.initialized === 1 && b.state.initialized === 1,
      );
    } finally {
      release.resolve();
    }
    const server = await pending;
    expect(a.state.lists).toBe(3);
    expect(b.state.lists).toBe(1);
    expect(a.state.calls + b.state.calls).toBe(0);
    expect(server.runtime.ready).toBe(true);
    expect(
      server.runtime.discovery.snapshot().map((entry) => entry.name),
    ).toEqual(
      expect.arrayContaining([
        "mcp__a__one",
        "mcp__a__two",
        "mcp__a__three",
        "mcp__b__echo",
      ]),
    );
    expect(events).toEqual(
      expect.arrayContaining([
        "a:connecting",
        "b:connecting",
        "a:ready",
        "b:ready",
      ]),
    );
  });
  it("keeps the runtime unready until discovery completes, and initialization is single-flight", async () => {
    const release = gate();
    const fixture = await httpFixture("one", { waitForInit: release.promise });
    const runtime = new ExecRuntime({
      host: "127.0.0.1",
      port: 0,
      access: "openai-tunnel",
      mcpServers: [fixture.definition],
    });
    cleanup.push(() => runtime.close());
    const first = runtime.initialize();
    const second = runtime.initialize();
    expect(runtime.ready).toBe(false);
    expect(first).toBe(second);
    release.resolve();
    await first;
    expect(runtime.ready).toBe(true);
    expect(fixture.state.initialized).toBe(1);
    await runtime.close();
    expect(runtime.ready).toBe(false);
  });
  it("has no listener or partial readiness during startup", async () => {
    const release = gate();
    const fixture = await httpFixture("wait", { waitForInit: release.promise });
    const reservation = createServer();
    await new Promise<void>((resolve) =>
      reservation.listen(0, "127.0.0.1", resolve),
    );
    const port = (reservation.address() as AddressInfo).port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const pending = startServer({
      host: "127.0.0.1",
      port,
      access: "openai-tunnel",
      mcpServers: [fixture.definition],
    });
    try {
      await eventually(() => fixture.state.initialized === 1);
      await expect(fetch(`http://127.0.0.1:${port}/readyz`)).rejects.toThrow();
    } finally {
      release.resolve();
    }
    const server = await pending;
    cleanup.push(() => server.close());
    expect((await fetch(`http://127.0.0.1:${port}/readyz`)).status).toBe(200);
  });
  it("reports every failed enabled server and can start afresh after credentials are corrected", async () => {
    const a = await httpFixture("auth-at-init", { authAt: "initialize" });
    const b = await httpFixture("auth-at-list", {
      authAt: "tools/list",
      status: 403,
    });
    const good = await httpFixture("ready");
    let error = "";
    try {
      await start([a.definition, b.definition, good.definition]);
    } catch (caught) {
      error = String(caught);
    }
    expect(error).toContain("服务未就绪");
    expect(error).toContain("auth-at-init");
    expect(error).toContain("auth-at-list");
    expect(error).toContain("鉴权");
    expect(error).not.toMatch(
      /DO_NOT_ECHO|issuer.example.test|fixture-credential/,
    );
    expect(good.state.calls).toBe(0);
    const headers = { Authorization: "Bearer fixture-credential" };
    const server = await start([
      { ...a.definition, headers },
      { ...b.definition, headers },
      good.definition,
    ]);
    expect(server.runtime.ready).toBe(true);
    expect(a.state.authPassed).toBe(true);
  });
  it("does not suppress malformed schemas or configured tool-name mistakes until first call", async () => {
    const invalid: Tool = {
      name: "invalid",
      inputSchema: {
        type: "object",
        properties: { x: { type: "not-json-schema" } },
      },
    };
    const bad = await httpFixture("bad", { pages: [[invalid]] });
    await expect(start([bad.definition])).rejects.toThrow(
      "无法校验工具输入契约",
    );
    expect(bad.state.calls).toBe(0);
    const ordinary = await httpFixture("ordinary");
    await expect(
      start([{ ...ordinary.definition, enabledTools: ["typo"] }]),
    ).rejects.toThrow("enabled_tools");
  });
  it("accepts an intentional empty selection and servers that advertise no tools", async () => {
    const a = await httpFixture("resources", { resourcesOnly: true });
    const b = await httpFixture("none");
    const server = await start([
      a.definition,
      { ...b.definition, enabledTools: [] },
    ]);
    expect(server.runtime.discovery.snapshot()).toEqual([]);
    expect(a.state.lists).toBe(0);
    expect(b.state.lists).toBe(1);
  });
  it("does not start disabled services and accepts startup budgets longer than connector waits", () => {
    const config = parseConfig(
      CONFIG_TEMPLATE +
        '\n[mcp_servers.disabled]\ncommand="missing-program"\nenabled=false\n[mcp_servers.selected]\ncommand="node"\nstartup_timeout_sec=300\n',
      "config.toml",
    );
    expect(config.mcpServers).toHaveLength(1);
    expect(config.mcpServers[0]!.startupTimeoutMs).toBe(300_000);
    expect(() =>
      parseConfig(
        CONFIG_TEMPLATE +
          '\n[mcp_servers.over]\ncommand="node"\nstartup_timeout_sec=2147484\n',
        "config.toml",
      ),
    ).toThrow("startup_timeout_sec");
  });
  it("applies one deadline to initialization and all list pages together", async () => {
    const fixture = await httpFixture("slow", {
      initDelay: 400,
      pageDelay: 400,
      pages: [[tool("one")], [tool("two")], [tool("three")]],
      timeout: 700,
    });
    const began = Date.now();
    await expect(start([fixture.definition])).rejects.toThrow("超时");
    expect(Date.now() - began).toBeLessThan(2000);
    expect(fixture.state.lists).toBeLessThan(3);
  });
  it("cancels startup without leaving a successful sibling's client alive", async () => {
    const release = gate();
    const a = await httpFixture("slow", { waitForInit: release.promise });
    const b = await httpFixture("fast");
    const abort = new AbortController();
    const pending = start([a.definition, b.definition], {
      signal: abort.signal,
    });
    const rejected = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    try {
      await eventually(() => a.state.initialized === 1 && b.state.lists === 1);
      abort.abort();
      await rejected;
    } finally {
      release.resolve();
    }
    const again = await start([b.definition]);
    expect(again.runtime.ready).toBe(true);
    expect(b.state.initialized).toBe(2);
  });
});

describe("discovery is a local query, never a tool-unlock handshake", () => {
  it("searches the complete cache without issuing additional network requests", async () => {
    const fixture = await httpFixture();
    const server = await start([fixture.definition]);
    const requests = fixture.state.requests;
    const search = await server.runtime.discovery.search("echo", 8);
    expect(search.tools).toHaveLength(1);
    expect(search.errors).toEqual({});
    expect(search).not.toHaveProperty("note");
    expect(fixture.state.requests).toBe(requests);
  });
  it("can call a known method again after a disconnect without any preceding search", async () => {
    const fixture = await httpFixture();
    const server = await start([fixture.definition]);
    const client = await clientFor(server.url);
    const run = () =>
      client.callTool({
        name: "exec",
        arguments: { source: "text(await tools.mcp__fixture__echo({}));" },
      });
    expect(jsonOutput(await run())).toMatchObject({
      structuredContent: { generation: 1 },
    });
    fixture.state.generation = 2;
    const failed = await run();
    expect(failed.isError).toBe(true);
    expect(fixture.state.calls).toBe(2);
    const listings = fixture.state.lists;
    const search = await server.runtime.discovery.search("echo", 8);
    expect(search.tools).toHaveLength(1);
    expect(search.errors.fixture).toBeTruthy();
    expect(fixture.state.lists).toBe(listings);
    const recovered = await run();
    expect(recovered.isError).not.toBe(true);
    expect(jsonOutput(recovered)).toMatchObject({
      structuredContent: { generation: 2 },
    });
    expect(fixture.state.calls).toBe(3);
    expect(fixture.state.initialized).toBe(2);
  });
});

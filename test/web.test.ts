import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type { Config } from "../src/config.js";
import { startServer } from "../src/server.js";
import { startWebServer, type WebServerInstance } from "../src/web/server.js";
import { ActivityStore } from "../src/web/activity.js";
import { cellId } from "./helpers.js";

interface ResponseResult {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
  json<T = Record<string, unknown>>(): T;
}

let root: string;
const cleanups: (() => Promise<void>)[] = [];
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "exec-web-")));
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await rm(root, { recursive: true, force: true });
});

function baseConfig(): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    access: "openai-tunnel",
    mcpServers: [],
  };
}

async function startWeb(
  options: {
    host?: "127.0.0.1" | "0.0.0.0";
    displayConfig?: Config;
  } = {},
) {
  const activity = new ActivityStore();
  const mcp = await startServer(baseConfig(), { activity });
  cleanups.push(() => mcp.close());
  const publicDir = path.join(root, "public");
  await mkdir(path.join(publicDir, "assets"), { recursive: true });
  await writeFile(
    path.join(publicDir, "index.html"),
    '<!doctype html><html><body><div id="root">TEST_WEB_UI</div></body></html>',
  );
  await writeFile(
    path.join(publicDir, "assets", "app.js"),
    "console.log('asset');\n",
  );
  const configPath = path.join(root, "private configuration.toml");
  await writeFile(configPath, "[server]\naccess='openai-tunnel'\n");
  const web = await startWebServer(
    mcp.runtime,
    options.displayConfig ?? baseConfig(),
    {
      port: 0,
      host: options.host ?? "127.0.0.1",
      publicDir,
      configPath,
      mcpUrl: mcp.url,
    },
  );
  cleanups.push(() => web.close());
  return { activity, mcp, web, configPath, publicDir };
}

function request(
  web: WebServerInstance,
  pathname: string,
  options: {
    method?: string;
    host?: string;
    origin?: string;
    headers?: Record<string, string>;
    body?: unknown;
  } = {},
): Promise<ResponseResult> {
  return new Promise((resolve, reject) => {
    const body =
      options.body === undefined
        ? undefined
        : typeof options.body === "string"
          ? Buffer.from(options.body)
          : Buffer.from(JSON.stringify(options.body));
    const headers: Record<string, string | number> = {
      Host: options.host ?? `127.0.0.1:${web.port}`,
      ...options.headers,
    };
    if (options.origin) headers.Origin = options.origin;
    if (body) {
      headers["Content-Length"] = body.length;
      headers["Content-Type"] ??= "application/json";
    }
    const outgoing = httpRequest(
      {
        host: "127.0.0.1",
        port: web.port,
        path: pathname,
        method: options.method ?? "GET",
        headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            text,
            json<T>() {
              return JSON.parse(text) as T;
            },
          });
        });
      },
    );
    outgoing.once("error", reject);
    if (body) outgoing.write(body);
    outgoing.end();
  });
}

function cookie(response: ResponseResult): string {
  const header = response.headers["set-cookie"];
  const value = Array.isArray(header) ? header[0] : header;
  expect(value).toBeTruthy();
  return value!.split(";", 1)[0]!;
}

function actionHeaders(extra: Record<string, string> = {}) {
  return { "x-exec-web": "1", ...extra };
}

function openEventStream(
  web: WebServerInstance,
  options: { host: string; cookie?: string; origin?: string },
) {
  let responseReady!: () => void;
  let closed!: () => void;
  const ready = new Promise<void>((resolve) => {
    responseReady = resolve;
  });
  const ended = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const outgoing = httpRequest(
    {
      host: "127.0.0.1",
      port: web.port,
      path: "/api/events",
      headers: {
        Host: options.host,
        ...(options.cookie ? { Cookie: options.cookie } : {}),
        ...(options.origin ? { Origin: options.origin } : {}),
      },
    },
    (response) => {
      expect(response.statusCode).toBe(200);
      response.once("data", responseReady);
      response.once("end", closed);
      response.once("close", closed);
    },
  );
  outgoing.end();
  return {
    ready,
    ended,
    close: () => outgoing.destroy(),
  };
}

async function authenticate(web: WebServerInstance, host: string) {
  const response = await request(web, "/api/auth/verify", {
    method: "POST",
    host,
    headers: actionHeaders(),
    body: { token: web.token },
  });
  expect(response.status).toBe(200);
  expect(response.headers["set-cookie"]?.join(";")).toContain("HttpOnly");
  expect(response.headers["set-cookie"]?.join(";")).toContain(
    "SameSite=Strict",
  );
  expect(response.headers["set-cookie"]?.join(";")).toContain("Path=/api");
  return cookie(response);
}

describe("Web console access boundary", () => {
  it("does not collect hidden audit copies when the Web console is disabled", async () => {
    const mcp = await startServer({
      ...baseConfig(),
      web: { enabled: false, host: "127.0.0.1", port: 8893 },
    });
    cleanups.push(() => mcp.close());
    const client = new Client({ name: "web-disabled-test", version: "1" });
    cleanups.push(() => client.close());
    await client.connect(new StreamableHTTPClientTransport(new URL(mcp.url)));
    const result = await client.callTool({
      name: "exec",
      arguments: { source: 'text("PRIVATE_DISABLED_AUDIT_VALUE");' },
      _meta: { "openai/session": "private-disabled-session" },
    });
    expect(result.isError).not.toBe(true);
    expect(mcp.runtime.activity.getStats()).toMatchObject({
      totalCalls: 0,
      activeSessions: 0,
    });
    expect(JSON.stringify(mcp.runtime.activity.getCalls())).not.toContain(
      "PRIVATE_DISABLED_AUDIT_VALUE",
    );
  });

  it("is loopback-only by default and rejects rebinding, cross-origin and query-token access", async () => {
    const { web } = await startWeb();
    expect(web.host).toBe("127.0.0.1");
    expect(web.exposed).toBe(false);
    expect(web.lanUrls).toEqual([]);

    const page = await request(web, "/");
    expect(page.status).toBe(200);
    expect(page.text).toContain("TEST_WEB_UI");
    expect(page.headers["content-security-policy"]).toContain(
      "default-src 'self'",
    );
    expect(page.headers["x-frame-options"]).toBe("DENY");
    expect(page.headers["referrer-policy"]).toBe("no-referrer");
    expect(page.headers["cross-origin-opener-policy"]).toBe("same-origin");
    expect(page.headers["cross-origin-resource-policy"]).toBe("same-origin");
    expect(page.headers["content-security-policy"]).toContain(
      "object-src 'none'",
    );

    const status = await request(web, "/api/status");
    expect(status.status).toBe(200);
    expect(status.json()).toMatchObject({
      isLoopback: true,
      web: { exposed: false, host: "127.0.0.1", lanUrls: [] },
    });
    expect(status.text).not.toContain(web.token);

    const reboundHost = `device.example.test:${web.port}`;
    expect(
      (await request(web, "/api/status", { host: reboundHost })).status,
    ).toBe(401);
    expect(
      (
        await request(
          web,
          `/api/status?token=${encodeURIComponent(web.token)}`,
          {
            host: reboundHost,
          },
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await request(web, "/api/status", {
          origin: "https://attacker.example.test",
        })
      ).status,
    ).toBe(403);
    expect((await request(web, "/%2e%2e%2fsecret.txt")).status).toBe(403);
    expect((await request(web, "/assets/missing.js")).status).toBe(404);
  });

  it("uses a fragment bootstrap and an HttpOnly cookie for explicit LAN exposure", async () => {
    const { web } = await startWeb({ host: "0.0.0.0" });
    expect(web.exposed).toBe(true);
    for (const url of web.lanUrls) {
      expect(url).toContain(`#token=${encodeURIComponent(web.token)}`);
      expect(url).not.toContain("?token=");
    }
    const host = `device.local:${web.port}`;
    expect(
      (
        await request(web, "/api/auth/verify", {
          method: "POST",
          host,
          body: { token: web.token },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(web, "/api/auth/verify", {
          method: "POST",
          host,
          headers: actionHeaders(),
          body: { token: "wrong" },
        })
      ).status,
    ).toBe(401);

    const session = await authenticate(web, host);
    const remoteStatus = await request(web, "/api/status", {
      host,
      origin: `http://${host}`,
      headers: { Cookie: session },
    });
    expect(remoteStatus.status).toBe(200);
    expect(remoteStatus.headers["cross-origin-opener-policy"]).toBeUndefined();
    expect(remoteStatus.json()).toMatchObject({
      isLoopback: false,
      web: { exposed: true, lanUrls: [] },
    });
    expect(remoteStatus.text).not.toContain(web.token);

    expect(
      (
        await request(web, "/api/calls", {
          method: "DELETE",
          host,
          headers: { Cookie: session },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(web, "/api/calls", {
          method: "DELETE",
          host,
          headers: actionHeaders({ Cookie: session }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(web, "/api/auth/regenerate-token", {
          method: "POST",
          host,
          headers: actionHeaders({ Cookie: session }),
        })
      ).status,
    ).toBe(403);

    const previous = web.token;
    const regenerated = await request(web, "/api/auth/regenerate-token", {
      method: "POST",
      headers: actionHeaders(),
    });
    expect(regenerated.status).toBe(200);
    expect(web.token).not.toBe(previous);
    expect(regenerated.text).not.toContain(previous);
    const newCookie = cookie(regenerated);
    expect(
      (
        await request(web, "/api/status", {
          host,
          headers: { Cookie: session },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await request(web, "/api/status", {
          host,
          headers: { Cookie: newCookie },
        })
      ).status,
    ).toBe(200);

    const logout = await request(web, "/api/auth/logout", {
      method: "POST",
      host,
      headers: actionHeaders({ Cookie: newCookie }),
    });
    expect(logout.status).toBe(200);
    expect(logout.headers["set-cookie"]?.join(";")).toContain("Max-Age=0");
  });

  it("bounds JSON request bodies", async () => {
    const { web } = await startWeb();
    const response = await request(web, "/api/auth/verify", {
      method: "POST",
      headers: actionHeaders(),
      body: JSON.stringify({ token: "x".repeat(70 * 1024) }),
    });
    expect(response.status).toBe(413);
  });

  it("disconnects already-authorized event streams when the LAN token rotates", async () => {
    const { web } = await startWeb({ host: "0.0.0.0" });
    const host = `device.local:${web.port}`;
    const session = await authenticate(web, host);
    const stream = openEventStream(web, {
      host,
      origin: `http://${host}`,
      cookie: session,
    });
    await Promise.race([
      stream.ready,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("SSE bootstrap timeout")), 3000),
      ),
    ]);

    const rotated = await request(web, "/api/auth/regenerate-token", {
      method: "POST",
      headers: actionHeaders(),
    });
    expect(rotated.status).toBe(200);
    await Promise.race([
      stream.ended,
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error("rotated SSE remained connected")),
          3000,
        ),
      ),
    ]);
    expect(
      (
        await request(web, "/api/status", {
          host,
          headers: { Cookie: session },
        })
      ).status,
    ).toBe(401);
    stream.close();
  });
});

describe("Web management data and actions", () => {
  it("redacts configured credentials and command arguments from local and LAN views", async () => {
    const displayConfig: Config = {
      ...baseConfig(),
      auth: {
        type: "bearer",
        token_file: "/private/BEARER_FILE_SECRET",
      },
      tunnel: {
        provider: "cloudflare",
        executable: "cloudflared",
        token_file: "/private/TUNNEL_FILE_SECRET",
      },
      execution: { shell: "/private/shell", login: false },
      mcpServers: [
        {
          name: "stdio-secret",
          transport: "stdio",
          command: "node",
          args: ["--token", "PRIVATE_ARGUMENT_VALUE"],
          env: { API_KEY: "PRIVATE_ENV_VALUE" },
          cwd: "/private/project/cwd",
        },
        {
          name: "http-secret",
          transport: "streamable-http",
          url: "https://mcp.example.test/service?token=PRIVATE_URL_QUERY",
          headers: { Authorization: "PRIVATE_HEADER_VALUE" },
        },
      ],
    };
    const { web, configPath } = await startWeb({
      host: "0.0.0.0",
      displayConfig,
    });
    const forbidden = [
      "BEARER_FILE_SECRET",
      "TUNNEL_FILE_SECRET",
      "PRIVATE_ARGUMENT_VALUE",
      "PRIVATE_ENV_VALUE",
      "PRIVATE_HEADER_VALUE",
      "PRIVATE_URL_QUERY",
    ];

    const localConfig = await request(web, "/api/config");
    expect(localConfig.status).toBe(200);
    expect(localConfig.json<{ config_path: string }>().config_path).toBe(
      configPath,
    );
    for (const value of forbidden)
      expect(localConfig.text).not.toContain(value);
    expect(localConfig.text).toContain("<redacted>");
    expect(localConfig.text).toContain("API_KEY");
    expect(localConfig.text).toContain("Authorization");

    const localMcp = await request(web, "/api/mcp-servers");
    for (const value of forbidden) expect(localMcp.text).not.toContain(value);
    expect(localMcp.json()).toMatchObject({
      servers: [
        { name: "stdio-secret", argsCount: 2, envKeys: ["API_KEY"] },
        {
          name: "http-secret",
          url: "https://mcp.example.test/service",
          headerNames: ["Authorization"],
        },
      ],
    });

    const host = `device.local:${web.port}`;
    const session = await authenticate(web, host);
    const remoteConfig = await request(web, "/api/config", {
      host,
      headers: { Cookie: session },
    });
    expect(remoteConfig.status).toBe(200);
    expect(remoteConfig.text).not.toContain(configPath);
    const remote = remoteConfig.json<{
      config_file: string;
      mcp_servers: { cwd?: string }[];
    }>();
    expect(remote.config_file).toBe(path.basename(configPath));
    expect(remote.mcp_servers[0]).toMatchObject({ cwd: "cwd" });
  });

  it("revokes scoped artifacts through the authenticated instance-management endpoint", async () => {
    const { web, mcp } = await startWeb();
    const file = path.join(root, "artifact.txt");
    await writeFile(file, "artifact body");
    const exported = await mcp.runtime.artifacts.exportFile(
      file,
      root,
      "conversation-scope",
    );
    expect(
      mcp.runtime.artifacts.available(exported.info.id, "conversation-scope"),
    ).toBe(true);

    expect(
      (
        await request(web, "/api/artifacts/revoke", {
          method: "POST",
          body: { id: exported.info.id },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(web, "/api/artifacts/revoke", {
          method: "POST",
          headers: actionHeaders(),
          body: { id: exported.info.id },
        })
      ).status,
    ).toBe(200);
    expect(
      mcp.runtime.artifacts.available(exported.info.id, "conversation-scope"),
    ).toBe(false);
  });

  it("streams lightweight activity invalidations without copying source or output data", async () => {
    const { web, activity } = await startWeb();
    const event = new Promise<Record<string, unknown>>((resolve, reject) => {
      const outgoing = httpRequest(
        {
          host: "127.0.0.1",
          port: web.port,
          path: "/api/events",
          headers: { Host: `127.0.0.1:${web.port}` },
        },
        (response) => {
          response.setEncoding("utf8");
          let pending = "";
          response.on("data", (chunk: string) => {
            pending += chunk;
            const frames = pending.split("\n\n");
            pending = frames.pop() ?? "";
            for (const frame of frames) {
              const line = frame
                .split("\n")
                .find((value) => value.startsWith("data: "));
              if (!line) continue;
              const value = JSON.parse(line.slice(6)) as Record<
                string,
                unknown
              >;
              if (value.type === "call:start") {
                outgoing.destroy();
                resolve(value);
              }
            }
          });
        },
      );
      outgoing.once("error", reject);
      outgoing.end();
      setTimeout(
        () => reject(new Error("SSE activity event timeout")),
        3000,
      ).unref();
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    activity.startCall({
      tool: "exec",
      sessionId: "scope-digest",
      args: { source: "PRIVATE_SOURCE_MUST_NOT_BE_IN_SSE" },
    });
    const payload = await event;
    expect(payload).toMatchObject({
      type: "call:start",
      sessionId: "scope-digest",
    });
    expect(JSON.stringify(payload)).not.toContain("PRIVATE_SOURCE");
    expect(Object.keys(payload).sort()).toEqual([
      "callId",
      "sessionId",
      "type",
    ]);
  });

  it("uses compact call listings and loads bounded detail only when requested", async () => {
    const { web, activity } = await startWeb();
    const tracker = activity.startCall({
      tool: "exec",
      sessionId: "scope-digest",
      args: { source: "first line\nPRIVATE_DETAIL_SOURCE" },
    });
    tracker.recordSubcall({
      name: "exec_command",
      durationMs: 3,
      input: { cmd: "PRIVATE_DETAIL_COMMAND" },
      output: { text: "PRIVATE_DETAIL_OUTPUT" },
      status: "success",
    });
    tracker.finish({
      status: "completed",
      output: { text: "PRIVATE_FINAL_OUTPUT" },
    });

    const listing = await request(web, "/api/calls");
    expect(listing.status).toBe(200);
    expect(listing.text).not.toMatch(/PRIVATE_DETAIL|PRIVATE_FINAL/);
    const summary = listing.json<{
      items: { id: string; args: { source: string }; subcallCount: number }[];
    }>().items[0]!;
    expect(summary).toMatchObject({
      id: tracker.id,
      args: { source: "first line" },
      subcallCount: 1,
    });

    const detail = await request(
      web,
      `/api/calls/${encodeURIComponent(tracker.id)}`,
    );
    expect(detail.status).toBe(200);
    expect(detail.text).toContain("PRIVATE_DETAIL_COMMAND");
    expect(detail.text).toContain("PRIVATE_FINAL_OUTPUT");
  });

  it("records yielded and terminated Code Mode outcomes instead of labeling both completed", async () => {
    const { web, mcp } = await startWeb();
    const client = new Client({ name: "web-status-test", version: "1" });
    cleanups.push(() => client.close());
    await client.connect(new StreamableHTTPClientTransport(new URL(mcp.url)));
    const meta = { "openai/session": "web-status-conversation" };
    const first = await client.callTool({
      name: "exec",
      arguments: {
        source: "yield_control();await new Promise(()=>{});",
      },
      _meta: meta,
    });
    const handle = cellId(first);

    const yielded = await request(web, "/api/calls?status=yielding");
    expect(yielded.status).toBe(200);
    expect(
      yielded.json<{ items: { tool: string; status: string }[] }>().items,
    ).toEqual([expect.objectContaining({ tool: "exec", status: "yielding" })]);

    const terminated = await client.callTool({
      name: "wait",
      arguments: { cell_id: handle, terminate: true },
      _meta: meta,
    });
    expect(terminated.isError).not.toBe(true);
    const stopped = await request(web, "/api/calls?status=terminated");
    expect(stopped.status).toBe(200);
    expect(
      stopped.json<{ items: { tool: string; status: string }[] }>().items,
    ).toEqual([
      expect.objectContaining({ tool: "wait", status: "terminated" }),
    ]);
  });
});

describe("Web UI source assets", () => {
  it("does not contact third-party font or script hosts", async () => {
    const html = await readFile(
      path.join(process.cwd(), "ui", "index.html"),
      "utf8",
    );
    expect(html).not.toMatch(/fonts\.googleapis|fonts\.gstatic|https:\/\//);
  });
});

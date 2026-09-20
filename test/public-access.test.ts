import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import { startServer } from "../src/server.js";
import { CONFIG_TEMPLATE, parseConfig, type Config } from "../src/config.js";
import { RESOURCE_METADATA_PATH } from "../src/http/access.js";
import { cellId, jsonOutput, texts } from "./helpers.js";

const origin = "https://exec.example.test";
const issuer = "https://identity.example.test/";
const subject = "one-operator";
const scopes = ["exec"];
const tokenName = "EXEC_MCP_TEST_PUBLIC_TOKEN";
const token = "fixture-token-012345678901234567890123456789";
const cleanups: (() => Promise<unknown>)[] = [];
const savedToken = process.env[tokenName];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  if (savedToken === undefined) delete process.env[tokenName];
  else process.env[tokenName] = savedToken;
});
function publicConfig(): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    access: "public",
    public_url: origin,
    auth: { type: "oauth", issuer, jwks_url: issuer + "jwks", subject, scopes },
    mcpServers: [],
  };
}
async function setup() {
  const keys = await generateKeyPair("RS256");
  const jwk = {
    ...(await exportJWK(keys.publicKey)),
    kid: "test-key",
    use: "sig",
    alg: "RS256",
  };
  let keyFetches = 0;
  const authFetch: typeof fetch = async (input) => {
    expect(String(input)).toBe(issuer + "jwks");
    keyFetches++;
    return Response.json({ keys: [jwk] });
  };
  const server = await startServer(publicConfig(), { authFetch });
  cleanups.push(() => server.close());
  const jwt = async (
    claims: Record<string, unknown> = {},
    signingKey = keys.privateKey,
  ) =>
    new SignJWT({ scope: "exec", ...claims })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(typeof claims.iss === "string" ? claims.iss : issuer)
      .setAudience(
        typeof claims.aud === "string" ? claims.aud : origin + "/mcp",
      )
      .setSubject(typeof claims.sub === "string" ? claims.sub : subject)
      .setExpirationTime(typeof claims.exp === "number" ? claims.exp : "5m")
      .sign(signingKey);
  return { ...server, jwt, keyFetches: () => keyFetches, keys };
}
async function client(url: string, accessToken: string, legacy = false) {
  const value = new Client(
    { name: "public-ingress-test", version: "1" },
    { versionNegotiation: { mode: legacy ? "legacy" : "auto" } },
  );
  cleanups.push(() => value.close());
  await value.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
    }),
  );
  return value;
}
async function directory() {
  const dir = await realpath(
    await mkdtemp(path.join(tmpdir(), "exec-public-")),
  );
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

describe("public ingress configuration", () => {
  it("requires explicit public URL and auth, never downgrades an invalid public deployment", () => {
    for (const addition of [
      "",
      '[auth]\ntype="bearer"\n',
      '[server]\npublic_url="https://x.example"\n',
    ]) {
      const source =
        CONFIG_TEMPLATE.replace(
          'access = "openai-tunnel"',
          'access = "public"',
        ) + addition;
      expect(() => parseConfig(source, "config.toml")).toThrow();
    }
    expect(() =>
      parseConfig(CONFIG_TEMPLATE + '\n[auth]\ntype="bearer"\n', "config.toml"),
    ).toThrow("私有模式");
    for (const url of [
      "http://example.test",
      "https://user:secret@example.test",
      "https://example.test/mcp",
      "https://example.test/?secret=x",
    ]) {
      const config =
        CONFIG_TEMPLATE.replace(
          'access = "openai-tunnel"',
          `access = "public"\npublic_url=${JSON.stringify(url)}`,
        ) + '\n[auth]\ntype="bearer"\n';
      expect(() => parseConfig(config, "config.toml")).toThrow();
    }
  });
  it("parses both providers, normalizes the public origin and resolves only local file paths", () => {
    const file = path.join(tmpdir(), "configs", "config.toml");
    const base =
      CONFIG_TEMPLATE.replace(
        'access = "openai-tunnel"',
        'access = "public"\npublic_url="https://node.tailnet.ts.net:8443/"',
      ) + '\n[auth]\ntype="bearer"\n';
    expect(
      parseConfig(base + '\n[tunnel]\nprovider="tailscale"\n', file),
    ).toMatchObject({
      access: "public",
      public_url: "https://node.tailnet.ts.net:8443",
      auth: { type: "bearer", token_env: "EXEC_MCP_ACCESS_TOKEN" },
      tunnel: { provider: "tailscale" },
    });
    const cloudflare = parseConfig(
      base +
        '\n[tunnel]\nprovider="cloudflare"\ntoken_file="./token"\nexecutable="./bin/cloudflared"\n',
      file,
    );
    expect(cloudflare.tunnel).toEqual({
      provider: "cloudflare",
      token_file: path.resolve(path.dirname(file), "token"),
      executable: path.resolve(path.dirname(file), "bin/cloudflared"),
    });
    expect(() =>
      parseConfig(
        base.replace(":8443", ":9000") + '\n[tunnel]\nprovider="tailscale"\n',
        file,
      ),
    ).toThrow("443/8443/10000");
    expect(() =>
      parseConfig(
        base.replace("node.tailnet.ts.net:8443", "random.example") +
          '\n[tunnel]\nprovider="tailscale"\n',
        file,
      ),
    ).toThrow("本节点");
  });
  it("does not admit weak or absent bearer credentials, including for direct programmatic startup", async () => {
    const config: Config = {
      ...publicConfig(),
      auth: { type: "bearer", token_env: tokenName },
    };
    delete process.env[tokenName];
    await expect(startServer(config)).rejects.toThrow("至少 32");
    process.env[tokenName] = "short";
    await expect(startServer(config)).rejects.toThrow("至少 32");
    await expect(
      startServer({ ...config, auth: undefined } as unknown as Config),
    ).rejects.toThrow("认证");
  });
});

describe("OAuth resource server", () => {
  it("advertises canonical resource discovery without trusting forwarded hosts", async () => {
    const service = await setup();
    const denied = await fetch(service.url, {
      headers: {
        "X-Forwarded-Host": "attacker.example",
        "X-Forwarded-Proto": "https",
      },
    });
    expect(denied.status).toBe(401);
    expect(denied.headers.get("www-authenticate")).toContain(
      origin + RESOURCE_METADATA_PATH,
    );
    expect(await denied.text()).not.toContain("attacker.example");
    expect(service.keyFetches()).toBe(0);
    for (const route of [
      RESOURCE_METADATA_PATH,
      "/.well-known/oauth-protected-resource",
    ]) {
      const metadata = await fetch(service.url.replace("/mcp", route), {
        headers: { Host: "exec.example.test" },
      });
      expect(metadata.status).toBe(200);
      expect(await metadata.json()).toEqual({
        resource: origin + "/mcp",
        authorization_servers: [issuer],
        scopes_supported: scopes,
        bearer_methods_supported: ["header"],
        resource_name: "Exec MCP",
      });
    }
  });
  it("validates signature, expiry, issuer, audience and subject before accessing any tools", async () => {
    const service = await setup();
    const otherKeys = await generateKeyPair("RS256");
    const invalid = [
      "not-a-jwt",
      await service.jwt({ exp: Math.floor(Date.now() / 1000) - 60 }),
      await service.jwt({ nbf: Math.floor(Date.now() / 1000) + 300 }),
      await service.jwt({ iss: "https://other.example/" }),
      await service.jwt({ aud: "https://other.example/mcp" }),
      await service.jwt({}, otherKeys.privateKey),
    ];
    for (const jwt of invalid) {
      const response = await fetch(service.url, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + jwt,
          "Content-Type": "application/json",
        },
        body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
      });
      expect(response.status).toBe(401);
      expect(await response.text()).toBe('{"error":"unauthorized"}');
    }
    for (const claims of [{ sub: "different-user" }, { scope: "read-only" }]) {
      const response = await fetch(service.url, {
        headers: { Authorization: "Bearer " + (await service.jwt(claims)) },
      });
      expect(response.status).toBe(403);
      if (claims.scope)
        expect(response.headers.get("www-authenticate")).toContain(
          'error="insufficient_scope"',
        );
    }
    expect(service.keyFetches()).toBe(1);
  });
  it("rejects missing expiry and symmetric or unsigned tokens", async () => {
    const service = await setup();
    const missingExp = await new SignJWT({
      scope: "exec",
      sub: subject,
      iss: issuer,
      aud: origin + "/mcp",
    })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .sign(service.keys.privateKey);
    const hmac = await new SignJWT({
      scope: "exec",
      sub: subject,
      iss: issuer,
      aud: origin + "/mcp",
    })
      .setProtectedHeader({ alg: "HS256", kid: "test-key" })
      .setExpirationTime("5m")
      .sign(new Uint8Array(32));
    for (const value of [missingExp, hmac])
      expect(
        (
          await fetch(service.url, {
            headers: { Authorization: "Bearer " + value },
          })
        ).status,
      ).toBe(401);
  });
  it("does not trust Cloudflare/Tailscale identity headers or a stolen legacy session ID without a token", async () => {
    const service = await setup();
    const response = await fetch(service.url, {
      headers: {
        "Cf-Access-Jwt-Assertion": await service.jwt(),
        "Tailscale-User-Login": "owner@example.test",
        "mcp-session-id": "pretend-owned-session",
        "X-Forwarded-For": "127.0.0.1",
      },
    });
    expect(response.status).toBe(401);
    expect(service.keyFetches()).toBe(0);
  });
  it("rejects hostile Host/Origin even with a valid credential and does not accept query-string tokens", async () => {
    const service = await setup();
    const jwt = await service.jwt();
    for (const headers of [
      { Host: "evil.example" },
      { Origin: "https://evil.example" },
      { Origin: "null" },
    ]) {
      // fetch implementations may normalize/ignore Host; test the actual HTTP header.
      const status = await new Promise<number>((resolve, reject) => {
        const request = httpRequest(
          service.url,
          { headers: { Authorization: "Bearer " + jwt, ...headers } },
          (response) => {
            response.resume();
            resolve(response.statusCode!);
          },
        );
        request.once("error", reject);
        request.end();
      });
      expect(status).toBe(403);
    }
    expect((await fetch(service.url + "?access_token=" + jwt)).status).toBe(
      401,
    );
    const duplicate = await new Promise<number>((resolve) => {
      const req = httpRequest(
        service.url,
        {
          headers: [
            "Host",
            "exec.example.test",
            "Authorization",
            "Bearer " + jwt,
            "Authorization",
            "Bearer " + jwt,
          ],
        },
        (response) => {
          response.resume();
          resolve(response.statusCode!);
        },
      );
      req.end();
    });
    expect(duplicate).toBe(403);
  });
  it("denies requests while the provider is unavailable without exposing its error", async () => {
    const service = await startServer(publicConfig(), {
      authFetch: async () => {
        throw new Error("PRIVATE_NETWORK_ERROR");
      },
    });
    cleanups.push(() => service.close());
    const keys = await generateKeyPair("RS256");
    const jwt = await new SignJWT({ sub: subject, scope: "exec" })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(issuer)
      .setAudience(origin + "/mcp")
      .setExpirationTime("5m")
      .sign(keys.privateKey);
    const response = await fetch(service.url, {
      headers: { Authorization: "Bearer " + jwt },
    });
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain("PRIVATE_NETWORK_ERROR");
  });
});

describe.each([false, true])(
  "authenticated actual MCP (legacy=%s)",
  (legacy) => {
    it.each([false, true])(
      "works behind a streaming reverse proxy (rewrite Host=%s) without trusting its identity headers",
      async (rewriteHost) => {
        const service = await setup();
        const target = new URL(service.url);
        const sockets = new Set<Socket>();
        const proxy = createServer((request, response) => {
          const upstream = httpRequest(
            new URL(request.url ?? "/", target.origin),
            {
              method: request.method,
              headers: {
                ...request.headers,
                host: rewriteHost ? target.host : "exec.example.test",
                "x-forwarded-host": "untrusted.example",
                "x-forwarded-proto": "https",
              },
            },
            (result) => {
              response.writeHead(result.statusCode!, result.headers);
              result.pipe(response);
            },
          );
          upstream.on("error", () => response.destroy());
          response.once("close", () => upstream.destroy());
          request.pipe(upstream);
        });
        proxy.on("connection", (socket) => {
          sockets.add(socket);
          socket.once("close", () => sockets.delete(socket));
        });
        await new Promise<void>((resolve) =>
          proxy.listen(0, "127.0.0.1", resolve),
        );
        cleanups.push(
          () =>
            new Promise<void>((resolve) => {
              proxy.close(() => resolve());
              for (const socket of sockets) socket.destroy();
            }),
        );
        const url = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}/mcp`;
        expect((await fetch(url)).status).toBe(401);
        const connection = await client(url, await service.jwt(), legacy);
        const result = await connection.callTool({
          name: "exec",
          arguments: {
            source:
              'text("through-proxy");yield_control();await new Promise(r=>setTimeout(r,60));text(42);',
          },
        });
        const final = await connection.callTool({
          name: "wait",
          arguments: { cell_id: cellId(result) },
        });
        expect(final.isError).not.toBe(true);
        expect(jsonOutput(final)).toBe(42);
      },
    );
    it("executes, waits and reads native file resources for the configured operator", async () => {
      const service = await setup();
      const connection = await client(service.url, await service.jwt(), legacy);
      const tools = (await connection.listTools()).tools;
      expect(tools.map((tool) => tool.name)).toEqual(TOP_LEVEL_TOOL_NAMES);
      expect(
        tools.every((tool) =>
          JSON.stringify(tool._meta).includes('"type":"oauth2"'),
        ),
      ).toBe(true);
      const started = await connection.callTool({
        name: "exec",
        arguments: {
          source:
            'text("start");yield_control();await new Promise(r=>setTimeout(r,80));text("done");',
        },
        _meta: { "openai/session": "public-conversation" },
      });
      const ended = await connection.callTool({
        name: "wait",
        arguments: { cell_id: cellId(started) },
        _meta: { "openai/session": "public-conversation" },
      });
      expect(ended.isError).not.toBe(true);
      expect(texts(ended)).toContain("done");
      const dir = await directory();
      await writeFile(path.join(dir, "report.txt"), "private result");
      const exported = await connection.callTool({
        name: "exec",
        arguments: {
          workdir: dir,
          source: 'await tools.export_file({path:"report.txt"});',
        },
        _meta: { "openai/session": "public-conversation" },
      });
      const resource = exported.content.find(
        (block) => block.type === "resource_link",
      );
      expect(resource?.type).toBe("resource_link");
      if (resource?.type !== "resource_link")
        throw new Error("missing resource");
      const read = await connection.readResource({
        uri: resource.uri,
        _meta: { "openai/session": "public-conversation" },
      });
      expect(
        Buffer.from(
          (read.contents[0] as { blob: string }).blob,
          "base64",
        ).toString(),
      ).toBe("private result");
      const denied = await fetch(service.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 7,
          method: "resources/read",
          params: { uri: resource.uri },
        }),
      });
      expect(denied.status).toBe(401);
    });
    it("supports explicit bearer clients without pretending to offer OAuth discovery", async () => {
      process.env[tokenName] = token;
      const service = await startServer({
        ...publicConfig(),
        auth: { type: "bearer", token_env: tokenName },
      });
      cleanups.push(() => service.close());
      expect((await fetch(service.url)).status).toBe(401);
      expect(
        (await fetch(service.url.replace("/mcp", RESOURCE_METADATA_PATH)))
          .status,
      ).toBe(404);
      const connection = await client(service.url, token, legacy);
      const output = await connection.callTool({
        name: "exec",
        arguments: { source: "text(6*7);" },
      });
      expect(jsonOutput(output)).toBe(42);
      expect(
        JSON.stringify((await connection.listTools()).tools),
      ).not.toContain(token);
      expect(
        (
          await fetch(service.url, {
            headers: { Authorization: "Bearer " + token + "wrong" },
          })
        ).status,
      ).toBe(401);
    });
  },
);
import { TOP_LEVEL_TOOL_NAMES } from "../src/tool-names.js";

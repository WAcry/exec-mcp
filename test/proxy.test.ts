import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EnvironmentHttpClient } from "../src/network/http.js";
import { ProxyFixtures } from "./proxy-fixtures.js";

let fixtures: ProxyFixtures;
const clients: EnvironmentHttpClient[] = [];
beforeEach(() => {
  fixtures = new ProxyFixtures();
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await fixtures.close();
});
function client(environment: Record<string, string> = {}) {
  const value = new EnvironmentHttpClient(environment);
  clients.push(value);
  return value;
}

describe("HTTP proxy environment without version-dependent global Node flags", () => {
  it("uses HTTP_PROXY and does not send proxy credentials to the destination", async () => {
    const received: Record<string, unknown>[] = [];
    const origin = await fixtures.server((request, response) => {
      received.push({
        method: request.method,
        path: request.url,
        auth: request.headers.authorization,
        proxyAuth: request.headers["proxy-authorization"],
      });
      response.end("proxied");
    });
    const auth = `Basic ${Buffer.from("fixture-user:fixture-password").toString("base64")}`;
    const proxy = await fixtures.proxy(() => origin.port, {
      authorization: auth,
    });
    const url = new URL(proxy.url);
    url.username = "fixture-user";
    url.password = "fixture-password";
    const network = client({ HTTP_PROXY: url.href });
    const response = await network.fetch(
      "http://unresolvable.example.test/service",
      {
        method: "POST",
        headers: { Authorization: "Bearer destination-fixture" },
        body: "payload",
      },
    );
    expect(await response.text()).toBe("proxied");
    expect(proxy.calls).toEqual([
      { authority: "unresolvable.example.test:80", authorization: auth },
    ]);
    expect(received).toEqual([
      {
        method: "POST",
        path: "/service",
        auth: "Bearer destination-fixture",
        proxyAuth: undefined,
      },
    ]);
  });
  it("gives lowercase settings precedence and leaves global fetch/agents untouched", async () => {
    const origin = await fixtures.server((_request, response) =>
      response.end("ok"),
    );
    const lower = await fixtures.proxy(() => origin.port),
      upper = await fixtures.proxy(() => origin.port);
    const fetch = globalThis.fetch;
    const network = client({ http_proxy: lower.url, HTTP_PROXY: upper.url });
    expect(
      await (
        await network.fetch("http://proxy-precedence.example.test/")
      ).text(),
    ).toBe("ok");
    expect(lower.calls).toHaveLength(1);
    expect(upper.calls).toHaveLength(0);
    expect(globalThis.fetch).toBe(fetch);
  });
  it.each(["127.0.0.1", "*"])(
    "honors NO_PROXY=%s for direct requests",
    async (noProxy) => {
      const origin = await fixtures.server((_request, response) =>
        response.end("direct"),
      );
      const proxy = await fixtures.proxy(() => origin.port, { reject: true });
      const network = client({ HTTP_PROXY: proxy.url, NO_PROXY: noProxy });
      expect(await (await network.fetch(origin.url)).text()).toBe("direct");
      expect(proxy.calls).toHaveLength(0);
    },
  );
  it("honors port-qualified NO_PROXY and lowercase bypass precedence", async () => {
    const origin = await fixtures.server((_request, response) =>
      response.end("ok"),
    );
    const proxy = await fixtures.proxy(() => origin.port);
    const bypass = client({
      HTTP_PROXY: proxy.url,
      no_proxy: `127.0.0.1:${origin.port}`,
      NO_PROXY: "different.example.test",
    });
    expect(await (await bypass.fetch(origin.url)).text()).toBe("ok");
    expect(proxy.calls).toHaveLength(0);
    const routed = client({ HTTP_PROXY: proxy.url, NO_PROXY: "127.0.0.1:1" });
    expect(await (await routed.fetch(origin.url)).text()).toBe("ok");
    expect(proxy.calls).toHaveLength(1);
  });
  it("honors a domain suffix bypass without sending the request to the proxy", async () => {
    const origin = await fixtures.server((_request, response) =>
      response.end("domain-direct"),
    );
    const proxy = await fixtures.proxy(() => origin.port, { reject: true });
    const network = new EnvironmentHttpClient(
      { HTTP_PROXY: proxy.url, NO_PROXY: ".fixture.test" },
      {
        directLookup: (_host, options, callback) =>
          options.all
            ? callback(null, [{ address: "127.0.0.1", family: 4 }])
            : callback(null, "127.0.0.1", 4),
      },
    );
    clients.push(network);
    expect(
      await (
        await network.fetch(`http://sub.fixture.test:${origin.port}/`)
      ).text(),
    ).toBe("domain-direct");
    expect(proxy.calls).toHaveLength(0);
  });
  it("does not silently retry the origin directly after a proxy refuses the request", async () => {
    let hits = 0;
    const origin = await fixtures.server((_request, response) => {
      hits++;
      response.end("must not reach");
    });
    const proxy = await fixtures.proxy(() => origin.port, { reject: true });
    const network = client({ HTTP_PROXY: proxy.url });
    await expect(network.fetch(origin.url)).rejects.toThrow();
    expect(proxy.calls).toHaveLength(1);
    expect(hits).toBe(0);
  });
  it("cancels an unfinished proxy request and closes the owned transport", async () => {
    const proxy = await fixtures.proxy(() => 1, { stall: true });
    const network = client({ HTTP_PROXY: proxy.url });
    const abort = new AbortController();
    const pending = network.fetch("http://pending.example.test/", {
      signal: abort.signal,
    });
    const checked = expect(pending).rejects.toThrow();
    const deadline = Date.now() + 3000;
    while (!proxy.calls.length && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(proxy.calls).toHaveLength(1);
    abort.abort();
    await checked;
    await network.close();
    await expect(network.fetch("http://pending.example.test/")).rejects.toThrow(
      "关闭",
    );
  });
  it("reports invalid proxy configuration without echoing credentials", () => {
    expect(() =>
      client({ HTTPS_PROXY: "not a URL with PRIVATE_PROXY_PASSWORD" }),
    ).toThrow("代理配置无效");
    let error = "";
    try {
      client({ HTTPS_PROXY: "not a URL with PRIVATE_PROXY_PASSWORD" });
    } catch (caught) {
      error = String(caught);
    }
    expect(error).not.toContain("PRIVATE_PROXY_PASSWORD");
  });
});

describe("real TLS through environment proxies", () => {
  it.each([false, true])(
    "supports an HTTPS destination through a proxy (TLS proxy=%s), preserving TLS validation",
    async (tls) => {
      const origin = await fixtures.server(
        (_request, response) => response.end("secure fixture"),
        true,
      );
      const unused = await fixtures.proxy(() => origin.port, { reject: true });
      const proxy = await fixtures.proxy(
        (authority) => {
          expect(authority).toBe("files.example.test:443");
          return origin.port;
        },
        { tls },
      );
      const run = await fixtures.child(
        `
      import {EnvironmentHttpClient} from './src/network/http.ts';
      const client = new EnvironmentHttpClient();
      try { const result = await client.fetch('https://files.example.test/data');console.log(JSON.stringify({status:result.status,body:await result.text()})); }
      finally { await client.close(); }
    `,
        { HTTP_PROXY: unused.url, HTTPS_PROXY: proxy.url },
      );
      expect(JSON.parse(run.stdout)).toEqual({
        status: 200,
        body: "secure fixture",
      });
      expect(proxy.calls).toHaveLength(1);
      expect(unused.calls).toHaveLength(0);
    },
  );
  it("uses HTTP_PROXY for HTTPS when HTTPS_PROXY is absent, and respects no_proxy for TLS", async () => {
    const origin = await fixtures.server(
      (_request, response) => response.end("secure"),
      true,
    );
    const proxy = await fixtures.proxy(() => origin.port);
    const source = `import {EnvironmentHttpClient} from './src/network/http.ts';const client=new EnvironmentHttpClient();try{console.log(await (await client.fetch(${JSON.stringify(origin.url)})).text());}finally{await client.close();}`;
    expect(
      (await fixtures.child(source, { HTTP_PROXY: proxy.url })).stdout.trim(),
    ).toBe("secure");
    expect(proxy.calls).toHaveLength(1);
    expect(
      (
        await fixtures.child(source, {
          HTTP_PROXY: proxy.url,
          no_proxy: "127.0.0.1",
          NO_PROXY: "ignored.example.test",
        })
      ).stdout.trim(),
    ).toBe("secure");
    expect(proxy.calls).toHaveLength(1);
  });
  it("does not disable certificate checks when the destination certificate does not match", async () => {
    const origin = await fixtures.server(
      (_request, response) => response.end("wrong host"),
      true,
    );
    const proxy = await fixtures.proxy(() => origin.port);
    const run = await fixtures.child(
      `
      import {EnvironmentHttpClient} from './src/network/http.ts';const client=new EnvironmentHttpClient();
      try{await client.fetch('https://wrong-name.example.test/');console.log('unexpected');}
      catch{console.log('certificate-rejected');}finally{await client.close();}
    `,
      { HTTPS_PROXY: proxy.url },
    );
    expect(run.stdout.trim()).toBe("certificate-rejected");
  });
});

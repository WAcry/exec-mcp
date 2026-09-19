import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const network = vi.hoisted(() => ({
  lookup: vi.fn(),
  get: vi.fn(),
  close: vi.fn(),
  constructed: vi.fn(),
}));
vi.mock("node:dns/promises", () => ({ lookup: network.lookup }));
vi.mock("../src/network/http.js", () => ({
  EnvironmentHttpClient: class {
    constructor(...args: unknown[]) {
      network.constructed(...args);
    }
    get = network.get;
    close = network.close;
  },
}));
import { openDownload, publicLookup } from "../src/files/download.js";

let body: Readable;
beforeEach(() => {
  for (const mock of Object.values(network)) mock.mockReset();
  network.lookup.mockResolvedValue([
    { address: "8.8.8.8", family: 4 },
    { address: "2606:4700:4700::1111", family: 6 },
  ]);
  network.close.mockResolvedValue(undefined);
  network.get.mockImplementation(async () => ({
    statusCode: 200,
    headers: { "content-length": "10" },
    body: (body = Readable.from([Buffer.from("file bytes")])),
  }));
});
afterEach(() => {
  body?.destroy();
  vi.useRealTimers();
});
function resolvePublic(all: boolean) {
  return new Promise<unknown>((resolve, reject) =>
    publicLookup("files.example.test", { all }, (error, address, family) => {
      if (error) reject(error);
      else resolve(all ? address : { address, family });
    }),
  );
}

describe("host file transfer transport", () => {
  it("passes the real proxy environment and a validated direct DNS resolver, then releases sockets after reading", async () => {
    const url = "https://files.example.test/file?token=PRIVATE_SIGNED_URL";
    const signal = new AbortController().signal;
    const response = await openDownload(url, signal);
    expect(network.constructed).toHaveBeenCalledWith(process.env, {
      directLookup: publicLookup,
    });
    expect(network.get).toHaveBeenCalledWith(new URL(url), signal);
    expect(response.headers["content-length"]).toBe("10");
    expect(network.close).not.toHaveBeenCalled();
    let output = "";
    for await (const chunk of response) output += chunk.toString();
    expect(output).toBe("file bytes");
    expect(network.close).toHaveBeenCalled();
  });
  it("returns the direct resolver's verified addresses without doing a second lookup for the connection", async () => {
    expect(await resolvePublic(true)).toEqual([
      { address: "8.8.8.8", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ]);
    expect(network.lookup).toHaveBeenCalledTimes(1);
    expect(await resolvePublic(false)).toEqual({
      address: "8.8.8.8",
      family: 4,
    });
    expect(network.lookup).toHaveBeenCalledTimes(2);
  });
  it("rejects a direct mixed public/private DNS answer and sanitizes DNS errors", async () => {
    network.lookup.mockResolvedValue([
      { address: "8.8.8.8", family: 4 },
      { address: "192.168.1.1", family: 4 },
    ]);
    await expect(resolvePublic(true)).rejects.toThrow("私网");
    network.lookup.mockRejectedValue(
      new Error("INTERNAL_ERROR_WITH_PRIVATE_DATA"),
    );
    await expect(resolvePublic(true)).rejects.toThrow("无法解析宿主文件地址");
  });
  it("bounds stalled DNS lookups and ignores a late answer", async () => {
    vi.useFakeTimers();
    let complete!: (value: unknown) => void;
    network.lookup.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const callback = vi.fn();
    publicLookup("stalled.example.test", { all: true }, callback);
    await vi.advanceTimersByTimeAsync(5000);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0]![0].message).toContain("超时");
    complete([{ address: "8.8.8.8", family: 4 }]);
    await Promise.resolve();
    expect(callback).toHaveBeenCalledTimes(1);
  });
  it.each([301, 302, 307, 308, 401, 500])(
    "does not follow redirects or accept HTTP %s",
    async (statusCode) => {
      body = Readable.from([Buffer.from("rejected")]);
      network.get.mockResolvedValue({
        statusCode,
        body,
        headers: { location: "https://private.example.test" },
      });
      await expect(
        openDownload(
          "https://files.example.test/file",
          new AbortController().signal,
        ),
      ).rejects.toThrow(`HTTP ${statusCode}`);
      expect(network.get).toHaveBeenCalledTimes(1);
      expect(body.destroyed).toBe(true);
      expect(network.close).toHaveBeenCalled();
    },
  );
  it("keeps request and proxy errors out of returned messages and releases failed requests", async () => {
    network.get.mockRejectedValue(
      new Error(
        "https://user:PRIVATE_PROXY_PASSWORD@proxy.test/PRIVATE_SIGNED_URL",
      ),
    );
    let message = "";
    try {
      await openDownload(
        "https://files.example.test/file",
        new AbortController().signal,
      );
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain("代理凭据未回显");
    expect(message).not.toMatch(/PRIVATE_PROXY_PASSWORD|PRIVATE_SIGNED_URL/);
    expect(network.close).toHaveBeenCalled();
  });
  it("rejects transparent compression and cancels unread streams", async () => {
    body = new Readable({ read() {} });
    network.get.mockResolvedValue({
      statusCode: 200,
      body,
      headers: { "content-encoding": "gzip" },
    });
    await expect(
      openDownload(
        "https://files.example.test/file",
        new AbortController().signal,
      ),
    ).rejects.toThrow("下载被拒绝");
    expect(body.destroyed).toBe(true);
    network.get.mockImplementation(async () => ({
      statusCode: 200,
      headers: {},
      body: (body = new Readable({ read() {} })),
    }));
    const result = await openDownload(
      "https://files.example.test/file",
      new AbortController().signal,
    );
    result.destroy();
    await new Promise((resolve) => setImmediate(resolve));
    expect(network.close).toHaveBeenCalled();
  });
  it("does not create a network client for a pre-cancelled download", async () => {
    await expect(
      openDownload("https://files.example.test/file", AbortSignal.abort()),
    ).rejects.toThrow();
    expect(network.constructed).not.toHaveBeenCalled();
  });
});

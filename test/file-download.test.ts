import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { IncomingMessage, RequestOptions } from "node:http";
import type { LookupOptions } from "node:dns";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const network = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: network.lookup }));
vi.mock("node:https", () => ({ request: network.request }));
import { openDownload } from "../src/files/download.js";

let status: number;
let encoding: string | undefined;
let failConnection: boolean;
let receivedOptions: RequestOptions;
let body: IncomingMessage;
beforeEach(() => {
  network.lookup.mockReset();
  network.request.mockReset();
  network.lookup.mockResolvedValue([
    { address: "8.8.8.8", family: 4 },
    { address: "2606:4700:4700::1111", family: 6 },
  ]);
  status = 200;
  encoding = undefined;
  failConnection = false;
  network.request.mockImplementation(
    (
      _url: URL,
      options: RequestOptions,
      done: (response: IncomingMessage) => void,
    ) => {
      receivedOptions = options;
      const req = new EventEmitter() as EventEmitter & { end(): void };
      req.end = () =>
        queueMicrotask(() => {
          if (failConnection) {
            req.emit("error", new Error("PRIVATE_SIGNED_URL"));
            return;
          }
          body = Readable.from([Buffer.from("file bytes")]) as IncomingMessage;
          body.statusCode = status;
          body.headers = {
            ...(encoding ? { "content-encoding": encoding } : {}),
            location: "https://127.0.0.1/private",
          };
          done(body);
        });
      return req;
    },
  );
});
afterEach(() => {
  body?.destroy();
});

describe("host file HTTPS transport", () => {
  it("uses the validated DNS snapshot and original TLS hostname without a second resolver lookup", async () => {
    const response = await openDownload(
      "https://files.example.test/file?token=PRIVATE_SIGNED_URL",
      new AbortController().signal,
    );
    expect(response.statusCode).toBe(200);
    expect(network.lookup).toHaveBeenCalledTimes(1);
    expect(network.request.mock.calls[0]![0].hostname).toBe(
      "files.example.test",
    );
    expect(receivedOptions).toMatchObject({
      agent: false,
      method: "GET",
      headers: { "Accept-Encoding": "identity" },
    });
    network.lookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    const callLookup = receivedOptions.lookup as unknown as (
      hostname: string,
      options: LookupOptions,
      callback: (
        error: Error | null,
        address: unknown,
        family?: number,
      ) => void,
    ) => void;
    const addresses = await new Promise((resolve) =>
      callLookup("files.example.test", { all: true }, (_error, result) =>
        resolve(result),
      ),
    );
    expect(addresses).toEqual([
      { address: "8.8.8.8", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ]);
    const first = await new Promise((resolve) =>
      callLookup("files.example.test", {}, (_error, address, family) =>
        resolve({ address, family }),
      ),
    );
    expect(first).toEqual({ address: "8.8.8.8", family: 4 });
    expect(network.lookup).toHaveBeenCalledTimes(1);
  });
  it("rejects a mixed public/private DNS answer before any network connection", async () => {
    network.lookup.mockResolvedValue([
      { address: "8.8.8.8", family: 4 },
      { address: "192.168.1.1", family: 4 },
    ]);
    await expect(
      openDownload(
        "https://files.example.test/file",
        new AbortController().signal,
      ),
    ).rejects.toThrow("私网");
    expect(network.request).not.toHaveBeenCalled();
  });
  it.each([301, 302, 307, 308, 401, 500])(
    "does not follow redirects or accept HTTP %s",
    async (code) => {
      status = code;
      await expect(
        openDownload(
          "https://files.example.test/file",
          new AbortController().signal,
        ),
      ).rejects.toThrow(`HTTP ${code}`);
      expect(network.request).toHaveBeenCalledTimes(1);
      expect(body.destroyed).toBe(true);
    },
  );
  it("does not expose request errors or accept transparently compressed file contents", async () => {
    failConnection = true;
    await expect(
      openDownload(
        "https://files.example.test/file",
        new AbortController().signal,
      ),
    ).rejects.toThrow("下载凭据未回显");
    failConnection = false;
    encoding = "gzip";
    await expect(
      openDownload(
        "https://files.example.test/file",
        new AbortController().signal,
      ),
    ).rejects.toThrow("下载被拒绝");
    expect(body.destroyed).toBe(true);
  });
  it("can cancel a stalled DNS lookup without opening a connection", async () => {
    const abort = new AbortController();
    network.lookup.mockImplementation(() => new Promise(() => {}));
    const pending = openDownload(
      "https://files.example.test/file",
      abort.signal,
    );
    abort.abort();
    await expect(pending).rejects.toThrow("取消或超时");
    expect(network.request).not.toHaveBeenCalled();
  });
});

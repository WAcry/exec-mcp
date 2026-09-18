import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { pipeline } from "node:stream/promises";
import type { ArtifactStore } from "./artifacts.js";

/** 与有执行权限的 MCP 入口分离；这里只接受显式导出的限时 bearer URL。 */
export async function startDownloadGateway(
  store: ArtifactStore,
): Promise<{ address: string; close(): Promise<void> }> {
  const config = store.config.download;
  if (!config) throw new Error("未配置下载入口。");
  const base = new URL(config.base_url);
  const prefix = base.pathname.replace(/\/+$/, "") + "/";
  let closing: Promise<void> | undefined;
  const server = createServer((request, response) => {
    const host = request.headers.host;
    const bound = server.address() as AddressInfo | null;
    if (
      closing ||
      ![base.host, `127.0.0.1:${bound?.port}`].includes(host ?? "")
    ) {
      fail(response, 404);
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("Allow", "GET, HEAD");
      fail(response, 405);
      return;
    }
    const abort = new AbortController();
    const disconnected = () => {
      if (!response.writableFinished) abort.abort();
    };
    response.once("close", disconnected);
    void (async () => {
      try {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        if (url.search || !url.pathname.startsWith(prefix))
          throw new Error("not found");
        const segments = url.pathname.slice(prefix.length).split("/");
        if (segments.length !== 2 || !/^[A-Za-z0-9_-]{43}$/.test(segments[0]!))
          throw new Error("not found");
        await store.withDownload(
          segments[0]!,
          decodeURIComponent(segments[1]!),
          async (handle, info, signal) => {
            const etag = `"sha256-${info.sha256}"`;
            const range =
              request.headers.range &&
              (!request.headers["if-range"] ||
                request.headers["if-range"] === etag)
                ? parseRange(request.headers.range, info.size)
                : undefined;
            if (range === null) {
              response.setHeader("Content-Range", `bytes */${info.size}`);
              fail(response, 416);
              return;
            }
            response.setHeader("Content-Type", info.mime_type);
            response.setHeader(
              "Content-Disposition",
              `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(info.name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`,
            );
            response.setHeader("X-Content-Type-Options", "nosniff");
            response.setHeader(
              "Content-Security-Policy",
              "default-src 'none'; sandbox",
            );
            response.setHeader("Cache-Control", "private, no-store");
            response.setHeader("Referrer-Policy", "no-referrer");
            response.setHeader("Accept-Ranges", "bytes");
            response.setHeader("ETag", etag);
            const start = range?.start ?? 0;
            const end = range?.end ?? info.size - 1;
            response.statusCode = range ? 206 : 200;
            response.setHeader("Content-Length", Math.max(0, end - start + 1));
            if (range)
              response.setHeader(
                "Content-Range",
                `bytes ${start}-${end}/${info.size}`,
              );
            if (request.method === "HEAD" || info.size === 0) {
              response.end();
              return;
            }
            await pipeline(
              handle.createReadStream({ autoClose: false, start, end }),
              response,
              { signal },
            );
          },
          abort.signal,
        );
      } catch {
        if (response.headersSent) response.destroy();
        else if (!response.destroyed) fail(response, 404);
      } finally {
        response.removeListener("close", disconnected);
      }
    })();
  });
  server.headersTimeout = 15000;
  server.requestTimeout = 30000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  return {
    address: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close() {
      closing ??= new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
      return closing;
    },
  };
}

export function parseRange(
  value: string,
  size: number,
): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2]) || size === 0) return null;
  const left = match[1] ? Number(match[1]) : undefined;
  const right = match[2] ? Number(match[2]) : undefined;
  if (
    (left !== undefined && !Number.isSafeInteger(left)) ||
    (right !== undefined && !Number.isSafeInteger(right))
  )
    return null;
  const start = left ?? Math.max(0, size - (right ?? 0));
  const end =
    left === undefined ? size - 1 : Math.min(right ?? size - 1, size - 1);
  return start >= size || start > end ? null : { start, end };
}
function fail(response: ServerResponse, status: number): void {
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end("下载不存在、已过期或请求无效。");
}

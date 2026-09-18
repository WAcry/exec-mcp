import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from "@modelcontextprotocol/node";
import {
  createMcpHandler,
  isLegacyRequest,
} from "@modelcontextprotocol/server";
import type { Config } from "./config.js";
import { ExecRuntime } from "./runtime.js";
import { LegacySessionRouter } from "./http/legacy.js";
import { MAX_PAYLOAD_BYTES } from "./limits.js";
import { startDownloadGateway } from "./files/gateway.js";
import type { ArtifactStore } from "./files/artifacts.js";

export async function startServer(
  config: Config,
  options: { artifacts?: ArtifactStore } = {},
): Promise<{
  url: string;
  downloadAddress?: string;
  runtime: ExecRuntime;
  close(): Promise<void>;
}> {
  if (
    !["127.0.0.1", "::1"].includes(config.host) ||
    config.access !== "openai-tunnel"
  )
    throw new Error("首版只允许明确配置的 OpenAI 私有 Tunnel 与本机回环入口。");
  const runtime = new ExecRuntime(config, options.artifacts);
  let downloads: Awaited<ReturnType<typeof startDownloadGateway>> | undefined;
  try {
    if (runtime.artifacts.config.download)
      downloads = await startDownloadGateway(runtime.artifacts);
  } catch (error) {
    await runtime.close();
    throw error;
  }
  const onerror = (): void => {
    // Never print SDK error payloads: they may include credentials or user input.
    console.error("MCP 传输出现异常；检查客户端连接与本机就绪状态。");
  };
  const modern = createMcpHandler(() => runtime.server(), {
    legacy: "reject",
    responseMode: "auto",
    onerror,
  });
  const legacy = new LegacySessionRouter(() => runtime.server(), onerror, {
    idleMs: 24 * 60 * 60 * 1000,
    sweepMs: 60 * 60 * 1000,
  });
  const handler = toNodeHandler(
    {
      fetch: async (request, options) =>
        (await isLegacyRequest(request, options?.parsedBody))
          ? legacy.fetch(request, options)
          : modern.fetch(request, options),
    },
    { onerror },
  );
  const host = localhostHostValidation();
  const origin = localhostOriginValidation();
  let closing: Promise<void> | undefined;
  const server = createServer((request, response) => {
    if (!host(request, response) || !origin(request, response)) return;
    const route = request.url?.split("?")[0];
    if (route === "/healthz" || route === "/readyz") {
      respond(response, closing ? 503 : 200, {
        status: closing ? "stopping" : "ready",
      });
      return;
    }
    if (route !== "/mcp") {
      respond(response, 404, { error: "not_found" });
      return;
    }
    if (closing) {
      respond(response, 503, { error: "stopping" });
      return;
    }
    void (async () => {
      try {
        if (request.method === "POST") {
          const parsedBody = await readBody(request);
          await handler(
            request as Parameters<typeof handler>[0],
            response,
            parsedBody,
          );
        } else
          await handler(request as Parameters<typeof handler>[0], response);
      } catch (error) {
        if (!response.headersSent && !response.destroyed)
          respond(response, error instanceof BodyTooLarge ? 413 : 400, {
            error:
              error instanceof BodyTooLarge
                ? "payload_too_large"
                : "invalid_request",
          });
        else response.end();
      }
    })();
  });
  server.requestTimeout = 120_000;
  server.headersTimeout = 15_000;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, config.host, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
  } catch (error) {
    await Promise.allSettled([
      modern.close(),
      legacy.close(),
      runtime.close(),
      downloads?.close(),
    ]);
    throw error;
  }
  const address = server.address() as AddressInfo;
  return {
    url: `http://${config.host === "::1" ? "[::1]" : config.host}:${address.port}/mcp`,
    runtime,
    ...(downloads === undefined ? {} : { downloadAddress: downloads.address }),
    close() {
      closing ??= (async () => {
        const stopped = new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        const results = await Promise.allSettled([
          modern.close(),
          legacy.close(),
          runtime.close(),
          downloads?.close(),
        ]);
        server.closeAllConnections();
        await stopped;
        if (results.some((result) => result.status === "rejected"))
          throw new Error("部分服务清理失败。");
      })();
      return closing;
    },
  };
}
class BodyTooLarge extends Error {}
async function readBody(request: IncomingMessage): Promise<unknown> {
  if (Number(request.headers["content-length"] ?? 0) > MAX_PAYLOAD_BYTES) {
    request.resume();
    throw new BodyTooLarge();
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_PAYLOAD_BYTES) throw new BodyTooLarge();
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function respond(
  response: ServerResponse,
  status: number,
  body: Record<string, string>,
): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

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
import { ProtocolCounter } from "./http/protocol-stats.js";
import { MAX_PAYLOAD_BYTES } from "./limits.js";
import { startDownloadGateway } from "./files/gateway.js";
import type { ArtifactStore } from "./files/artifacts.js";
import {
  PublicAccess,
  RESOURCE_METADATA_PATH,
  publicHeadersAllowed,
} from "./http/access.js";
import { validatePublicAccess } from "./http/access-config.js";

import type { ActivityStore } from "./web/activity.js";
import type { SessionNotes } from "./session-notes.js";
import type { DownstreamStartupEvent } from "./downstream/registry.js";

export async function startServer(
  config: Config,
  options: {
    artifacts?: ArtifactStore;
    authFetch?: typeof fetch;
    activity?: ActivityStore;
    notes?: SessionNotes;
    /** Shared across execution-service restarts, so counts cover the whole process. */
    protocol?: ProtocolCounter;
    signal?: AbortSignal;
    onDownstreamProgress?: (event: DownstreamStartupEvent) => void;
  } = {},
): Promise<{
  url: string;
  downloadAddress?: string;
  runtime: ExecRuntime;
  protocol: ProtocolCounter;
  close(): Promise<void>;
}> {
  validatePublicAccess(config);
  options.signal?.throwIfAborted();
  const protocol = options.protocol ?? new ProtocolCounter();
  const access =
    config.access === "public"
      ? new PublicAccess(
          new URL(config.public_url!).origin,
          config.auth!,
          options.authFetch ? { fetch: options.authFetch } : {},
        )
      : undefined;
  let runtime: ExecRuntime;
  try {
    runtime = new ExecRuntime(
      config,
      options.artifacts,
      options.activity,
      options.notes,
    );
  } catch (error) {
    await access?.close();
    throw error;
  }
  let downloads: Awaited<ReturnType<typeof startDownloadGateway>> | undefined;
  try {
    // No MCP, Web or file-download listener is published with a partial catalog.
    await runtime.initialize(options.signal, options.onDownstreamProgress);
    options.signal?.throwIfAborted();
    if (runtime.artifacts.config.download)
      downloads = await startDownloadGateway(runtime.artifacts);
  } catch (error) {
    await Promise.allSettled([runtime.close(), access?.close()]);
    throw error;
  }
  const onerror = (): void => {
    // Never print SDK error payloads: they may include credentials or user input.
    console.error(
      "An MCP transport error occurred. Check the client connection and make sure that the local server is ready.",
    );
  };
  const modern = createMcpHandler(() => runtime.server(), {
    legacy: "reject",
    responseMode: "auto",
    onerror,
  });
  const legacy = new LegacySessionRouter(() => runtime.server(), onerror, {
    idleMs: 24 * 60 * 60 * 1000,
    sweepMs: 60 * 60 * 1000,
    events: {
      opened: () => protocol.sessionOpened(),
      closed: () => protocol.sessionClosed(),
    },
  });
  const handler = toNodeHandler(
    {
      fetch: async (request, options) => {
        const era = (await isLegacyRequest(request, options?.parsedBody))
          ? "legacy"
          : "modern";
        protocol.request(era);
        return era === "legacy"
          ? legacy.fetch(request, options)
          : modern.fetch(request, options);
      },
    },
    { onerror },
  );
  const host = localhostHostValidation();
  const origin = localhostOriginValidation();
  let closing: Promise<void> | undefined;
  const server = createServer((request, response) => {
    if (access) {
      const port = (server.address() as AddressInfo).port;
      const authority = `${config.host === "::1" ? "[::1]" : config.host}:${port}`;
      if (!publicHeadersAllowed(request, response, access.origin, authority))
        return;
    } else if (!host(request, response) || !origin(request, response)) return;
    const route = request.url?.split("?")[0];
    if (
      access &&
      [
        RESOURCE_METADATA_PATH,
        "/.well-known/oauth-protected-resource",
      ].includes(route ?? "")
    ) {
      const metadata = access.metadata();
      if (!metadata || !["GET", "HEAD"].includes(request.method ?? "")) {
        respond(response, 404, { error: "not_found" });
        return;
      }
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      response.end(
        request.method === "HEAD" ? undefined : JSON.stringify(metadata),
      );
      return;
    }
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
        if (access && !(await access.authorize(request, response))) {
          request.resume();
          return;
        }
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
    options.signal?.throwIfAborted();
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
      access?.close(),
    ]);
    throw error;
  }
  const address = server.address() as AddressInfo;
  return {
    url: `http://${config.host === "::1" ? "[::1]" : config.host}:${address.port}/mcp`,
    runtime,
    protocol,
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
          access?.close(),
        ]);
        server.closeAllConnections();
        await stopped;
        if (results.some((result) => result.status === "rejected"))
          throw new Error("Some service cleanup steps failed.");
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

import { execFile } from "node:child_process";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
  type Server,
} from "node:http";
import { createServer as createTlsServer } from "node:https";
import { connect, type AddressInfo, type Socket } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { generate, type GenerateResult } from "selfsigned";

let certificates: Promise<GenerateResult> | undefined;
function certificate() {
  certificates ??= new Promise((resolve, reject) =>
    generate(
      [{ name: "commonName", value: "exec-mcp-test" }],
      {
        algorithm: "sha256",
        keySize: 2048,
        days: 2,
        notBeforeDate: new Date(Date.now() - 60_000),
        extensions: [
          { name: "basicConstraints", cA: true },
          {
            name: "keyUsage",
            keyCertSign: true,
            digitalSignature: true,
            keyEncipherment: true,
          },
          { name: "extKeyUsage", serverAuth: true },
          {
            name: "subjectAltName",
            altNames: [
              { type: 2, value: "files.example.test" },
              { type: 2, value: "localhost" },
              { type: 7, ip: "127.0.0.1" },
            ],
          },
        ],
      },
      (error, result) => (error ? reject(error) : resolve(result)),
    ),
  );
  return certificates;
}

/** All network tests remain on loopback; proxies explicitly map test hostnames to fixtures. */
export class ProxyFixtures {
  readonly cleanups: (() => Promise<void>)[] = [];
  private temporary: Promise<string> | undefined;

  async directory(): Promise<string> {
    this.temporary ??= mkdtemp(path.join(tmpdir(), "exec-mcp-proxy-"));
    return this.temporary;
  }
  async server(
    handler: (request: IncomingMessage, response: ServerResponse) => void,
    tls = false,
  ) {
    const material = tls ? await certificate() : undefined;
    const server = material
      ? createTlsServer({ key: material.private, cert: material.cert }, handler)
      : createServer(handler);
    const sockets = new Set<Socket>();
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    this.cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          for (const socket of sockets) socket.destroy();
        }),
    );
    const port = (server.address() as AddressInfo).port;
    return {
      server: server as Server,
      port,
      url: `${tls ? "https" : "http"}://127.0.0.1:${port}`,
    };
  }

  async proxy(
    target: (authority: string) => number,
    options: {
      tls?: boolean;
      authorization?: string;
      reject?: boolean;
      stall?: boolean;
    } = {},
  ) {
    const calls: { authority: string; authorization: string | undefined }[] =
      [];
    const outgoing = new Set<Socket>();
    const proxy = await this.server((_req, response) => {
      response.writeHead(405);
      response.end();
    }, options.tls);
    proxy.server.on("connect", (request, client, head) => {
      calls.push({
        authority: request.url ?? "",
        authorization: request.headers["proxy-authorization"],
      });
      if (options.stall) return;
      if (
        options.reject ||
        (options.authorization &&
          request.headers["proxy-authorization"] !== options.authorization)
      ) {
        client.end(
          "HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
        return;
      }
      let port: number;
      try {
        port = target(request.url ?? "");
      } catch {
        client.end(
          "HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
        return;
      }
      const socket = connect({ host: "127.0.0.1", port });
      outgoing.add(socket);
      socket.once("connect", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) socket.write(head);
        socket.pipe(client);
        client.pipe(socket);
      });
      socket.once("close", () => outgoing.delete(socket));
      socket.on("error", () => client.destroy());
      client.on("error", () => socket.destroy());
      client.once("close", () => socket.destroy());
    });
    this.cleanups.push(async () => {
      for (const socket of outgoing) socket.destroy();
    });
    return { ...proxy, calls };
  }

  async child(
    source: string,
    environment: Record<string, string> = {},
    timeout = 15_000,
  ) {
    const root = await this.directory();
    const ca = path.join(root, "fixture-ca.pem");
    await writeFile(ca, (await certificate()).cert);
    // Test isolation only: leave the running server/user environment untouched.
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "NO_PROXY",
      "http_proxy",
      "https_proxy",
      "no_proxy",
      "ALL_PROXY",
      "all_proxy",
    ])
      delete env[key];
    Object.assign(
      env,
      { NODE_USE_ENV_PROXY: "0", NODE_EXTRA_CA_CERTS: ca },
      environment,
    );
    return promisify(execFile)(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", source],
      {
        cwd: process.cwd(),
        env,
        encoding: "utf8",
        timeout,
        maxBuffer: 1024 * 1024,
      },
    );
  }

  async close() {
    for (const close of this.cleanups.splice(0).reverse()) await close();
    if (this.temporary)
      await rm(await this.temporary, { recursive: true, force: true });
  }
}

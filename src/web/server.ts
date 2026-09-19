import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
  type Server,
} from "node:http";
import type { AddressInfo } from "node:net";
import { networkInterfaces } from "node:os";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExecRuntime } from "../runtime.js";
import { defaultConfigPath, type Config } from "../config.js";
import { SseBroker } from "./events.js";
import { VERSION } from "../version.js";
import { discoverSkills } from "../skills/discover.js";
import { MEMORY_DEFAULTS } from "../memory.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface WebServerInstance {
  server: Server;
  port: number;
  host: string;
  loopbackUrl: string;
  lanUrl: string;
  lanIp: string;
  token: string;
  close(): Promise<void>;
  regenerateToken(): string;
}

export interface WebServerOptions {
  port?: number | undefined;
  host?: string | undefined;
  token?: string | undefined;
  publicDir?: string | undefined;
  configPath?: string | undefined;
}

export function getLocalIpAddress(): string {
  const interfaces = networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name] ?? []) {
      if (net.family === "IPv4" && !net.internal) {
        return net.address;
      }
    }
  }
  return "0.0.0.0";
}

export function isLoopbackAddress(ip: string | undefined): boolean {
  if (!ip) return false;
  return (
    ip === "127.0.0.1" ||
    ip === "::1" ||
    ip === "::ffff:127.0.0.1" ||
    ip.startsWith("127.") ||
    ip === "localhost"
  );
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const item of header.split(";")) {
    const [name, ...rest] = item.trim().split("=");
    if (name) {
      cookies[name] = decodeURIComponent(rest.join("="));
    }
  }
  return cookies;
}

export async function startWebServer(
  runtime: ExecRuntime,
  config: Config,
  options: WebServerOptions = {},
): Promise<WebServerInstance> {
  const preferredPort = options.port ?? 8892;
  const preferredHost = options.host ?? "0.0.0.0";
  let token = options.token ?? randomBytes(16).toString("hex");
  const configPath = options.configPath ?? defaultConfigPath();

  const sse = new SseBroker();
  const unsubscribeActivity = runtime.activity.subscribe((event) => {
    sse.broadcast(event);
  });

  let publicDir = options.publicDir;
  if (!publicDir) {
    const candidate1 = path.resolve(__dirname, "public");
    const candidate2 = path.resolve(__dirname, "../../dist/src/web/public");
    if (existsSync(candidate1)) {
      publicDir = candidate1;
    } else if (existsSync(candidate2)) {
      publicDir = candidate2;
    } else {
      publicDir = candidate1;
    }
  }

  const server = createServer(async (req, res) => {
    const rawIp = req.socket.remoteAddress;
    const isLocal = isLoopbackAddress(rawIp);

    const reqUrl = new URL(
      req.url ?? "/",
      `http://${req.headers.host || "localhost"}`,
    );
    const pathname = reqUrl.pathname;

    const tokenFromQuery = reqUrl.searchParams.get("token");
    const tokenFromHeader =
      req.headers["x-exec-token"] ||
      (req.headers.authorization?.startsWith("Bearer ")
        ? req.headers.authorization.slice(7).trim()
        : undefined);
    const cookies = parseCookies(req.headers.cookie);
    const tokenFromCookie = cookies["exec_token"];

    const clientToken = tokenFromQuery || tokenFromHeader || tokenFromCookie;
    const isLanAuthenticated =
      isLocal || (clientToken !== undefined && clientToken === token);

    // If token passed via URL parameter on LAN, set cookie for convenience
    if (!isLocal && tokenFromQuery === token) {
      res.setHeader(
        "Set-Cookie",
        `exec_token=${token}; Path=/; SameSite=Lax; HttpOnly`,
      );
    }

    // CORS for local development
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, x-exec-token",
    );

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Auth verification endpoint (always accessible)
    if (pathname === "/api/auth/verify" && req.method === "POST") {
      try {
        const body = (await readJsonBody(req)) as { token?: string };
        if (body.token === token) {
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Set-Cookie": `exec_token=${token}; Path=/; SameSite=Lax; HttpOnly`,
          });
          res.end(JSON.stringify({ valid: true }));
        } else {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ valid: false, message: "密钥不正确" }));
        }
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_body" }));
      }
      return;
    }

    // Block non-authenticated LAN requests from API
    if (pathname.startsWith("/api/") && !isLanAuthenticated) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "unauthorized",
          message: "局域网访问需要提供访问密钥",
          needAuth: true,
        }),
      );
      return;
    }

    // API Routes
    if (pathname.startsWith("/api/")) {
      try {
        await handleApiRoute({
          pathname,
          reqUrl,
          req,
          res,
          runtime,
          config,
          isLocal,
          token,
          sse,
          server,
          configPath,
          regenerateToken: () => {
            token = randomBytes(16).toString("hex");
            return token;
          },
        });
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: "internal_error",
              message: err instanceof Error ? err.message : String(err),
            }),
          );
        }
      }
      return;
    }

    // Static Assets & Single Page Application (SPA) Serving
    if (!isLanAuthenticated && pathname === "/") {
      // If unauthorized LAN visitor, still serve index.html (SPA displays AuthModal)
      await serveStatic({
        pathname,
        res,
        publicDir,
        token,
        isLanAuthenticated,
      });
      return;
    }
    await serveStatic({ pathname, res, publicDir, token, isLanAuthenticated });
  });

  // Handle port conflict: try preferredPort, then auto increment
  const actualPort = await listenWithFallback(
    server,
    preferredPort,
    preferredHost,
  );

  const lanIp = getLocalIpAddress();
  const loopbackUrl = `http://localhost:${actualPort}/`;
  const lanUrl = `http://${lanIp}:${actualPort}/?token=${token}`;

  return {
    server,
    port: actualPort,
    host: preferredHost,
    loopbackUrl,
    lanUrl,
    lanIp,
    get token() {
      return token;
    },
    regenerateToken() {
      token = randomBytes(16).toString("hex");
      return token;
    },
    async close() {
      unsubscribeActivity();
      sse.close();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      server.closeAllConnections();
    },
  };
}

async function listenWithFallback(
  server: Server,
  startPort: number,
  host: string,
): Promise<number> {
  const maxAttempts = startPort === 0 ? 1 : 50;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const currentPort = startPort === 0 ? 0 : startPort + attempt;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: unknown) => {
          server.removeListener("error", onError);
          reject(err);
        };
        server.once("error", onError);
        server.listen(currentPort, host, () => {
          server.removeListener("error", onError);
          resolve();
        });
      });
      return (server.address() as AddressInfo).port;
    } catch (err: unknown) {
      if (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        (err as { code: string }).code === "EADDRINUSE" &&
        startPort !== 0
      ) {
        continue;
      }
      throw err;
    }
  }

  throw new Error(
    `无法在可用端口上启动 Web UI 服务（尝试端口 ${startPort} 至 ${startPort + maxAttempts - 1}）。`,
  );
}

async function handleApiRoute(context: {
  pathname: string;
  reqUrl: URL;
  req: IncomingMessage;
  res: ServerResponse;
  runtime: ExecRuntime;
  config: Config;
  isLocal: boolean;
  token: string;
  sse: SseBroker;
  server: Server;
  configPath: string;
  regenerateToken: () => string;
}): Promise<void> {
  const {
    pathname,
    reqUrl,
    req,
    res,
    runtime,
    config,
    isLocal,
    token,
    sse,
    configPath,
    regenerateToken,
  } = context;

  if (pathname === "/api/status" && req.method === "GET") {
    const stats = runtime.activity.getStats();
    const address = context.server.address() as AddressInfo;
    const port = address?.port ?? 8892;
    const lanIp = getLocalIpAddress();
    const memory = await runtime.codeMode.getMemoryStatus();

    jsonResponse(res, 200, {
      status: "ready",
      version: VERSION,
      uptime: process.uptime(),
      isLoopback: isLocal,
      mcp: {
        host: config.host,
        port: config.port,
        access: config.access,
        public_url: config.public_url,
      },
      web: {
        port,
        loopbackUrl: `http://localhost:${port}/`,
        lanUrl: `http://${lanIp}:${port}/?token=${token}`,
        lanSecret: isLocal ? token : undefined,
      },
      stats,
      memory,
      system: {
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
      },
    });
    return;
  }

  if (pathname === "/api/events" && req.method === "GET") {
    sse.addClient(res);
    return;
  }

  if (pathname === "/api/sessions" && req.method === "GET") {
    const page = parseInt(reqUrl.searchParams.get("page") ?? "1", 10);
    const pageSize = parseInt(reqUrl.searchParams.get("pageSize") ?? "20", 10);
    const search = reqUrl.searchParams.get("search");

    const data = runtime.activity.getSessions({
      page,
      pageSize,
      ...(search ? { search } : {}),
    });
    jsonResponse(res, 200, data);
    return;
  }

  if (pathname === "/api/calls" && req.method === "GET") {
    const sessionId = reqUrl.searchParams.get("sessionId");
    const status = reqUrl.searchParams.get("status");
    const tool = reqUrl.searchParams.get("tool");
    const search = reqUrl.searchParams.get("search");
    const page = parseInt(reqUrl.searchParams.get("page") ?? "1", 10);
    const pageSize = parseInt(reqUrl.searchParams.get("pageSize") ?? "20", 10);

    const data = runtime.activity.getCalls({
      page,
      pageSize,
      ...(sessionId ? { sessionId } : {}),
      ...(status ? { status } : {}),
      ...(tool ? { tool } : {}),
      ...(search ? { search } : {}),
    });
    jsonResponse(res, 200, data);
    return;
  }

  if (pathname.startsWith("/api/calls/") && req.method === "GET") {
    const id = pathname.slice("/api/calls/".length);
    const call = runtime.activity.getCall(id);
    if (!call) {
      jsonResponse(res, 404, { error: "not_found", message: "调用记录不存在" });
      return;
    }
    jsonResponse(res, 200, call);
    return;
  }

  if (pathname === "/api/calls" && req.method === "DELETE") {
    runtime.activity.clear();
    jsonResponse(res, 200, { success: true, message: "调用历史已清空" });
    return;
  }

  if (pathname === "/api/skills" && req.method === "GET") {
    try {
      const catalog = await discoverSkills({
        config: runtime.skillConfig,
      });
      jsonResponse(res, 200, {
        skills: catalog.skills,
        warnings: catalog.warnings,
        maxChars: runtime.skillMaxChars,
        totalChars: catalog.skills.reduce(
          (acc, s) => acc + (s.description?.length ?? 0) + s.name.length,
          0,
        ),
        count: catalog.skills.length,
      });
    } catch (err) {
      jsonResponse(res, 500, {
        error: "skills_error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  if (pathname === "/api/mcp-servers" && req.method === "GET") {
    const servers = config.mcpServers.map((s) => ({
      name: s.name,
      transport: s.transport,
      ...(s.transport === "stdio"
        ? { command: s.command, args: s.args, cwd: s.cwd }
        : { url: s.url }),
      enabledTools: s.enabledTools,
      startupTimeoutMs: s.startupTimeoutMs,
      toolTimeoutMs: s.toolTimeoutMs,
    }));

    const tools = runtime.discovery.snapshot().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));

    jsonResponse(res, 200, { servers, tools });
    return;
  }

  if (pathname === "/api/mcp-servers/test-search" && req.method === "POST") {
    const body = (await readJsonBody(req)) as {
      query?: string;
      limit?: number;
    };
    const query = body.query ?? "";
    const limit = body.limit ?? 8;
    const searchResult = await runtime.discovery.search(query, limit);
    jsonResponse(res, 200, searchResult);
    return;
  }

  if (pathname === "/api/terminals" && req.method === "GET") {
    const active = runtime.terminal.getActiveSessions();
    jsonResponse(res, 200, { sessions: active });
    return;
  }

  if (pathname === "/api/native-sessions" && req.method === "GET") {
    const sessions = runtime.codeMode.getNativeSessions();
    const memory = await runtime.codeMode.getMemoryStatus();
    jsonResponse(res, 200, { sessions, memory });
    return;
  }

  if (pathname === "/api/artifacts" && req.method === "GET") {
    const artifacts = runtime.artifacts.getActiveArtifacts();
    jsonResponse(res, 200, { artifacts });
    return;
  }

  if (pathname === "/api/artifacts/revoke" && req.method === "POST") {
    const body = (await readJsonBody(req)) as { id?: string; scope?: string };
    if (!body.id) {
      jsonResponse(res, 400, { error: "missing_id" });
      return;
    }
    await runtime.artifacts.revoke(body.id, body.scope);
    jsonResponse(res, 200, { success: true });
    return;
  }

  if (pathname === "/api/config" && req.method === "GET") {
    jsonResponse(res, 200, {
      config_path: configPath,
      config_exists: existsSync(configPath),
      server: {
        host: config.host,
        port: config.port,
        access: config.access,
        ...(config.public_url ? { public_url: config.public_url } : {}),
      },
      auth: config.auth,
      tunnel: config.tunnel,
      execution: config.execution,
      memory: {
        ...MEMORY_DEFAULTS,
        ...config.memory,
      },
      skills: {
        max_chars: runtime.skillMaxChars,
        config: runtime.skillConfig,
      },
      files: config.files,
      mcp_servers: config.mcpServers,
    });
    return;
  }

  if (pathname === "/api/config/reveal" && req.method === "POST") {
    if (!isLocal) {
      jsonResponse(res, 403, {
        error: "forbidden",
        message: "仅限本机回环访问时在本地文件管理器中打开",
      });
      return;
    }
    try {
      const dir = path.dirname(configPath);
      if (process.platform === "win32") {
        if (existsSync(configPath)) {
          spawn("explorer.exe", [`/select,${configPath}`], {
            detached: true,
            stdio: "ignore",
          }).unref();
        } else {
          spawn("explorer.exe", [dir], {
            detached: true,
            stdio: "ignore",
          }).unref();
        }
      } else if (process.platform === "darwin") {
        if (existsSync(configPath)) {
          spawn("open", ["-R", configPath], {
            detached: true,
            stdio: "ignore",
          }).unref();
        } else {
          spawn("open", [dir], {
            detached: true,
            stdio: "ignore",
          }).unref();
        }
      } else {
        spawn("xdg-open", [dir], {
          detached: true,
          stdio: "ignore",
        }).unref();
      }
      jsonResponse(res, 200, { success: true, path: configPath });
    } catch (err) {
      jsonResponse(res, 500, {
        error: "reveal_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  if (pathname === "/api/auth/regenerate-token" && req.method === "POST") {
    const newToken = regenerateToken();
    jsonResponse(res, 200, {
      success: true,
      token: newToken,
      message: "局域网访问密钥已重新生成",
    });
    return;
  }

  jsonResponse(res, 404, { error: "not_found", message: "未知接口" });
}

async function serveStatic(options: {
  pathname: string;
  res: ServerResponse;
  publicDir: string;
  token: string;
  isLanAuthenticated: boolean;
}): Promise<void> {
  const { pathname, res, publicDir } = options;

  let filePath = path.join(
    publicDir,
    pathname === "/" ? "index.html" : pathname.slice(1),
  );

  // Path traversal guard
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    let fileStat = await stat(filePath);
    if (fileStat.isDirectory()) {
      filePath = path.join(filePath, "index.html");
      fileStat = await stat(filePath);
    }

    const content = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".ico": "image/x-icon",
      ".woff2": "font/woff2",
      ".woff": "font/woff",
    };

    const contentType = mimeTypes[ext] ?? "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control":
        ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
    });
    res.end(content);
  } catch {
    // SPA Fallback: serve index.html for unknown routes if it exists
    const indexPath = path.join(publicDir, "index.html");
    try {
      const indexContent = await readFile(indexPath);
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
      });
      res.end(indexContent);
    } catch {
      // If assets are not compiled yet, serve a friendly fallback page
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderFallbackHtml(VERSION));
    }
  }
}

function renderFallbackHtml(version: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>EXEC MCP 控制台</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .card { background: #1e293b; padding: 2rem; border-radius: 1rem; border: 1px solid #334155; max-width: 500px; text-align: center; }
    h1 { color: #6366f1; margin-top: 0; }
    p { color: #94a3b8; line-height: 1.6; }
    .badge { display: inline-block; background: #312e81; color: #c7d2fe; padding: 0.25rem 0.75rem; border-radius: 9999px; font-size: 0.875rem; font-weight: 500; }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">EXEC MCP v${version}</div>
    <h1>控制台准备中</h1>
    <p>前端静态资源正在构建或初始化。请运行 <code>npm run build</code> 后重新刷新本页面。</p>
  </div>
</body>
</html>`;
}

function jsonResponse(
  res: ServerResponse,
  status: number,
  data: unknown,
): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

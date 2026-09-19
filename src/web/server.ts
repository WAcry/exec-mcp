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
import { characterCount, renderSkills } from "../skills/render.js";
import { MEMORY_DEFAULTS } from "../memory.js";
import { effectiveWebConfig, webIsExposed, type WebConfig } from "./config.js";
import { configView, mcpServerView } from "./config-view.js";
import type { ServiceController } from "../service-controller.js";
import { ConfigEditError, type ConfigToggle } from "./config-edit.js";
import { resolveUserPath } from "../util.js";
import {
  WEB_ACTION_HEADER,
  WEB_COOKIE,
  applyCorsForAllowedOrigin,
  applyWebSecurityHeaders,
  isTrustedLoopbackRequest,
  parseCookies,
  requestOriginAllowed,
  tokenMatches,
  webCookie,
} from "./security.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const JSON_BODY_BYTES = 64 * 1024;

export interface WebServerInstance {
  server: Server;
  port: number;
  host: WebConfig["host"];
  exposed: boolean;
  loopbackUrl: string;
  lanUrls: string[];
  token: string;
  close(): Promise<void>;
}

export interface WebServerOptions {
  port?: number | undefined;
  host?: WebConfig["host"] | undefined;
  token?: string | undefined;
  publicDir?: string | undefined;
  configPath?: string | undefined;
  mcpUrl?: string | undefined;
  controller?: ServiceController;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function getLocalIpAddresses(family?: "IPv4" | "IPv6"): string[] {
  const addresses = new Set<string>();
  for (const nets of Object.values(networkInterfaces())) {
    for (const net of nets ?? []) {
      if (net.internal) continue;
      if (family && net.family !== family) continue;
      if (net.family === "IPv4") addresses.add(net.address);
      else if (net.family === "IPv6" && !net.address.startsWith("fe80:"))
        addresses.add(net.address.split("%")[0]!);
    }
  }
  return [...addresses].sort();
}

function formatUrlHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

export async function startWebServer(
  runtime: ExecRuntime,
  config: Config,
  options: WebServerOptions = {},
): Promise<WebServerInstance> {
  const configured = effectiveWebConfig(config.web);
  const web: WebConfig = {
    ...configured,
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.port === undefined ? {} : { port: options.port }),
  };
  let token = options.token ?? randomBytes(32).toString("base64url");
  let closePromise: Promise<void> | undefined;
  const configPath = options.configPath ?? defaultConfigPath();
  const mcpUrl = options.mcpUrl ? new URL(options.mcpUrl) : undefined;
  const exposed = webIsExposed(web);
  const sse = new SseBroker();
  let observedActivity = runtime.activity;
  let unsubscribeActivity = observedActivity.subscribe((event) => {
    sse.broadcast(event);
  });

  let publicDir = options.publicDir;
  if (!publicDir) {
    const installed = path.resolve(__dirname, "public");
    const checkout = path.resolve(__dirname, "../../dist/src/web/public");
    publicDir = existsSync(installed)
      ? installed
      : existsSync(checkout)
        ? checkout
        : installed;
  }
  publicDir = path.resolve(publicDir);

  const lanAddresses = exposed
    ? getLocalIpAddresses(web.host === "0.0.0.0" ? "IPv4" : "IPv6")
    : [];
  const lanUrlsFor = (value: string) =>
    lanAddresses.map(
      (address) =>
        `http://${formatUrlHost(address)}:${actualPort}/#token=${encodeURIComponent(value)}`,
    );
  let actualPort = web.port;

  const server = createServer(async (req, res) => {
    applyWebSecurityHeaders(res, isTrustedLoopbackRequest(req));
    if (!requestOriginAllowed(req)) {
      jsonResponse(res, 403, {
        error: "forbidden_origin",
        message: "Web UI 仅接受同源请求。",
      });
      return;
    }
    applyCorsForAllowedOrigin(req, res);

    if (req.method === "OPTIONS") {
      res.setHeader(
        "Access-Control-Allow-Methods",
        "GET, POST, DELETE, OPTIONS",
      );
      res.setHeader(
        "Access-Control-Allow-Headers",
        `Content-Type, Authorization, x-exec-token, ${WEB_ACTION_HEADER}`,
      );
      res.writeHead(204);
      res.end();
      return;
    }

    let reqUrl: URL;
    try {
      reqUrl = new URL(
        req.url ?? "/",
        `http://${req.headers.host ?? "invalid"}`,
      );
    } catch {
      jsonResponse(res, 400, { error: "invalid_url" });
      return;
    }
    const pathname = reqUrl.pathname;
    const isLocal = isTrustedLoopbackRequest(req);
    const cookies = parseCookies(req.headers.cookie);
    const headerToken = Array.isArray(req.headers["x-exec-token"])
      ? req.headers["x-exec-token"][0]
      : req.headers["x-exec-token"];
    const bearer = req.headers.authorization?.startsWith("Bearer ")
      ? req.headers.authorization.slice(7).trim()
      : undefined;
    const clientToken = headerToken ?? bearer ?? cookies[WEB_COOKIE];
    const authorized = isLocal || tokenMatches(clientToken, token);
    const isUnsafe = !new Set(["GET", "HEAD", "OPTIONS"]).has(
      req.method ?? "GET",
    );

    if (pathname === "/api/auth/verify" && req.method === "POST") {
      if (req.headers[WEB_ACTION_HEADER] !== "1") {
        jsonResponse(res, 403, { error: "missing_action_header" });
        return;
      }
      try {
        const body = (await readJsonBody(req)) as { token?: unknown };
        if (typeof body.token === "string" && tokenMatches(body.token, token)) {
          res.setHeader("Set-Cookie", webCookie(token));
          jsonResponse(res, 200, { valid: true });
        } else {
          jsonResponse(res, 401, { valid: false, message: "密钥不正确" });
        }
      } catch (error) {
        respondError(res, error);
      }
      return;
    }

    if (pathname === "/api/auth/logout" && req.method === "POST") {
      if (req.headers[WEB_ACTION_HEADER] !== "1") {
        jsonResponse(res, 403, { error: "missing_action_header" });
        return;
      }
      res.setHeader("Set-Cookie", webCookie("", true));
      jsonResponse(res, 200, { success: true });
      return;
    }

    if (pathname.startsWith("/api/") && !authorized) {
      jsonResponse(res, 401, {
        error: "unauthorized",
        message: "此 Web UI 请求需要有效访问密钥。",
        needAuth: true,
      });
      return;
    }
    if (
      pathname.startsWith("/api/") &&
      isUnsafe &&
      req.headers[WEB_ACTION_HEADER] !== "1"
    ) {
      jsonResponse(res, 403, {
        error: "missing_action_header",
        message: "管理操作缺少 Web UI 请求标记。",
      });
      return;
    }

    if (pathname.startsWith("/api/")) {
      try {
        const current = options.controller?.current;
        const activeRuntime = current?.server.runtime ?? runtime;
        if (activeRuntime.activity !== observedActivity) {
          unsubscribeActivity();
          observedActivity = activeRuntime.activity;
          unsubscribeActivity = observedActivity.subscribe((event) =>
            sse.broadcast(event),
          );
        }
        await handleApiRoute({
          pathname,
          reqUrl,
          req,
          res,
          runtime: activeRuntime,
          config: current?.config ?? config,
          web: { ...web, port: actualPort },
          isLocal,
          sse,
          configPath,
          loopbackUrl: loopbackUrlFor(web.host, actualPort),
          mcpUrl: current ? new URL(current.server.url) : mcpUrl,
          ...(options.controller ? { controller: options.controller } : {}),
          lanUrls: () => lanUrlsFor(token),
          regenerateToken: () => {
            token = randomBytes(32).toString("base64url");
            return token;
          },
        });
      } catch (error) {
        if (error instanceof ConfigEditError && !res.headersSent) {
          jsonResponse(res, error.status, { error: error.message });
          return;
        }
        if (!res.headersSent) respondError(res, error);
        else res.destroy();
      }
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("Allow", "GET, HEAD");
      res.writeHead(405);
      res.end();
      return;
    }
    try {
      await serveStatic({ pathname, method: req.method, res, publicDir });
    } catch (error) {
      if (!res.headersSent) respondError(res, error);
      else res.destroy();
    }
  });

  try {
    actualPort = await listen(server, web.port, web.host);
  } catch (error) {
    unsubscribeActivity();
    sse.close();
    server.closeAllConnections();
    throw error;
  }

  const loopbackUrl = loopbackUrlFor(web.host, actualPort);
  return {
    server,
    port: actualPort,
    host: web.host,
    exposed,
    loopbackUrl,
    get lanUrls() {
      return lanUrlsFor(token);
    },
    get token() {
      return token;
    },
    async close() {
      closePromise ??= (async () => {
        unsubscribeActivity();
        sse.close();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        });
      })();
      await closePromise;
    },
  };
}

function loopbackUrlFor(host: WebConfig["host"], port: number): string {
  const loopback = host === "::" || host === "::1" ? "[::1]" : "127.0.0.1";
  return `http://${loopback}:${port}/`;
}

async function listen(
  server: Server,
  port: number,
  host: string,
): Promise<number> {
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.listen(port, host, () => {
        server.removeListener("error", onError);
        resolve();
      });
    });
  } catch (error) {
    throw new Error(
      `无法在 ${host}:${port} 启动 Web UI；请修改 [web] 端口或监听地址。`,
      { cause: error },
    );
  }
  return (server.address() as AddressInfo).port;
}

interface RouteContext {
  pathname: string;
  reqUrl: URL;
  req: IncomingMessage;
  res: ServerResponse;
  runtime: ExecRuntime;
  config: Config;
  web: WebConfig;
  isLocal: boolean;
  sse: SseBroker;
  configPath: string;
  loopbackUrl: string;
  mcpUrl?: URL | undefined;
  lanUrls(): string[];
  regenerateToken(): string;
  controller?: ServiceController;
}

async function handleApiRoute(context: RouteContext): Promise<void> {
  const {
    pathname,
    reqUrl,
    req,
    res,
    runtime,
    config,
    web,
    isLocal,
    sse,
    configPath,
    mcpUrl,
  } = context;

  if (pathname === "/api/status" && req.method === "GET") {
    const lanUrls = isLocal ? context.lanUrls() : [];
    jsonResponse(res, 200, {
      status:
        context.controller?.state ?? (runtime.ready ? "ready" : "stopped"),
      generation: context.controller?.generation ?? 1,
      version: VERSION,
      uptime: process.uptime(),
      isLoopback: isLocal,
      mcp: {
        host: mcpUrl?.hostname ?? config.host,
        port: mcpUrl ? Number(mcpUrl.port) : config.port,
        access: config.access,
        public_url: config.public_url,
      },
      web: {
        host: web.host,
        port: web.port,
        exposed: webIsExposed(web),
        loopbackUrl: context.loopbackUrl,
        lanUrls,
      },
      stats: runtime.activity.getStats(),
      memory: await runtime.codeMode.getMemoryStatus(),
      system: {
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
      },
    });
    return;
  }

  if (pathname === "/api/events" && req.method === "GET") {
    if (!sse.addClient(res))
      jsonResponse(res, 503, { error: "too_many_event_clients" });
    return;
  }

  if (pathname === "/api/sessions" && req.method === "GET") {
    const page = positiveInteger(reqUrl.searchParams.get("page"), 1, 1_000_000);
    const pageSize = positiveInteger(
      reqUrl.searchParams.get("pageSize"),
      20,
      100,
    );
    const search = reqUrl.searchParams.get("search");
    jsonResponse(
      res,
      200,
      runtime.activity.getSessions({
        page,
        pageSize,
        ...(search ? { search } : {}),
      }),
    );
    return;
  }

  if (pathname === "/api/calls" && req.method === "GET") {
    const page = positiveInteger(reqUrl.searchParams.get("page"), 1, 1_000_000);
    const pageSize = positiveInteger(
      reqUrl.searchParams.get("pageSize"),
      20,
      100,
    );
    const sessionId = reqUrl.searchParams.get("sessionId");
    const status = reqUrl.searchParams.get("status");
    const tool = reqUrl.searchParams.get("tool");
    const search = reqUrl.searchParams.get("search");
    const data = runtime.activity.getCalls({
      page,
      pageSize,
      ...(sessionId ? { sessionId } : {}),
      ...(status ? { status } : {}),
      ...(tool ? { tool } : {}),
      ...(search ? { search } : {}),
    });
    jsonResponse(res, 200, {
      ...data,
      items: data.items.map((call) => ({
        id: call.id,
        sessionId: call.sessionId,
        tool: call.tool,
        status: call.status,
        startedAt: call.startedAt,
        endedAt: call.endedAt,
        durationMs: call.durationMs,
        args:
          call.tool === "exec"
            ? { source: call.args.source?.split("\n", 1)[0]?.slice(0, 512) }
            : { cell_id: call.args.cell_id },
        subcallCount: call.subcalls.length + (call.omittedSubcalls ?? 0),
        truncated: !!call.truncatedFields || !!call.omittedSubcalls,
      })),
    });
    return;
  }

  if (pathname.startsWith("/api/calls/") && req.method === "GET") {
    let id: string;
    try {
      id = decodeURIComponent(pathname.slice("/api/calls/".length));
    } catch {
      throw new HttpError(400, "调用记录 ID 无效。");
    }
    const call = runtime.activity.getCall(id);
    if (!call) throw new HttpError(404, "调用记录不存在。");
    jsonResponse(res, 200, call);
    return;
  }

  if (pathname === "/api/calls" && req.method === "DELETE") {
    runtime.activity.clear();
    jsonResponse(res, 200, { success: true });
    return;
  }

  if (pathname === "/api/skills" && req.method === "GET") {
    const saved = context.controller
      ? await context.controller.editor.read()
      : undefined;
    const workdir = reqUrl.searchParams.get("workdir");
    const catalog = await discoverSkills({
      includeDisabled: true,
      config: saved?.config.skills?.config ?? runtime.skillConfig,
      ...(workdir ? { workdir: resolveUserPath(workdir) } : {}),
    });
    const rendered = renderSkills(
      {
        ...catalog,
        skills: catalog.skills.filter((skill) => skill.enabled !== false),
      },
      runtime.skillMaxChars,
    );
    jsonResponse(res, 200, {
      skills: catalog.skills,
      warnings: catalog.warnings,
      maxChars: runtime.skillMaxChars,
      totalChars: characterCount(rendered),
      count: catalog.skills.length,
    });
    return;
  }

  if (pathname === "/api/mcp-servers" && req.method === "GET") {
    let servers: ReturnType<typeof mcpServerView>[] = config.mcpServers.map(
      (server) => mcpServerView(server, isLocal),
    );
    if (context.controller) {
      const document = await context.controller.editor.read();
      const raw = (document.raw.mcp_servers ?? {}) as Record<
        string,
        { url?: string; enabled?: boolean }
      >;
      servers = Object.entries(raw).map(([name, settings]) => ({
        ...(servers.find((server) => server.name === name) ?? {
          name,
          transport: settings.url ? "streamable-http" : "stdio",
        }),
        enabled: settings.enabled !== false,
        active: config.mcpServers.some((server) => server.name === name),
      })) as typeof servers;
    }
    const tools = runtime.discovery.snapshot().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
    jsonResponse(res, 200, { servers, tools });
    return;
  }

  if (pathname === "/api/management" && req.method === "GET") {
    if (!context.controller) {
      jsonResponse(res, 200, { available: false });
      return;
    }
    jsonResponse(res, 200, await managementState(context.controller));
    return;
  }
  if (pathname === "/api/config/toggle" && req.method === "POST") {
    if (!context.controller)
      throw new HttpError(409, "当前嵌入式实例未提供配置管理。");
    if (context.controller.state === "restarting")
      throw new HttpError(409, "正在重启，完成后可继续修改配置。");
    const body = (await readJsonBody(req)) as Record<string, unknown>;
    if (typeof body.enabled !== "boolean" || typeof body.revision !== "string")
      throw new HttpError(400, "缺少开关值或配置版本。");
    let change: ConfigToggle;
    if (body.kind === "mcp" && typeof body.name === "string")
      change = { kind: "mcp", name: body.name, enabled: body.enabled };
    else if (
      body.kind === "skill" &&
      typeof body.path === "string" &&
      (body.workdir === undefined || typeof body.workdir === "string")
    )
      change = {
        kind: "skill",
        path: body.path,
        enabled: body.enabled,
        ...(body.workdir ? { workdir: body.workdir as string } : {}),
      };
    else if (
      body.kind === "setting" &&
      (body.name === "execution.login" || body.name === "web.enabled")
    )
      change = { kind: "setting", name: body.name, enabled: body.enabled };
    else
      throw new HttpError(
        400,
        "仅支持已有 MCP、已发现 Skill 和指定布尔配置的开关。",
      );
    await context.controller.editor.toggle(change, body.revision);
    jsonResponse(res, 200, await managementState(context.controller));
    return;
  }
  if (pathname === "/api/runtime/restart" && req.method === "POST") {
    if (!context.controller)
      throw new HttpError(409, "当前实例未提供重启入口。");
    // Acknowledge before retiring any executing requests; repeated clicks coalesce.
    jsonResponse(res, 202, { accepted: true });
    void context.controller.restart().catch(() => undefined);
    return;
  }

  if (pathname === "/api/mcp-servers/test-search" && req.method === "POST") {
    const body = (await readJsonBody(req)) as {
      query?: unknown;
      limit?: unknown;
    };
    const query =
      typeof body.query === "string" ? body.query.slice(0, 2000) : "";
    const limit =
      typeof body.limit === "number"
        ? Math.max(1, Math.min(50, Math.trunc(body.limit)))
        : 8;
    jsonResponse(res, 200, await runtime.discovery.search(query, limit));
    return;
  }

  if (pathname === "/api/terminals" && req.method === "GET") {
    jsonResponse(res, 200, { sessions: runtime.terminal.getActiveSessions() });
    return;
  }

  if (pathname === "/api/native-sessions" && req.method === "GET") {
    jsonResponse(res, 200, {
      sessions: runtime.codeMode.getNativeSessions(),
      memory: await runtime.codeMode.getMemoryStatus(),
    });
    return;
  }

  if (pathname === "/api/artifacts" && req.method === "GET") {
    jsonResponse(res, 200, {
      artifacts: runtime.artifacts.getActiveArtifacts(),
    });
    return;
  }

  if (pathname === "/api/artifacts/revoke" && req.method === "POST") {
    const body = (await readJsonBody(req)) as { id?: unknown };
    if (typeof body.id !== "string" || !body.id)
      throw new HttpError(400, "缺少产物 ID。");
    await runtime.artifacts.revokeFromInstance(body.id);
    jsonResponse(res, 200, { success: true });
    return;
  }

  if (pathname === "/api/config" && req.method === "GET") {
    jsonResponse(res, 200, {
      ...configView({ config, configPath, runtime, web, local: isLocal }),
      config_exists: existsSync(configPath),
      memory: { ...MEMORY_DEFAULTS, ...config.memory },
    });
    return;
  }

  if (pathname === "/api/config/reveal" && req.method === "POST") {
    if (!isLocal) throw new HttpError(403, "仅本机回环访问可以打开配置目录。");
    await revealConfig(configPath);
    jsonResponse(res, 200, { success: true });
    return;
  }

  if (pathname === "/api/auth/regenerate-token" && req.method === "POST") {
    if (!isLocal)
      throw new HttpError(403, "仅本机回环访问可以换新局域网密钥。");
    const newToken = context.regenerateToken();
    // Existing EventSource responses were authorized with the previous token.
    // Close them now so a rotated credential actually revokes live observers.
    sse.disconnectClients();
    res.setHeader("Set-Cookie", webCookie(newToken));
    jsonResponse(res, 200, {
      success: true,
      lanUrls: context.lanUrls(),
      message: "局域网访问密钥已重新生成。",
    });
    return;
  }

  throw new HttpError(404, "未知接口。");
}

async function managementState(controller: ServiceController) {
  const document = await controller.editor.read();
  const definitions = (document.raw.mcp_servers ?? {}) as Record<
    string,
    { enabled?: boolean }
  >;
  return {
    available: true,
    revision: document.revision,
    pending: document.revision !== controller.current.revision,
    state: controller.state,
    generation: controller.generation,
    ...(controller.error ? { error: controller.error } : {}),
    servers: Object.entries(definitions).map(([name, value]) => ({
      name,
      enabled: value.enabled !== false,
      active: controller.current.config.mcpServers.some(
        (server) => server.name === name,
      ),
    })),
    settings: {
      login: document.config.execution?.login ?? false,
      web: effectiveWebConfig(document.config.web).enabled,
    },
  };
}

async function revealConfig(configPath: string): Promise<void> {
  const directory = path.dirname(configPath);
  const child =
    process.platform === "win32"
      ? spawn(
          "explorer.exe",
          [existsSync(configPath) ? `/select,${configPath}` : directory],
          {
            detached: true,
            stdio: "ignore",
          },
        )
      : process.platform === "darwin"
        ? spawn(
            "open",
            existsSync(configPath) ? ["-R", configPath] : [directory],
            {
              detached: true,
              stdio: "ignore",
            },
          )
        : spawn("xdg-open", [directory], { detached: true, stdio: "ignore" });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
}

async function serveStatic(options: {
  pathname: string;
  method: string | undefined;
  res: ServerResponse;
  publicDir: string;
}): Promise<void> {
  const { res, publicDir } = options;
  let pathname: string;
  try {
    pathname = decodeURIComponent(options.pathname);
  } catch {
    throw new HttpError(400, "静态资源路径无效。");
  }
  if (pathname.includes("\0")) throw new HttpError(400, "静态资源路径无效。");
  const root = path.resolve(publicDir);
  let filePath = path.resolve(
    root,
    `.${pathname === "/" ? "/index.html" : pathname}`,
  );
  const relative = path.relative(root, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new HttpError(403, "禁止访问 Web UI 静态目录之外的文件。");

  try {
    let info = await stat(filePath);
    if (info.isDirectory()) {
      filePath = path.join(filePath, "index.html");
      info = await stat(filePath);
    }
    if (!info.isFile()) throw new Error("not a file");
    await sendFile(res, filePath, options.method === "HEAD");
  } catch {
    if (path.extname(pathname)) throw new HttpError(404, "静态资源不存在。");
    const index = path.join(root, "index.html");
    if (existsSync(index))
      await sendFile(res, index, options.method === "HEAD");
    else sendHtml(res, renderFallbackHtml(VERSION), options.method === "HEAD");
  }
}

async function sendFile(
  res: ServerResponse,
  file: string,
  head: boolean,
): Promise<void> {
  const content = await readFile(file);
  const ext = path.extname(file).toLowerCase();
  const types: Record<string, string> = {
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
  res.writeHead(200, {
    "Content-Type": types[ext] ?? "application/octet-stream",
    "Content-Length": content.length,
    "Cache-Control": file.includes(`${path.sep}assets${path.sep}`)
      ? "public, max-age=31536000, immutable"
      : "no-cache",
  });
  res.end(head ? undefined : content);
}

function sendHtml(res: ServerResponse, html: string, head: boolean): void {
  const bytes = Buffer.byteLength(html);
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": bytes,
    "Cache-Control": "no-cache",
  });
  res.end(head ? undefined : html);
}

function renderFallbackHtml(version: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>EXEC MCP 控制台</title></head><body><main><h1>EXEC MCP v${version}</h1><p>Web UI 静态资源尚未构建；请运行 npm run build 后刷新。</p></main></body></html>`;
}

function positiveInteger(
  value: string | null,
  fallback: number,
  maximum: number,
): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? Math.min(parsed, maximum)
    : fallback;
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

function respondError(res: ServerResponse, error: unknown): void {
  const status = error instanceof HttpError ? error.status : 500;
  jsonResponse(res, status, {
    error: status === 500 ? "internal_error" : "request_error",
    message:
      error instanceof HttpError
        ? error.message
        : "内部操作失败；请查看服务状态或本机日志。",
  });
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > JSON_BODY_BYTES) {
      req.resume();
      throw new HttpError(413, "请求正文超过 64 KiB。");
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, "请求正文不是有效 JSON。");
  }
}

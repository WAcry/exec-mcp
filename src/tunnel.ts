import { execFile } from "node:child_process";
import { get } from "node:http";
import type { Config } from "./config.js";
import { validatePublicAccess } from "./http/access-config.js";
import { RESOURCE_METADATA_PATH } from "./http/access.js";
import { findShellExecutable } from "./host/shell.js";
import { runForeground } from "./host/foreground.js";
import { inheritedEnvironment } from "./environment.js";
import { readTokenFile } from "./credentials.js";

export interface TunnelPlan {
  file: string;
  args: string[];
  publicUrl: string;
  provider: "cloudflare" | "tailscale";
  /** Only a path is public; plaintext credentials never enter the printable launch plan. */
  tokenFile?: string;
}

/** Build one foreground provider command. Never install a service or persist a Funnel. */
export async function prepareTunnel(
  config: Config,
  signal?: AbortSignal,
): Promise<TunnelPlan> {
  validatePublicAccess(config);
  if (config.access !== "public" || !config.tunnel || !config.public_url)
    throw new Error(
      "tunnel 命令只用于已配置认证的公网模式；先填写 server、auth 和 tunnel。",
    );
  if (config.port === 0)
    throw new Error(
      "tunnel 命令需要固定的本机 server.port，不能使用随机端口 0。",
    );
  signal?.throwIfAborted();
  const provider = config.tunnel.provider;
  const publicOrigin = new URL(config.public_url).origin;
  const file = findShellExecutable(
    config.tunnel.executable ??
      (provider === "cloudflare" ? "cloudflared" : "tailscale"),
  );
  if (!file)
    throw new Error(
      `找不到 ${provider === "cloudflare" ? "cloudflared" : "tailscale"}；请先安装官方客户端或配置 tunnel.executable。`,
    );
  if (/\.(cmd|bat)$/i.test(file))
    throw new Error(
      "tunnel.executable 必须是原生可执行文件，不接受 Shell 包装。",
    );
  const target = `http://${config.host === "::1" ? "[::1]" : config.host}:${config.port}`;
  await verifyProtectedServer(target, config, signal);

  if (provider === "cloudflare") {
    // Explicit configuration wins. Without it, preserve cloudflared's native
    // environment precedence: TUNNEL_TOKEN, then TUNNEL_TOKEN_FILE.
    const tokenFile =
      (config.tunnel.provider === "cloudflare"
        ? config.tunnel.token_file
        : undefined) ??
      (process.env.TUNNEL_TOKEN
        ? undefined
        : process.env.TUNNEL_TOKEN_FILE || undefined);
    const args = ["tunnel", "--no-autoupdate", "run"];
    if (tokenFile !== undefined) {
      readTokenFile(tokenFile, "Cloudflare token_file");
    } else if (!process.env.TUNNEL_TOKEN) {
      throw new Error(
        "Cloudflare 需要 tunnel.token_file 或环境 TUNNEL_TOKEN/TUNNEL_TOKEN_FILE；不会使用其他凭据启动。",
      );
    }
    return {
      file,
      provider,
      publicUrl: publicOrigin + "/mcp",
      args,
      ...(tokenFile === undefined ? {} : { tokenFile }),
    };
  }

  const info = await providerJson(file, ["status", "--json"], signal);
  const expected = new URL(config.public_url);
  const self =
    info.Self && typeof info.Self === "object"
      ? (info.Self as Record<string, unknown>)
      : undefined;
  const actualName =
    typeof self?.DNSName === "string"
      ? self.DNSName.replace(/\.$/, "").toLowerCase()
      : "";
  if (info.BackendState !== "Running" || actualName !== expected.hostname)
    throw new Error(
      "Tailscale 必须已登录，public_url 必须对应本节点的 DNSName；不会自动登录或修改 tailnet。",
    );
  const port = expected.port || "443";
  const serving = await providerJson(
    file,
    ["serve", "status", "--json"],
    signal,
  );
  if (hasListener(serving, port))
    throw new Error(
      `Tailscale 的 ${port} 端口已有 Serve/Funnel 配置；不会覆盖或 reset 其他服务，请选择空闲端口。`,
    );
  return {
    file,
    provider,
    publicUrl: publicOrigin + "/mcp",
    args: ["funnel", `--https=${port}`, target],
  };
}

/** The entire request is local IPC: do not let an external proxy make an unrelated
 * service look like the protected server we are about to publish.
 */
async function verifyProtectedServer(
  target: string,
  config: Config,
  signal?: AbortSignal,
): Promise<void> {
  const probe = await localRequest(target + "/mcp", signal);
  const challenge = probe.headers["www-authenticate"];
  if (
    probe.status !== 401 ||
    typeof challenge !== "string" ||
    !challenge.startsWith("Bearer ")
  )
    throw new Error(
      "本机 MCP 未返回认证挑战；先使用同一配置启动 exec-mcp serve，不会公开当前端口。",
    );
  if (config.auth?.type === "oauth") {
    const origin = new URL(config.public_url!).origin;
    if (!challenge.includes(`${origin}${RESOURCE_METADATA_PATH}`))
      throw new Error("本机 MCP 的公网身份与配置不同；不会启动 Tunnel。");
    const metadata = await localRequest(
      target + RESOURCE_METADATA_PATH,
      signal,
    );
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(metadata.body);
    } catch {
      throw new Error("本机 OAuth 资源元数据无效。");
    }
    if (metadata.status !== 200 || parsed.resource !== origin + "/mcp")
      throw new Error("本机 OAuth 资源身份与配置不同；不会启动 Tunnel。");
  } else if (challenge !== 'Bearer realm="exec-mcp"') {
    throw new Error("本机认证方式与配置不同；不会启动 Tunnel。");
  }
}

function localRequest(
  url: string,
  signal?: AbortSignal,
): Promise<{
  status: number;
  headers: import("node:http").IncomingHttpHeaders;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const active = AbortSignal.any([
      AbortSignal.timeout(5000),
      ...(signal ? [signal] : []),
    ]);
    const request = get(url, { agent: false, signal: active }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
        if (body.length > 64 * 1024)
          response.destroy(new Error("本机检查响应过大。"));
      });
      response.once("error", () =>
        reject(new Error("无法验证本机 MCP 入口。")),
      );
      response.once("end", () =>
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body,
        }),
      );
    });
    request.once("error", () =>
      reject(new Error("无法连接本机 MCP；先启动 exec-mcp serve。")),
    );
  });
}

async function providerJson(
  file: string,
  args: string[],
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  try {
    const text = await new Promise<string>((resolve, reject) =>
      execFile(
        file,
        args,
        {
          encoding: "utf8",
          env: inheritedEnvironment(),
          timeout: 10_000,
          maxBuffer: 2 * 1024 * 1024,
          windowsHide: true,
          ...(signal ? { signal } : {}),
        },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      ),
    );
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("invalid provider status");
    return value as Record<string, unknown>;
  } catch {
    throw new Error(
      "无法读取 Tailscale 状态；请检查客户端登录和本机服务权限。未修改现有配置。",
    );
  }
}

/** Serve status includes background and foreground configurations. */
function hasListener(value: unknown, port: string): boolean {
  if (!value || typeof value !== "object") return false;
  for (const [key, child] of Object.entries(value)) {
    if (
      key === "TCP" &&
      child &&
      typeof child === "object" &&
      Object.hasOwn(child, port)
    )
      return true;
    if (
      key === "Web" &&
      child &&
      typeof child === "object" &&
      Object.keys(child).some((host) => host.endsWith(":" + port))
    )
      return true;
    if (hasListener(child, port)) return true;
  }
  return false;
}

export async function runTunnel(
  config: Config,
  options: {
    signal?: AbortSignal;
    onStarted?: (plan: TunnelPlan) => void;
  } = {},
): Promise<void> {
  const plan = await prepareTunnel(config, options.signal);
  options.signal?.throwIfAborted();
  // Provider clients cannot decode our file format. Decrypt only into this child's
  // selected variable; other inherited credentials/proxies and the parent stay unchanged.
  const env = inheritedEnvironment(
    process.env,
    plan.tokenFile === undefined
      ? {}
      : {
          TUNNEL_TOKEN: readTokenFile(plan.tokenFile, "Cloudflare token_file"),
        },
  );
  const result = await runForeground(plan.file, plan.args, env, {
    ...(options.signal ? { signal: options.signal } : {}),
    onStarted: () => options.onStarted?.(plan),
  });
  if (!options.signal?.aborted && result.code !== 0)
    throw new Error(
      `Tunnel 客户端已退出（${result.code ?? result.signal ?? "unknown"}）；请使用供应商客户端检查连接和授权，MCP 服务未重启。`,
    );
}

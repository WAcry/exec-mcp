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
      "The tunnel command works only in public mode with authentication. First set server, auth, and tunnel in the configuration.",
    );
  if (config.port === 0)
    throw new Error(
      "The tunnel command needs a fixed local server.port. Do not use port 0, which selects a random port.",
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
      `Cannot find ${provider === "cloudflare" ? "cloudflared" : "tailscale"}. Install the official client or set tunnel.executable.`,
    );
  if (/\.(cmd|bat)$/i.test(file))
    throw new Error(
      "tunnel.executable must be a native executable file. Do not use a shell wrapper.",
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
        "Cloudflare needs tunnel.token_file or the TUNNEL_TOKEN or TUNNEL_TOKEN_FILE environment variable. The tunnel does not start with other credentials.",
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
      "Tailscale must be signed in, and public_url must match the DNSName of this node. exec-mcp does not sign in or change the tailnet for you.",
    );
  const port = expected.port || "443";
  const serving = await providerJson(
    file,
    ["serve", "status", "--json"],
    signal,
  );
  if (hasListener(serving, port))
    throw new Error(
      `Tailscale port ${port} already has a Serve or Funnel configuration. exec-mcp does not replace or reset other services. Select a free port.`,
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
      "The local MCP server did not return an authentication challenge. First start exec-mcp serve with the same configuration. The current port stays private.",
    );
  if (config.auth?.type === "oauth") {
    const origin = new URL(config.public_url!).origin;
    if (!challenge.includes(`${origin}${RESOURCE_METADATA_PATH}`))
      throw new Error(
        "The public identity of the local MCP server does not match the configuration. The tunnel does not start.",
      );
    const metadata = await localRequest(
      target + RESOURCE_METADATA_PATH,
      signal,
    );
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(metadata.body);
    } catch {
      throw new Error("The local OAuth resource metadata is not valid.");
    }
    if (metadata.status !== 200 || parsed.resource !== origin + "/mcp")
      throw new Error(
        "The local OAuth resource identity does not match the configuration. The tunnel does not start.",
      );
  } else if (challenge !== 'Bearer realm="exec-mcp"') {
    throw new Error(
      "The local authentication type does not match the configuration. The tunnel does not start.",
    );
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
          response.destroy(new Error("The local check response is too large."));
      });
      response.once("error", () =>
        reject(new Error("Cannot verify the local MCP endpoint.")),
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
      reject(
        new Error(
          "Cannot connect to the local MCP server. Start exec-mcp serve first.",
        ),
      ),
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
      "Cannot read the Tailscale status. Check the client sign-in and the local service permissions. exec-mcp did not change the current configuration.",
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
      `The tunnel client stopped (${result.code ?? result.signal ?? "unknown"}). Use the provider client to check the connection and authorization. exec-mcp did not restart the MCP server.`,
    );
}

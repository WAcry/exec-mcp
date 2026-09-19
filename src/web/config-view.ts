import path from "node:path";
import type { Config } from "../config.js";
import type { DownstreamMcpServerConfig } from "../downstream/config.js";
import type { ExecRuntime } from "../runtime.js";
import type { WebConfig } from "./config.js";

const REDACTED = "<redacted>";

export function mcpServerView(
  server: DownstreamMcpServerConfig,
  local: boolean,
) {
  const policy = {
    name: server.name,
    transport: server.transport,
    enabledTools: server.enabledTools,
    startupTimeoutMs: server.startupTimeoutMs,
    toolTimeoutMs: server.toolTimeoutMs,
  };
  return server.transport === "stdio"
    ? {
        ...policy,
        command: local ? server.command : path.basename(server.command),
        argsCount: server.args.length,
        envKeys: Object.keys(server.env).sort(),
        ...(server.cwd
          ? { cwd: local ? server.cwd : path.basename(server.cwd) }
          : {}),
      }
    : {
        ...policy,
        url: safeHttpUrl(server.url),
        headerNames: Object.keys(server.headers).sort(),
      };
}

function safeHttpUrl(value: string): string {
  const url = new URL(value);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.href;
}

export function configView(options: {
  config: Config;
  configPath: string;
  runtime: ExecRuntime;
  web: WebConfig;
  local: boolean;
}) {
  const { config, configPath, runtime, web, local } = options;
  const auth =
    config.auth?.type === "bearer"
      ? {
          type: "bearer",
          ...(config.auth.token_env
            ? { token_env: config.auth.token_env }
            : {}),
          ...(config.auth.token_file ? { token_file: REDACTED } : {}),
        }
      : config.auth;
  const tunnel = config.tunnel
    ? {
        provider: config.tunnel.provider,
        ...(config.tunnel.executable
          ? {
              executable: local
                ? config.tunnel.executable
                : path.basename(config.tunnel.executable),
            }
          : {}),
        ...(config.tunnel.provider === "cloudflare" && config.tunnel.token_file
          ? { token_file: REDACTED }
          : {}),
      }
    : undefined;
  return {
    ...(local
      ? { config_path: configPath }
      : { config_file: path.basename(configPath) }),
    config_exists: true,
    server: {
      host: config.host,
      port: config.port,
      access: config.access,
      ...(config.public_url ? { public_url: config.public_url } : {}),
    },
    web,
    ...(auth ? { auth } : {}),
    ...(tunnel ? { tunnel } : {}),
    execution:
      config.execution?.shell && !local
        ? { ...config.execution, shell: path.basename(config.execution.shell) }
        : config.execution,
    memory: config.memory,
    skills: {
      max_chars: runtime.skillMaxChars,
      config: runtime.skillConfig.map((setting) =>
        "path" in setting && !local
          ? { ...setting, path: path.basename(setting.path) }
          : setting,
      ),
    },
    files: config.files,
    mcp_servers: config.mcpServers.map((server) =>
      mcpServerView(server, local),
    ),
  };
}

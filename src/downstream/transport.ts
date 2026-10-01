import {
  StreamableHTTPClientTransport,
  type Transport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { inheritedEnvironment } from "../environment.js";
import type { EnvironmentHttpClient } from "../network/http.js";
import type { DownstreamMcpServerConfig } from "./config.js";
import { SetupError } from "./errors.js";

type Environment = Readonly<Record<string, string | undefined>>;

export function createTransport(
  config: DownstreamMcpServerConfig,
  environment: Environment,
  http?: EnvironmentHttpClient,
): Transport {
  if (config.transport === "stdio") {
    return new StdioClientTransport({
      command: config.command,
      args: [...config.args],
      env: inheritedEnvironment(environment, config.env),
      // stdio stdout belongs to MCP; diagnostics/login hints belong in the terminal.
      stderr: "inherit",
      ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
    });
  }
  const headers = httpHeaders(config, environment);
  return new StreamableHTTPClientTransport(new URL(config.url), {
    fetch: http!.fetch,
    ...(Object.keys(headers).length === 0 ? {} : { requestInit: { headers } }),
  });
}

/**
 * Static headers, then env_http_headers whose variable has a value, then
 * bearer_token_env_var, which Codex requires to be set. A later source
 * replaces a header of the same name, compared without case.
 */
export function httpHeaders(
  config: Extract<DownstreamMcpServerConfig, { transport: "streamable-http" }>,
  environment: Environment,
): Record<string, string> {
  const headers: Record<string, string> = {};
  const set = (name: string, value: string) => {
    for (const key of Object.keys(headers))
      if (key.toLowerCase() === name.toLowerCase()) delete headers[key];
    headers[name] = value;
  };
  for (const [name, value] of Object.entries(config.headers)) set(name, value);
  for (const [name, variable] of Object.entries(config.envHeaders ?? {})) {
    const value = environment[variable];
    if (value !== undefined && value.trim()) set(name, value);
  }
  if (config.bearerTokenEnvVar !== undefined) {
    const token = environment[config.bearerTokenEnvVar];
    if (!token)
      throw new SetupError(
        `Downstream MCP server ${JSON.stringify(config.name)}: the environment variable ${config.bearerTokenEnvVar} named by bearer_token_env_var is ${token === undefined ? "not set" : "empty"}. Set it in the environment of the exec-mcp service, then restart exec-mcp.`,
      );
    set("Authorization", `Bearer ${token}`);
  }
  return headers;
}

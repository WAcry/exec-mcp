import { readFile, mkdir, open } from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "@iarna/toml";
import { z } from "zod/v4";
import { configDirectory } from "./host/platform.js";
import { resolveUserPath } from "./util.js";
import type { ExecutionConfig } from "./host/shell.js";
import { MEMORY_SCHEMA, MEMORY_DEFAULTS, type MemoryConfig } from "./memory.js";
import {
  AUTH_SCHEMA,
  TUNNEL_SCHEMA,
  PUBLIC_URL_SCHEMA,
  validatePublicAccess,
  type AuthConfig,
  type TunnelConfig,
} from "./http/access-config.js";
import type { DownstreamMcpServerConfig } from "./downstream/config.js";
import { FILE_CONFIG_SCHEMA, type FileConfig } from "./files/contracts.js";
import {
  SKILLS_CONFIG_SCHEMA,
  DEFAULT_SKILL_MAX_CHARS,
  type SkillsConfig,
} from "./skills/types.js";
import {
  WEB_CONFIG_SCHEMA,
  WEB_DEFAULTS,
  type WebConfig,
} from "./web/config.js";

const strings = z.record(z.string(), z.string());
// RFC 9110 token: what fetch accepts as a header name.
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const ENVIRONMENT_NAME = /^[^=\0]+$/u;
const environmentName = z
  .string()
  .regex(
    ENVIRONMENT_NAME,
    "must be an environment variable name without = or NUL",
  );
/** The longest Node.js timer, about 24.8 days. */
const MAX_TIMEOUT_SEC = 2_147_483.647;
const timeoutSeconds = z.number().min(0.001).max(MAX_TIMEOUT_SEC);
const serverSchema = z
  .object({
    access: z.enum(["openai-tunnel", "public"]),
    host: z.enum(["127.0.0.1", "::1"]).default("127.0.0.1"),
    port: z.number().int().min(0).max(65535).default(8891),
    public_url: PUBLIC_URL_SCHEMA.optional(),
  })
  .strict();
const downstreamSchema = z
  .object({
    enabled: z.boolean().default(true),
    enabled_tools: z.array(z.string()).optional(),
    // Startup is not a connector call. Both are bound only by Node's timer range.
    startup_timeout_sec: timeoutSeconds.optional(),
    tool_timeout_sec: timeoutSeconds.optional(),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    env: strings.optional(),
    cwd: z.string().optional(),
    url: z.url().optional(),
    // Codex calls this http_headers.
    headers: strings.optional(),
    env_http_headers: strings.optional(),
    bearer_token_env_var: environmentName.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const issue = (message: string, path: string[] = []) =>
      ctx.addIssue({ code: "custom", message, path });
    for (const field of ["headers", "env_http_headers"] as const)
      for (const [name, variable] of Object.entries(value[field] ?? {})) {
        if (!HEADER_NAME.test(name))
          issue(
            "the key must be an HTTP header name with only letters, digits, and !#$%&'*+-.^_`|~",
            [field, name],
          );
        if (field === "env_http_headers" && !ENVIRONMENT_NAME.test(variable))
          issue(
            "the value must be the name of an environment variable without = or NUL",
            [field, name],
          );
      }
    if ((value.command === undefined) === (value.url === undefined))
      issue("set exactly one of command (stdio) or url (Streamable HTTP)");
    if (value.url && (value.command || value.args || value.cwd || value.env))
      issue(
        "a server with url cannot have the stdio fields command, args, cwd, or env",
      );
    if (
      value.command &&
      (value.headers || value.env_http_headers || value.bearer_token_env_var)
    )
      issue(
        "a server with command cannot have the HTTP fields headers, env_http_headers, or bearer_token_env_var; pass credentials to a stdio server with env",
      );
    if (value.bearer_token_env_var !== undefined) {
      const names = [
        ...Object.keys(value.headers ?? {}),
        ...Object.keys(value.env_http_headers ?? {}),
      ];
      if (names.some((name) => name.toLowerCase() === "authorization"))
        issue(
          "bearer_token_env_var sets the Authorization header; remove Authorization from headers and env_http_headers",
          ["bearer_token_env_var"],
        );
    }
    if (value.url) {
      let url: URL | undefined;
      try {
        url = new URL(value.url);
      } catch {
        // z.url() already reported it.
      }
      if (
        url &&
        (!["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password)
      )
        issue(
          "url must be an http or https URL without a user name or password; send credentials with headers, env_http_headers, or bearer_token_env_var",
          ["url"],
        );
    }
  });
const configSchema = z
  .object({
    server: serverSchema,
    auth: AUTH_SCHEMA.optional(),
    tunnel: TUNNEL_SCHEMA.optional(),
    files: FILE_CONFIG_SCHEMA.optional(),
    skills: SKILLS_CONFIG_SCHEMA.optional(),
    memory: MEMORY_SCHEMA.optional(),
    web: WEB_CONFIG_SCHEMA.optional(),
    execution: z
      .object({
        shell: z
          .string()
          .refine((value) => !!value.trim() && !value.includes("\0"))
          .optional(),
        login: z.boolean().default(false),
      })
      .strict()
      .optional(),
    mcp_servers: z.record(z.string().min(1), downstreamSchema).default({}),
  })
  .strict();
export interface Config {
  host: "127.0.0.1" | "::1";
  port: number;
  access: "openai-tunnel" | "public";
  public_url?: string | undefined;
  auth?: AuthConfig;
  tunnel?: TunnelConfig;
  mcpServers: DownstreamMcpServerConfig[];
  files?: FileConfig;
  skills?: SkillsConfig;
  execution?: ExecutionConfig;
  memory?: MemoryConfig;
  web?: WebConfig;
}
/**
 * A configuration error whose message names fields and reasons but never
 * configured values, so callers can show it as it is.
 */
export class ConfigError extends Error {}
export const CONFIG_TEMPLATE = `[server]\n# Only for a trusted OpenAI Secure MCP Tunnel. Never publish this endpoint without authentication to the internet.\naccess = "openai-tunnel"\nhost = "127.0.0.1"\nport = 8891\n\n# [web]\n# enabled = ${WEB_DEFAULTS.enabled}\n# host = "${WEB_DEFAULTS.host}" # This machine only by default. Set 0.0.0.0 or :: to open it to the LAN.\n# port = ${WEB_DEFAULTS.port}\n\n# [execution]\n# shell = "pwsh" # An executable name or path. Omit it to select one for this system.\n# login = false\n\n# [memory]\n# code_mode_high_water_mib = ${MEMORY_DEFAULTS.code_mode_high_water_mib}\n# idle_retention_hours = ${MEMORY_DEFAULTS.idle_retention_hours}\n# terminal_buffer_mib = ${MEMORY_DEFAULTS.terminal_buffer_mib}\n# terminal_max_sessions = ${MEMORY_DEFAULTS.terminal_max_sessions}\n# terminal_total_buffer_mib = ${MEMORY_DEFAULTS.terminal_total_buffer_mib}\n\n# [skills]\n# max_chars = ${DEFAULT_SKILL_MAX_CHARS} # Target size of the Skill catalog in characters, about 10000 tokens. It is not an exact token count.\n\n# [mcp_servers.example]\n# command = "node"\n# args = ["/absolute/path/to/mcp-server.js"]\n# enabled_tools = ["lookup"]\n\n# [mcp_servers.remote]\n# url = "https://example.com/mcp"\n# bearer_token_env_var = "EXAMPLE_MCP_TOKEN" # Or headers = { Authorization = "Bearer REPLACE_ME" }\n`;
export function defaultConfigPath(): string {
  return (
    process.env.EXEC_MCP_CONFIG ?? path.join(configDirectory(), "config.toml")
  );
}
export function parseConfig(text: string, filename: string): Config {
  let raw: unknown;
  try {
    raw = parseToml(text);
  } catch (error) {
    // The parser message quotes the source line, which can hold a credential.
    const { line, col } = error as { line?: unknown; col?: unknown };
    const where =
      typeof line === "number" && typeof col === "number"
        ? ` near line ${line + 1}, column ${col + 1}`
        : "";
    throw new ConfigError(
      `The configuration is not valid TOML${where}. Fix the syntax there. The content is not shown, because it can hold credentials.`,
    );
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success)
    throw new ConfigError(
      [
        "The configuration has fields that are not valid. Fix them, then start exec-mcp again:",
        ...parsed.error.issues.map(
          (issue) =>
            `- ${issue.path.map(String).join(".") || "(top level)"}: ${issue.message}`,
        ),
      ].join("\n"),
    );
  const {
    server,
    mcp_servers,
    files,
    skills,
    execution,
    auth,
    tunnel,
    memory,
    web,
  } = parsed.data;
  validatePublicAccess({
    ...server,
    ...(auth ? { auth } : {}),
    ...(tunnel ? { tunnel } : {}),
  });
  if (auth?.type === "bearer" && auth.token_file !== undefined)
    auth.token_file = resolveUserPath(auth.token_file, path.dirname(filename));
  if (tunnel?.provider === "cloudflare" && tunnel.token_file !== undefined)
    tunnel.token_file = resolveUserPath(
      tunnel.token_file,
      path.dirname(filename),
    );
  if (
    tunnel?.executable &&
    (tunnel.executable.includes("/") ||
      (process.platform === "win32" && tunnel.executable.includes("\\")))
  )
    tunnel.executable = resolveUserPath(
      tunnel.executable,
      path.dirname(filename),
    );
  if (skills?.config) {
    skills.config = skills.config.map((setting) =>
      "path" in setting
        ? {
            ...setting,
            path: resolveUserPath(setting.path, path.dirname(filename)),
          }
        : setting,
    );
  }
  if (
    execution?.shell !== undefined &&
    (execution.shell.includes("/") ||
      (process.platform === "win32" && execution.shell.includes("\\")))
  )
    execution.shell = resolveUserPath(execution.shell, path.dirname(filename));
  const mcpServers: DownstreamMcpServerConfig[] = Object.entries(mcp_servers)
    .filter(([, item]) => item.enabled)
    .map(([name, item]) => {
      const policy = {
        ...(item.enabled_tools ? { enabledTools: item.enabled_tools } : {}),
        ...(item.startup_timeout_sec === undefined
          ? {}
          : { startupTimeoutMs: Math.round(item.startup_timeout_sec * 1000) }),
        ...(item.tool_timeout_sec === undefined
          ? {}
          : { toolTimeoutMs: Math.round(item.tool_timeout_sec * 1000) }),
      };
      if (item.command)
        return {
          name,
          transport: "stdio" as const,
          command: item.command,
          args: item.args ?? [],
          env: item.env ?? {},
          ...(item.cwd === undefined
            ? {}
            : { cwd: resolveUserPath(item.cwd, path.dirname(filename)) }),
          ...policy,
        };
      return {
        name,
        transport: "streamable-http" as const,
        url: item.url!,
        headers: item.headers ?? {},
        ...(item.env_http_headers === undefined
          ? {}
          : { envHeaders: item.env_http_headers }),
        ...(item.bearer_token_env_var === undefined
          ? {}
          : { bearerTokenEnvVar: item.bearer_token_env_var }),
        ...policy,
      };
    });
  return {
    ...server,
    mcpServers,
    ...(auth === undefined ? {} : { auth }),
    ...(tunnel === undefined ? {} : { tunnel }),
    ...(files === undefined ? {} : { files }),
    ...(memory === undefined ? {} : { memory }),
    ...(web === undefined ? {} : { web }),
    ...(skills === undefined ? {} : { skills }),
    ...(execution === undefined
      ? {}
      : {
          execution: {
            login: execution.login,
            ...(execution.shell === undefined
              ? {}
              : { shell: execution.shell }),
          },
        }),
  };
}
export async function loadConfig(
  filename = defaultConfigPath(),
): Promise<Config> {
  let text: string;
  try {
    text = await readFile(filename, "utf8");
  } catch {
    throw new ConfigError(
      `Cannot read the configuration file ${filename}. Run exec-mcp init to create it, or set EXEC_MCP_CONFIG to the path of an existing file.`,
    );
  }
  return parseConfig(text, filename);
}
export async function initializeConfig(
  filename = defaultConfigPath(),
): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const handle = await open(filename, "wx", 0o600);
  try {
    await handle.writeFile(CONFIG_TEMPLATE);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

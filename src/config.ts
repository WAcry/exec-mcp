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

const strings = z.record(z.string(), z.string());
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
    startup_timeout_sec: z.number().positive().max(110).optional(),
    tool_timeout_sec: z.number().positive().optional(),
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    env: strings.optional(),
    cwd: z.string().optional(),
    url: z.url().optional(),
    headers: strings.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.command === undefined) === (value.url === undefined))
      ctx.addIssue({ code: "custom", message: "command/url 必须二选一" });
    if (value.url && (value.command || value.args || value.cwd || value.env))
      ctx.addIssue({ code: "custom", message: "HTTP 配置不能含 stdio 字段" });
    if (value.command && value.headers)
      ctx.addIssue({
        code: "custom",
        message: "stdio 配置不能含 HTTP headers",
      });
    if (value.url) {
      const url = new URL(value.url);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        ctx.addIssue({
          code: "custom",
          message: "url 必须是无内嵌凭据的 HTTP(S) 地址",
        });
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
}
export const CONFIG_TEMPLATE = `[server]\n# 仅供受信任的 OpenAI Secure MCP Tunnel；禁止将此无认证入口发布到公网。\naccess = "openai-tunnel"\nhost = "127.0.0.1"\nport = 8891\n\n# [execution]\n# shell = "pwsh" # 可执行文件名或路径；省略则按系统自动选择。\n# login = false\n\n# [memory]\n# code_mode_high_water_mib = ${MEMORY_DEFAULTS.code_mode_high_water_mib}\n# idle_retention_hours = ${MEMORY_DEFAULTS.idle_retention_hours}\n# terminal_buffer_mib = ${MEMORY_DEFAULTS.terminal_buffer_mib}\n\n# [skills]\n# max_chars = ${DEFAULT_SKILL_MAX_CHARS} # Skill 目录字符目标，约 10000 tokens；不是精确 tokenizer 计量。\n\n# [mcp_servers.example]\n# command = "node"\n# args = ["/absolute/path/to/mcp-server.js"]\n# enabled_tools = ["lookup"]\n\n# [mcp_servers.remote]\n# url = "https://example.com/mcp"\n# headers = { Authorization = "Bearer REPLACE_ME" }\n`;
export function defaultConfigPath(): string {
  return (
    process.env.EXEC_MCP_CONFIG ?? path.join(configDirectory(), "config.toml")
  );
}
export function parseConfig(text: string, filename: string): Config {
  let raw: unknown;
  try {
    raw = parseToml(text);
  } catch {
    throw new Error("配置不是有效的 TOML；为避免泄漏凭据，不回显内容。");
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success)
    throw new Error(
      `配置字段无效：${parsed.error.issues.map((issue) => issue.path.join(".") || "root").join(", ")}`,
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
          : { startupTimeoutMs: item.startup_timeout_sec * 1000 }),
        ...(item.tool_timeout_sec === undefined
          ? {}
          : { toolTimeoutMs: item.tool_timeout_sec * 1000 }),
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
    throw new Error(`无法读取配置 ${filename}；先运行 exec-mcp init。`);
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

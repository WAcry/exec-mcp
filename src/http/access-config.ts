import { z } from "zod/v4";

const httpsUrl = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.hash &&
      !url.search
    );
  } catch {
    return false;
  }
}, "必须是无凭据、查询或片段的 HTTPS URL");

export const PUBLIC_URL_SCHEMA = httpsUrl
  .refine(
    (value) => new URL(value).pathname === "/",
    "public_url 只填写 HTTPS origin，不包含 /mcp 或其他路径",
  )
  .transform((value) => new URL(value).origin);
const scope = z.string().regex(/^[\x21\x23-\x5b\x5d-\x7e]+$/);
export const AUTH_SCHEMA = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("oauth"),
      issuer: httpsUrl,
      jwks_url: httpsUrl,
      subject: z.string().min(1),
      scopes: z.array(scope).min(1).default(["exec"]),
    })
    .strict(),
  z
    .object({
      type: z.literal("bearer"),
      token_env: z
        .string()
        .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/)
        .default("EXEC_MCP_ACCESS_TOKEN"),
    })
    .strict(),
]);
export type AuthConfig = z.infer<typeof AUTH_SCHEMA>;

export const TUNNEL_SCHEMA = z.discriminatedUnion("provider", [
  z
    .object({
      provider: z.literal("cloudflare"),
      executable: z.string().min(1).optional(),
      token_file: z.string().min(1),
    })
    .strict(),
  z
    .object({
      provider: z.literal("tailscale"),
      executable: z.string().min(1).optional(),
    })
    .strict(),
]);
export type TunnelConfig = z.infer<typeof TUNNEL_SCHEMA>;

export function validatePublicAccess(config: {
  access: string;
  host: string;
  public_url?: string | undefined;
  auth?: AuthConfig;
  tunnel?: TunnelConfig;
}): void {
  if (!["127.0.0.1", "::1"].includes(config.host))
    throw new Error("MCP 入口必须监听本机回环地址。");
  if (config.access === "openai-tunnel") {
    if (
      config.public_url !== undefined ||
      config.auth !== undefined ||
      config.tunnel !== undefined
    )
      throw new Error(
        "OpenAI 私有模式不能同时配置公网入口、应用认证或其他 Tunnel。",
      );
    return;
  }
  if (config.access !== "public" || !config.public_url || !config.auth)
    throw new Error(
      "公网模式必须配置 public_url 和 auth；禁止公开无认证执行入口。",
    );
  PUBLIC_URL_SCHEMA.parse(config.public_url);
  AUTH_SCHEMA.parse(config.auth);
  if (config.tunnel) TUNNEL_SCHEMA.parse(config.tunnel);
  if (config.tunnel?.provider === "tailscale") {
    const url = new URL(config.public_url);
    if (
      !url.hostname.endsWith(".ts.net") ||
      !["", "443", "8443", "10000"].includes(url.port)
    )
      throw new Error(
        "Tailscale Funnel 必须使用本节点的 .ts.net HTTPS 地址和 443/8443/10000 端口。",
      );
  }
}

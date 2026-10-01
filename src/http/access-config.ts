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
}, "must be an HTTPS URL without credentials, a query, or a fragment");

export const PUBLIC_URL_SCHEMA = httpsUrl
  .refine(
    (value) => new URL(value).pathname === "/",
    "public_url must be only an HTTPS origin, without /mcp or another path",
  )
  .transform((value) => new URL(value).origin);
const scope = z.string().regex(/^[\x21\x23-\x5b\x5d-\x7e]+$/);
export const AUTH_SCHEMA = z
  .discriminatedUnion("type", [
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
          .optional(),
        token_file: z
          .string()
          .min(1)
          .refine((value) => !value.includes("\0"))
          .optional(),
      })
      .strict()
      .superRefine((value, ctx) => {
        if (value.token_env !== undefined && value.token_file !== undefined)
          ctx.addIssue({
            code: "custom",
            message: "set only one of token_env and token_file",
          });
      }),
  ])
  .transform((value) =>
    value.type === "bearer" &&
    value.token_file === undefined &&
    value.token_env === undefined
      ? { ...value, token_env: "EXEC_MCP_ACCESS_TOKEN" }
      : value,
  );
export type AuthConfig = z.infer<typeof AUTH_SCHEMA>;

export const TUNNEL_SCHEMA = z.discriminatedUnion("provider", [
  z
    .object({
      provider: z.literal("cloudflare"),
      executable: z.string().min(1).optional(),
      token_file: z
        .string()
        .min(1)
        .refine((value) => !value.includes("\0"))
        .optional(),
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
    throw new Error(
      "The MCP endpoint must listen on a local loopback address.",
    );
  if (config.access === "openai-tunnel") {
    if (
      config.public_url !== undefined ||
      config.auth !== undefined ||
      config.tunnel !== undefined
    )
      throw new Error(
        'OpenAI private mode cannot use public_url, auth, or tunnel. Remove them, or set access = "public".',
      );
    return;
  }
  if (config.access !== "public" || !config.public_url || !config.auth)
    throw new Error(
      "Public mode needs public_url and auth. Do not make an exec endpoint public without authentication.",
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
        "Tailscale Funnel must use the .ts.net HTTPS address of this node and port 443, 8443, or 10000.",
      );
  }
}

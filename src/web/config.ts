import { z } from "zod/v4";

export const WEB_DEFAULTS = {
  enabled: true,
  host: "127.0.0.1" as const,
  port: 8893,
} as const;

export const WEB_CONFIG_SCHEMA = z
  .object({
    enabled: z.boolean().default(WEB_DEFAULTS.enabled),
    host: z
      .enum(["127.0.0.1", "::1", "0.0.0.0", "::"])
      .default(WEB_DEFAULTS.host),
    port: z.number().int().min(0).max(65535).default(WEB_DEFAULTS.port),
  })
  .strict();

export type WebConfig = z.infer<typeof WEB_CONFIG_SCHEMA>;

export function effectiveWebConfig(config?: WebConfig): WebConfig {
  return WEB_CONFIG_SCHEMA.parse(config ?? {});
}

export function webIsExposed(config: Pick<WebConfig, "host">): boolean {
  return config.host === "0.0.0.0" || config.host === "::";
}

import { z } from "zod/v4";

export const RESOURCE_FILE_BYTES = 32 * 1024 * 1024;
export const FILE_DEFAULTS = {
  max_file_bytes: 512 * 1024 * 1024,
  max_export_bytes: 4 * 1024 * 1024 * 1024,
  ttl_seconds: 60 * 60,
} as const;
export const FILE_TRANSFER_TIMEOUT_MS = 10 * 60 * 1000;

export const FILE_CONFIG_SCHEMA = z
  .object({
    max_file_bytes: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .default(FILE_DEFAULTS.max_file_bytes),
    max_export_bytes: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .default(FILE_DEFAULTS.max_export_bytes),
    ttl_seconds: z
      .number()
      .int()
      .min(1)
      .max(86400)
      .default(FILE_DEFAULTS.ttl_seconds),
    download: z
      .object({
        base_url: z.string().refine((value) => {
          try {
            const url = new URL(value);
            return (
              url.protocol === "https:" &&
              !url.username &&
              !url.password &&
              !url.search &&
              !url.hash &&
              !/%2f|%5c/i.test(url.pathname)
            );
          } catch {
            return false;
          }
        }, "下载地址必须是不含凭据、查询或片段的 HTTPS 基址。"),
        port: z.number().int().min(0).max(65535).default(8892),
      })
      .strict()
      .optional(),
  })
  .strict();
export type FileConfig = z.infer<typeof FILE_CONFIG_SCHEMA>;

export const HOST_FILE_SCHEMA = z
  .object({
    download_url: z
      .string()
      .min(1)
      .describe(
        "Temporary download URL supplied by the host for the server to fetch.",
      ),
    file_id: z
      .string()
      .min(1)
      .describe("Opaque file identifier supplied by the host."),
    mime_type: z
      .string()
      .optional()
      .describe("MIME type supplied by the host."),
    file_name: z
      .string()
      .optional()
      .describe(
        "Original filename supplied by the host; destination determines the local path.",
      ),
    size: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("File size in bytes, when supplied by the host."),
  })
  .passthrough();
export type HostFile = z.infer<typeof HOST_FILE_SCHEMA>;
export const IMPORT_FILE_SCHEMA = z
  .object({
    index: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "Zero-based index of the file in this call's exec.files array.",
      ),
    destination: z
      .string()
      .min(1)
      .describe(
        "Destination file path, relative to exec.workdir; supports ~/.",
      ),
    overwrite: z
      .boolean()
      .optional()
      .describe(
        "True replaces an existing destination after download validation. Defaults to false.",
      ),
  })
  .strict();
export const EXPORT_FILE_SCHEMA = z
  .object({
    path: z
      .string()
      .min(1)
      .describe(
        "Regular file to export, relative to exec.workdir; supports ~/.",
      ),
    name: z
      .string()
      .min(1)
      .max(255)
      .optional()
      .describe(
        "Single filename presented to the user. Defaults to the source filename.",
      ),
    delivery: z
      .enum(["resource", "url"])
      .optional()
      .describe(
        "Defaults to resource delivery through MCP. url publishes an expiring download link and requires a configured download endpoint.",
      ),
  })
  .strict();

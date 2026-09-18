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
      .describe("宿主注入的临时下载地址；不要自行构造、改写或输出。"),
    file_id: z.string().min(1).describe("宿主提供的不透明文件标识。"),
    mime_type: z.string().optional().describe("宿主提供的 MIME 类型，可省略。"),
    file_name: z
      .string()
      .optional()
      .describe("宿主提供的文件名，可省略；不作为保存路径。"),
    size: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("宿主可选的文件字节数。"),
  })
  .passthrough();
export type HostFile = z.infer<typeof HOST_FILE_SCHEMA>;
export const IMPORT_FILE_SCHEMA = z
  .object({
    index: z
      .number()
      .int()
      .nonnegative()
      .describe("本次 exec.files 的零基索引；不接收文件引用或 URL。"),
    destination: z
      .string()
      .min(1)
      .describe("目标文件路径；相对 exec.workdir，支持 ~/。"),
    overwrite: z
      .boolean()
      .optional()
      .describe("默认不覆盖；true 在下载校验成功后替换目标。"),
  })
  .strict();
export const EXPORT_FILE_SCHEMA = z
  .object({
    path: z
      .string()
      .min(1)
      .describe("要交付的普通文件；相对 exec.workdir，支持 ~/。"),
    name: z
      .string()
      .min(1)
      .max(255)
      .optional()
      .describe("交付文件名，不得包含目录分隔符或控制字符；默认源文件名。"),
    delivery: z
      .enum(["resource", "url"])
      .optional()
      .describe(
        "默认 resource 经 MCP 读取；url 显式发布限时下载链接，须已配置独立下载入口。",
      ),
  })
  .strict();
export const REVOKE_FILE_SCHEMA = z
  .object({
    id: z
      .string()
      .min(1)
      .describe(
        "export_file 返回的导出 id；撤销后拒绝新读取，已经开始的读取可能完成。",
      ),
  })
  .strict();

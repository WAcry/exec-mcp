import type {
  Client,
  RequestOptions,
  Resource,
  ResourceTemplateType,
} from "@modelcontextprotocol/client";
import { z } from "zod/v4";
import { MAX_PAYLOAD_BYTES } from "../limits.js";

const serverName = z
  .string()
  .min(1)
  .describe("config.toml 中启用的 MCP 服务名，或列表条目的 server；原样传入。");
export const RESOURCE_LIST_SCHEMA = z
  .object({
    server: serverName
      .optional()
      .describe("config.toml 中的服务名；指定时取一页，省略汇总全部启用服务。"),
    cursor: z
      .string()
      .optional()
      .describe(
        "上一页的 nextCursor，原样传入；仅与同一 server 和同一种列表配合，省略取首页。",
      ),
  })
  .strict()
  .refine(
    (value) => value.cursor === undefined || value.server !== undefined,
    "cursor 必须与 server 一起提供",
  );
export const RESOURCE_READ_SCHEMA = z
  .object({
    server: serverName,
    uri: z
      .string()
      .min(1)
      .describe(
        "该服务的资源 URI：来自资源列表、资源链接或按 uriTemplate 展开的地址；原样传入。",
      ),
  })
  .strict();
export type ResourceListInput = z.infer<typeof RESOURCE_LIST_SCHEMA>;
export type ResourceReadInput = z.infer<typeof RESOURCE_READ_SCHEMA>;

type Catalogs = {
  resources: Resource;
  resourceTemplates: ResourceTemplateType;
};
type CatalogKey = keyof Catalogs;
type ResourcePage<K extends CatalogKey> = Record<
  K,
  (Catalogs[K] & { server: string })[]
> & { nextCursor?: string };
export type ResourceCatalog<K extends CatalogKey> = ResourcePage<K> & {
  server?: string;
  errors?: Record<string, string>;
};
type UseResourceClient = <T>(
  server: string,
  operation: (client: Client, options: RequestOptions) => Promise<T>,
) => Promise<T>;
const MAX_RESOURCE_LIST_PAGES = 100;

export class ResourceError extends Error {}

/** No cache or second encoded buffer for potentially large binary contents. */
export function resourceResultBytes(value: unknown): number {
  const bytes = Buffer.byteLength(JSON.stringify(value));
  if (bytes > MAX_PAYLOAD_BYTES)
    throw new ResourceError(
      `MCP 资源结果超过 ${MAX_PAYLOAD_BYTES / 1024 / 1024} MiB 传输上限，未截断或落盘；目录可指定 server 并分页读取。`,
    );
  return bytes;
}

/** One-server requests are paged; the all-server form matches Codex's aggregate.
 * Raw SDK requests avoid its automatic pagination and persistent response cache.
 */
export async function listResourceCatalog<K extends CatalogKey>(
  key: K,
  input: ResourceListInput,
  servers: readonly string[],
  useClient: UseResourceClient,
): Promise<ResourceCatalog<K>> {
  if (input.cursor !== undefined && input.server === undefined)
    throw new Error("cursor 必须与 server 一起提供。");
  const list = (server: string, allPages: boolean) =>
    useClient(server, async (client, options) => {
      const items: (Catalogs[K] & { server: string })[] = [];
      if (!client.getServerCapabilities()?.resources)
        return { [key]: items } as ResourcePage<K>;
      let cursor = input.cursor;
      let bytes = 0;
      const seen = new Set<string>();
      for (
        let pageIndex = 0;
        pageIndex < MAX_RESOURCE_LIST_PAGES;
        pageIndex++
      ) {
        options.signal?.throwIfAborted();
        const params = cursor === undefined ? {} : { cursor };
        const page =
          key === "resources"
            ? await client.request(
                { method: "resources/list", params },
                options,
              )
            : await client.request(
                { method: "resources/templates/list", params },
                options,
              );
        bytes += resourceResultBytes(page);
        if (bytes > MAX_PAYLOAD_BYTES)
          throw new ResourceError(
            "资源目录超过传输上限；请指定 server 并分页读取。",
          );
        const rows = page[key] as Catalogs[K][];
        for (const row of rows) items.push({ ...row, server });
        const nextCursor = page.nextCursor;
        if (!allPages || nextCursor === undefined)
          return {
            [key]: items,
            ...(nextCursor === undefined ? {} : { nextCursor }),
          } as ResourcePage<K>;
        if (seen.has(nextCursor))
          throw new ResourceError("资源目录的分页游标重复。");
        seen.add(nextCursor);
        cursor = nextCursor;
      }
      throw new ResourceError(
        `资源目录超过 ${MAX_RESOURCE_LIST_PAGES} 页；请指定 server 并分页读取。`,
      );
    });
  if (input.server !== undefined)
    return { ...(await list(input.server, false)), server: input.server };
  const pages = await Promise.all(
    [...servers].sort().map(async (server) => {
      try {
        return { server, page: await list(server, true) };
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        return {
          server,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
  const merged = {
    [key]: pages.flatMap((entry) => entry.page?.[key] ?? []),
  } as ResourcePage<K>;
  const result: ResourceCatalog<K> = {
    ...merged,
    errors: Object.fromEntries(
      pages
        .filter((entry) => entry.error !== undefined)
        .map((entry) => [entry.server, entry.error!]),
    ),
  };
  resourceResultBytes(result);
  return result;
}

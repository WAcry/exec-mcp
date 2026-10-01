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
  .describe(
    "MCP server name exactly as configured, matching the server field in list results.",
  );
export const RESOURCE_LIST_SCHEMA = z
  .object({
    server: serverName
      .optional()
      .describe(
        "MCP server name. Specify to fetch one page; omit to aggregate all enabled servers.",
      ),
    cursor: z
      .string()
      .optional()
      .describe(
        "Opaque nextCursor from the previous page; omit for the first page. Requires the same server and list method that produced it.",
      ),
  })
  .strict()
  .refine(
    (value) => value.cursor === undefined || value.server !== undefined,
    "cursor requires server. Pass the server whose list returned this cursor.",
  );
export const RESOURCE_READ_SCHEMA = z
  .object({
    server: serverName,
    uri: z
      .string()
      .min(1)
      .describe(
        "Resource URI to read, exactly as listed, linked by a tool, or expanded from a uriTemplate.",
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
      `The MCP resource result is larger than the ${MAX_PAYLOAD_BYTES / 1024 / 1024} MiB transfer limit, so it was not returned. To list a catalog, pass server and read it one page at a time.`,
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
    throw new Error(
      "cursor requires server. Pass the server whose list returned this cursor.",
    );
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
            "The resource catalog is larger than the transfer limit. Pass server and read it one page at a time with cursor.",
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
          throw new ResourceError(
            "The server returned the same nextCursor twice while listing its resource catalog. Pass server and read one page at a time.",
          );
        seen.add(nextCursor);
        cursor = nextCursor;
      }
      throw new ResourceError(
        `The resource catalog has more than ${MAX_RESOURCE_LIST_PAGES} pages. Pass server and read one page at a time with cursor.`,
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

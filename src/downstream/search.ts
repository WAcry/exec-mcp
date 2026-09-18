import MiniSearch from "minisearch";

import type { Tool } from "@modelcontextprotocol/client";

import type { DownstreamTool } from "../types.js";

const DEFAULT_RESULT_LIMIT = 8;

const FIELD_BOOSTS = {
  toolIdentity: 5,
  title: 4,
  serverIdentity: 3,
  description: 2,
  schemaNames: 1,
  schemaDescriptions: 0.5,
} as const;

const CJK_RUNS =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
const WORD_SEGMENTER = new Intl.Segmenter("und", { granularity: "word" });

export interface ToolDescriptor {
  id: string;
  codeName: string;
  serverId: string;
  serverName?: string;
  serverTitle?: string;
  namespaceInstructions?: string;
  tool: Tool;
}

export interface ToolSearchOptions {
  limit?: number;
}

interface SearchDocument {
  id: string;
  toolIdentity: string;
  title: string;
  serverIdentity: string;
  description: string;
  schemaNames: string;
  schemaDescriptions: string;
}

interface SchemaText {
  names: string[];
  descriptions: string[];
}

/**
 * A local, deterministic BM25 tool index. Search results retain the original
 * descriptor, including complete input and output schemas.
 */
export class ToolSearchIndex {
  readonly #index: MiniSearch<SearchDocument>;
  readonly #tools = new Map<string, ToolDescriptor>();

  public constructor(tools: readonly ToolDescriptor[]) {
    this.#index = new MiniSearch<SearchDocument>({
      fields: Object.keys(FIELD_BOOSTS),
      idField: "id",
      tokenize: tokenizeSearchText,
      processTerm: (term) => term,
      searchOptions: {
        boost: FIELD_BOOSTS,
        combineWith: "OR",
        prefix: true,
      },
    });

    const documents: SearchDocument[] = [];
    for (const descriptor of tools) {
      if (this.#tools.has(descriptor.id)) {
        throw new Error(`Duplicate downstream tool id: ${descriptor.id}`);
      }
      this.#tools.set(descriptor.id, descriptor);
      documents.push(toSearchDocument(descriptor));
    }
    this.#index.addAll(documents);
  }

  public search(
    query: string,
    options: ToolSearchOptions = {},
  ): ToolDescriptor[] {
    const canonicalQuery = query.normalize("NFKC").trim();
    if (canonicalQuery.length === 0) {
      return [];
    }
    const normalizedQuery = normalizeSearchText(canonicalQuery);

    const limit = options.limit ?? DEFAULT_RESULT_LIMIT;
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new Error("Search limit must be a positive integer");
    }

    const ranked = this.#index
      .search(canonicalQuery)
      .map((result, position) => {
        const tool = this.#tools.get(String(result.id));
        if (tool === undefined) {
          throw new Error(
            `Search index returned unknown tool id: ${String(result.id)}`,
          );
        }
        return {
          tool,
          bm25Score: result.score,
          identityBoost: identityMatchBoost(normalizedQuery, tool),
          position,
        };
      });

    ranked.sort(
      (left, right) =>
        right.identityBoost - left.identityBoost ||
        right.bm25Score - left.bm25Score ||
        left.position - right.position ||
        left.tool.id.localeCompare(right.tool.id),
    );

    return ranked.slice(0, limit).map(({ tool }) => tool);
  }
}

export function buildToolSearchIndex(
  tools: readonly DownstreamTool[],
): ToolSearchIndex {
  return new ToolSearchIndex(tools);
}

export function tokenizeSearchText(input: string): string[] {
  const canonical = input.normalize("NFKC");
  const normalized = normalizeSearchText(canonical);
  const terms = new Set<string>();

  for (const segment of WORD_SEGMENTER.segment(canonical)) {
    if (!segment.isWordLike) {
      continue;
    }
    addIdentifierTerms(segment.segment, terms);
  }

  for (const match of normalized.matchAll(CJK_RUNS)) {
    const characters = Array.from(match[0]);
    for (const character of characters) terms.add(character);
    for (let index = 0; index < characters.length - 1; index += 1) {
      terms.add(`${characters[index]!}${characters[index + 1]!}`);
    }
  }

  return [...terms];
}

export function normalizeSearchText(input: string): string {
  return input.normalize("NFKC").toLocaleLowerCase("en-US");
}

function addIdentifierTerms(value: string, terms: Set<string>): void {
  const normalized = normalizeSearchText(value);
  if (normalized.length === 0) {
    return;
  }
  terms.add(normalized);

  // Segmenter keeps many identifiers intact. Re-run the original-cased value
  // through identifier boundaries so snake_case, camelCase, and v2 names match.
  const split = value
    .normalize("NFKC")
    .replace(/([\p{Ll}\p{N}])([\p{Lu}])/gu, "$1 $2")
    .replace(/([\p{Lu}]+)([\p{Lu}][\p{Ll}])/gu, "$1 $2")
    .replace(/([\p{L}])([\p{N}])/gu, "$1 $2")
    .replace(/([\p{N}])([\p{L}])/gu, "$1 $2")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

  for (const part of split) {
    terms.add(normalizeSearchText(part));
  }
}

function toSearchDocument(descriptor: ToolDescriptor): SearchDocument {
  const schema = collectSchemaText(
    descriptor.tool.inputSchema,
    descriptor.tool.outputSchema,
  );
  return {
    id: descriptor.id,
    toolIdentity: [
      descriptor.id,
      descriptor.codeName,
      descriptor.tool.name,
    ].join(" "),
    title: descriptor.tool.title ?? "",
    serverIdentity: [
      descriptor.serverId,
      descriptor.serverName,
      descriptor.serverTitle,
    ]
      .filter((value): value is string => value !== undefined)
      .join(" "),
    description: descriptor.tool.description ?? "",
    schemaNames: schema.names.join(" "),
    schemaDescriptions: schema.descriptions.join(" "),
  };
}

function identityMatchBoost(query: string, descriptor: ToolDescriptor): number {
  const identities = [
    descriptor.id,
    descriptor.codeName,
    descriptor.tool.name,
  ].map(normalizeIdentity);
  const normalized = normalizeIdentity(query);
  if (identities.includes(normalized)) {
    return 2;
  }
  if (identities.some((identity) => identity.startsWith(normalized))) {
    return 1;
  }
  return 0;
}

function normalizeIdentity(value: string): string {
  return normalizeSearchText(value).replace(/[^\p{L}\p{N}]+/gu, "");
}

function collectSchemaText(
  inputSchema: unknown,
  outputSchema: unknown,
): SchemaText {
  const names: string[] = [];
  const descriptions: string[] = [];
  const seen = new WeakSet<object>();

  visitSchema(inputSchema, [], names, descriptions, seen);
  visitSchema(outputSchema, [], names, descriptions, seen);
  return { names, descriptions };
}

function visitSchema(
  schema: unknown,
  path: readonly string[],
  names: string[],
  descriptions: string[],
  seen: WeakSet<object>,
): void {
  if (!isObject(schema) || seen.has(schema)) {
    return;
  }
  seen.add(schema);

  if (typeof schema.title === "string") {
    descriptions.push(schema.title);
  }
  if (typeof schema.description === "string") {
    descriptions.push(schema.description);
  }

  visitNamedSchemas(schema.properties, path, names, descriptions, seen);
  visitNamedSchemas(schema.patternProperties, path, names, descriptions, seen);
  visitNamedSchemas(schema.$defs, path, names, descriptions, seen);
  visitNamedSchemas(schema.definitions, path, names, descriptions, seen);
  visitNamedSchemas(schema.dependentSchemas, path, names, descriptions, seen);

  for (const keyword of [
    "items",
    "contains",
    "additionalProperties",
    "unevaluatedProperties",
    "unevaluatedItems",
    "propertyNames",
    "not",
    "if",
    "then",
    "else",
    "contentSchema",
  ] as const) {
    visitSchema(schema[keyword], path, names, descriptions, seen);
  }

  for (const keyword of ["prefixItems", "allOf", "anyOf", "oneOf"] as const) {
    const children = schema[keyword];
    if (!Array.isArray(children)) {
      continue;
    }
    for (const child of children) {
      visitSchema(child, path, names, descriptions, seen);
    }
  }
}

function visitNamedSchemas(
  value: unknown,
  path: readonly string[],
  names: string[],
  descriptions: string[],
  seen: WeakSet<object>,
): void {
  if (!isObject(value)) {
    return;
  }
  for (const [name, child] of Object.entries(value)) {
    const childPath = [...path, name];
    names.push(name, childPath.join("."));
    visitSchema(child, childPath, names, descriptions, seen);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export { DEFAULT_RESULT_LIMIT, FIELD_BOOSTS };

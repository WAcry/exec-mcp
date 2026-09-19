import { createHash, randomUUID } from "node:crypto";
import {
  readFile,
  realpath,
  stat,
  writeFile,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import TOML from "@iarna/toml";
import { parseTOML, type AST } from "toml-eslint-parser";
import { parseConfig, type Config } from "../config.js";
import { AsyncMutex, resolveUserPath } from "../util.js";
import { discoverSkills } from "../skills/discover.js";

export type ConfigToggle =
  | { kind: "mcp"; name: string; enabled: boolean }
  | { kind: "skill"; path: string; workdir?: string; enabled: boolean }
  | {
      kind: "setting";
      name: "execution.login" | "web.enabled";
      enabled: boolean;
    };

export class ConfigEditError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export interface ConfigDocument {
  filename: string;
  source: string;
  revision: string;
  config: Config;
  raw: Record<string, unknown>;
}
const hash = (source: string) =>
  createHash("sha256").update(source).digest("hex");
const key = (parts: readonly (string | number)[]) => JSON.stringify(parts);

/** Edit only the requested literal/setting, retaining comments, credentials and layout. */
export function setTomlBoolean(
  source: string,
  target: (string | number)[],
  value: boolean,
): string {
  const ast = parseTOML(source, { tomlVersion: "1.0" });
  const values = new Map<string, AST.TOMLContentNode>();
  const containers = new Map<
    string,
    AST.TOMLInlineTable | AST.TOMLTable | AST.TOMLTopLevelTable
  >();
  function walk(node: AST.TOMLNode, parts: (string | number)[]) {
    if (node.type === "Program") node.body.forEach((child) => walk(child, []));
    else if (node.type === "TOMLTable") {
      containers.set(key(node.resolvedKey), node);
      node.body.forEach((child) => walk(child, node.resolvedKey));
    } else if (
      node.type === "TOMLTopLevelTable" ||
      node.type === "TOMLInlineTable"
    ) {
      containers.set(key(parts), node);
      node.body.forEach((child) => walk(child, parts));
    } else if (node.type === "TOMLKeyValue") {
      const nested = parts.concat(
        node.key.keys.map((part) =>
          part.type === "TOMLBare" ? part.name : part.value,
        ),
      );
      values.set(key(nested), node.value);
      walk(node.value, nested);
    } else if (node.type === "TOMLArray")
      node.elements.forEach((child, index) => walk(child, parts.concat(index)));
  }
  walk(ast, []);
  const existing = values.get(key(target));
  if (existing)
    return (
      source.slice(0, existing.range[0]) +
      String(value) +
      source.slice(existing.range[1])
    );
  const parent = target.slice(0, -1),
    leaf = target.at(-1)!;
  const container = containers.get(key(parent));
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  if (container?.type === "TOMLInlineTable") {
    const index = container.range[1] - 1;
    return (
      source.slice(0, index) +
      `${container.body.length ? ", " : ""}${JSON.stringify(leaf)} = ${value}` +
      source.slice(index)
    );
  }
  if (container) {
    let index = container.body[0]?.range[0];
    if (index === undefined) {
      const end = source.indexOf("\n", container.range[0]);
      index =
        container.type === "TOMLTopLevelTable"
          ? 0
          : end < 0
            ? source.length
            : end + 1;
    }
    const prefix = index > 0 && source[index - 1] !== "\n" ? newline : "";
    return (
      source.slice(0, index) +
      `${prefix}${JSON.stringify(leaf)} = ${value}${newline}` +
      source.slice(index)
    );
  }
  if (parent.some((part) => typeof part === "number"))
    throw new ConfigEditError(422, "无法定位配置条目，请在配置文件中修改。");
  return (
    source +
    `${newline}[${parent.map((part) => JSON.stringify(part)).join(".")}]${newline}${JSON.stringify(leaf)} = ${value}${newline}`
  );
}

function appendSkillRule(
  source: string,
  settings: unknown[],
  file: string,
  enabled: boolean,
): string {
  const ast = parseTOML(source, { tomlVersion: "1.0" });
  let array: AST.TOMLArray | undefined;
  function visit(node: AST.TOMLNode, parts: (string | number)[]) {
    if (node.type === "Program" || node.type === "TOMLTopLevelTable")
      node.body.forEach((n) => visit(n, parts));
    else if (node.type === "TOMLTable")
      node.body.forEach((n) => visit(n, node.resolvedKey));
    else if (node.type === "TOMLInlineTable")
      node.body.forEach((n) => visit(n, parts));
    else if (node.type === "TOMLKeyValue") {
      const next = parts.concat(
        node.key.keys.map((p) => (p.type === "TOMLBare" ? p.name : p.value)),
      );
      if (
        key(next) === key(["skills", "config"]) &&
        node.value.type === "TOMLArray"
      )
        array = node.value;
      else visit(node.value, next);
    }
  }
  visit(ast, []);
  if (array) {
    const position = array.elements.at(-1)?.range[1] ?? array.range[0] + 1;
    const value = `{ path = ${JSON.stringify(file)}, enabled = ${enabled} }`;
    return (
      source.slice(0, position) +
      (array.elements.length ? ", " : "") +
      value +
      source.slice(position)
    );
  }
  void settings;
  return (
    source +
    `\n[[skills.config]]\npath = ${JSON.stringify(file)}\nenabled = ${enabled}\n`
  );
}

export class ConfigEditor {
  private readonly mutex = new AsyncMutex();
  constructor(readonly filename: string) {}
  async read(): Promise<ConfigDocument> {
    try {
      const filename = await realpath(this.filename);
      const source = await readFile(filename, "utf8");
      return {
        filename,
        source,
        revision: hash(source),
        config: parseConfig(source, this.filename),
        raw: TOML.parse(source) as Record<string, unknown>,
      };
    } catch {
      throw new ConfigEditError(
        422,
        "无法读取或解析 config.toml；请在终端检查配置。",
      );
    }
  }
  async toggle(
    change: ConfigToggle,
    revision: string,
  ): Promise<ConfigDocument> {
    return this.mutex.run(async () => {
      const current = await this.read();
      if (current.revision !== revision)
        throw new ConfigEditError(409, "配置已被其他操作修改，请刷新后重试。");
      let source = current.source;
      if (change.kind === "mcp") {
        const servers = current.raw.mcp_servers as
          | Record<string, unknown>
          | undefined;
        if (!servers || !Object.hasOwn(servers, change.name))
          throw new ConfigEditError(
            404,
            "MCP 配置项不存在；此入口仅切换已有服务。",
          );
        source = setTomlBoolean(
          source,
          ["mcp_servers", change.name, "enabled"],
          change.enabled,
        );
      } else if (change.kind === "setting") {
        source = setTomlBoolean(source, change.name.split("."), change.enabled);
      } else {
        const catalog = await discoverSkills({
          includeDisabled: true,
          config: current.config.skills?.config ?? [],
          ...(change.workdir
            ? { workdir: resolveUserPath(change.workdir) }
            : {}),
        });
        const file = await realpath(change.path).catch(() => change.path);
        const skill = catalog.skills.find((item) => item.path === file);
        if (!skill)
          throw new ConfigEditError(
            404,
            "该目录中未发现此 Skill，请刷新 Skill 列表。",
          );
        const rules = current.config.skills?.config ?? [];
        let matchingPath: number | undefined;
        for (let index = rules.length - 1; index >= 0; index--) {
          const rule = rules[index]!;
          if (
            "path" in rule &&
            (await realpath(rule.path).catch(() => rule.path)) === file
          ) {
            matchingPath = index;
            break;
          }
          if ("name" in rule && rule.name === skill.name) break;
        }
        source =
          matchingPath === undefined
            ? appendSkillRule(source, rules, file, change.enabled)
            : setTomlBoolean(
                source,
                ["skills", "config", matchingPath, "enabled"],
                change.enabled,
              );
      }
      // Validate the entire resulting configuration before touching the original file.
      try {
        parseConfig(source, this.filename);
      } catch {
        throw new ConfigEditError(
          422,
          "此配置写法无法安全地只切换该字段，请在终端编辑。",
        );
      }
      const temporary = path.join(
        path.dirname(current.filename),
        `.exec-mcp-config-${randomUUID()}.tmp`,
      );
      try {
        const info = await stat(current.filename);
        await writeFile(temporary, source, {
          flag: "wx",
          mode: info.mode & 0o777,
        });
        if ((await this.read()).revision !== revision)
          throw new ConfigEditError(
            409,
            "配置已被其他操作修改，请刷新后重试。",
          );
        await rename(temporary, current.filename);
      } finally {
        await rm(temporary, { force: true });
      }
      return this.read();
    });
  }
}

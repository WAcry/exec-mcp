import { constants } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { parseDocument } from "yaml";
import { MAX_PAYLOAD_BYTES } from "../limits.js";
import type { SkillCatalog, SkillMetadata, SkillSetting } from "./types.js";

export interface DiscoverSkillsOptions {
  homeDir?: string;
  workdir?: string;
  signal?: AbortSignal;
  config?: readonly SkillSetting[];
  /** Management-only discovery. Model-facing calls keep disabled metadata hidden. */
  includeDisabled?: boolean;
}

/** Metadata only: no shell, configuration imports, installation or persistent scan cache. */
export async function discoverSkills(
  options: DiscoverSkillsOptions = {},
): Promise<SkillCatalog> {
  const { signal } = options;
  signal?.throwIfAborted();
  const home = path.resolve(options.homeDir ?? homedir());
  const enabled = await skillSelection(options.config ?? [], signal);
  const catalog: SkillCatalog = { skills: [], warnings: [] };
  const warn = (file: string, message: string) =>
    catalog.warnings.push(`${JSON.stringify(file)}：${message}`);
  const roots: string[] = [];
  if (options.workdir !== undefined) {
    try {
      roots.push(...(await projectRoots(options.workdir, signal)));
    } catch {
      signal?.throwIfAborted();
      warn(options.workdir, "无法确认项目范围；仍列出用户级 Skills。");
    }
  }
  roots.push(
    path.join(home, ".agents", "skills"),
    path.join(home, ".codex", "skills"),
  );
  const visited = new Set<string>();
  const files = new Set<string>();

  for (const root of roots) {
    // Missing roots are normal; dangling symlinks and other errors are not empty catalogs.
    try {
      await lstat(root);
    } catch (error) {
      signal?.throwIfAborted();
      if (!missing(error)) warn(root, "无法检查 Skill 根目录。");
      continue;
    }
    const queue = [root];
    while (queue.length) {
      signal?.throwIfAborted();
      const candidate = queue.pop()!;
      let directory: string;
      let entries: string[];
      // Keep the traversal iterative: real directories, not nesting depth, prevent cycles.
      try {
        directory = await realpath(candidate);
        if (visited.has(directory)) continue;
        visited.add(directory);
        entries = await readdir(directory);
      } catch {
        signal?.throwIfAborted();
        warn(candidate, "无法读取目录或软链接目标。");
        continue;
      }
      entries.sort(compare);
      const skillName = entries.find((name) =>
        process.platform === "win32"
          ? name.toUpperCase() === "SKILL.MD"
          : name === "SKILL.md",
      );
      if (skillName !== undefined) {
        const discovered = path.join(directory, skillName);
        let target: string;
        try {
          target = await realpath(discovered);
        } catch {
          signal?.throwIfAborted();
          warn(discovered, "无法解析 SKILL.md 的真实路径。");
          continue;
        }
        if (files.has(target)) continue;
        files.add(target);
        if (!options.includeDisabled && !enabled(target)) continue;
        try {
          const metadata = mapping(
            parseYaml(await readMetadata(target, true, signal)),
          );
          const selected = enabled(
            target,
            typeof metadata.name === "string" ? metadata.name.trim() : "",
          );
          if (
            !options.includeDisabled &&
            !enabled(
              target,
              typeof metadata.name === "string" ? metadata.name.trim() : "",
            )
          )
            continue;
          if (
            typeof metadata.name !== "string" ||
            !metadata.name.trim() ||
            typeof metadata.description !== "string" ||
            !metadata.description.trim()
          )
            throw new Error("missing metadata");
          const policyPath = path.join(
            path.dirname(target),
            "agents",
            "openai.yaml",
          );
          let implicit = true;
          try {
            const yaml = await readMetadata(policyPath, false, signal);
            const document = parseYaml(yaml);
            if (document !== null) {
              const policy = mapping(document).policy;
              if (policy !== undefined) {
                const object = mapping(policy);
                if (
                  Object.keys(object).some(
                    (key) => key !== "allow_implicit_invocation",
                  )
                )
                  throw new Error("unknown policy");
                const allow = object.allow_implicit_invocation;
                if (allow !== undefined && typeof allow !== "boolean")
                  throw new Error("invalid policy");
                implicit = allow !== false;
              }
            }
          } catch (error) {
            signal?.throwIfAborted();
            let absent = false;
            if (missing(error)) {
              try {
                await lstat(policyPath);
              } catch (check) {
                absent = missing(check);
              }
            }
            if (!absent) {
              implicit = false;
              warn(
                policyPath,
                "调用策略无法确认；仅用户明确要求使用时读取，不展示触发描述。",
              );
            }
          }
          const skill: SkillMetadata = {
            name: metadata.name.trim(),
            path: target,
            implicit,
          };
          if (implicit) skill.description = metadata.description.trim();
          if (options.includeDisabled) skill.enabled = selected;
          catalog.skills.push(skill);
        } catch {
          signal?.throwIfAborted();
          if (!enabled(target, "")) continue;
          warn(
            target,
            "SKILL.md 元数据不可读或无有效 name/description；未列出该 Skill。",
          );
        }
        // A bundle is a leaf, even when malformed. Don't scan scripts/vendor/references.
        continue;
      }
      for (const name of entries.toReversed()) {
        signal?.throwIfAborted();
        if ([".git", ".hg", ".svn"].includes(name)) continue;
        const child = path.join(directory, name);
        try {
          const entry = await lstat(child);
          if (entry.isDirectory()) queue.push(child);
          else if (entry.isSymbolicLink()) {
            if ((await stat(child)).isDirectory()) queue.push(child);
          }
        } catch {
          signal?.throwIfAborted();
          warn(child, "无法检查条目或软链接目标。");
        }
      }
    }
  }
  signal?.throwIfAborted();
  return catalog;
}

/** Match Codex's ordered name/path selectors; a missing rule means enabled.
 * Resolve paths on each scan so a moved symlink cannot leave stale enablement.
 */
async function skillSelection(
  settings: readonly SkillSetting[],
  signal?: AbortSignal,
) {
  const rules: SkillSetting[] = [];
  for (const setting of settings) {
    signal?.throwIfAborted();
    if ("name" in setting) rules.push(setting);
    else {
      const selected = path.resolve(setting.path);
      let resolved = selected;
      try {
        resolved = await realpath(selected);
      } catch {
        signal?.throwIfAborted(); /* An absent configured file may appear on a later scan. */
      }
      rules.push({ path: resolved, enabled: setting.enabled });
    }
  }
  return (file: string, name?: string): boolean => {
    let result = true;
    for (const rule of rules) {
      if ("path" in rule) {
        if (rule.path === file) result = rule.enabled;
      } else if (name === undefined) {
        // Before parsing, a later enabling name rule may restore a disabled path.
        // Do not skip its metadata until the name is known.
        if (rule.enabled) result = true;
      } else if (rule.name === name) result = rule.enabled;
    }
    return result;
  };
}

async function projectRoots(
  workdir: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const start = await realpath(workdir);
  if (!(await stat(start)).isDirectory())
    throw new Error("workdir is not a directory");
  const ancestors: string[] = [];
  let current = start;
  while (true) {
    signal?.throwIfAborted();
    ancestors.push(path.join(current, ".agents", "skills"));
    try {
      const git = await stat(path.join(current, ".git"));
      if (git.isDirectory() || git.isFile()) return ancestors;
    } catch (error) {
      if (!missing(error)) throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) return [ancestors[0]!];
    current = parent;
  }
}

function parseYaml(source: string): unknown {
  const document = parseDocument(source, {
    schema: "core",
    prettyErrors: false,
    uniqueKeys: true,
  });
  if (document.errors.length || document.warnings.length)
    throw new Error("invalid YAML");
  // Retain the parser's alias-expansion protection; do not evaluate custom YAML tags.
  return document.toJS({ maxAliasCount: 100 });
}
function mapping(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("expected mapping");
  return value as Record<string, unknown>;
}
function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Stop at the frontmatter terminator instead of reading/hashing the Skill body. */
async function readMetadata(
  filename: string,
  frontmatter: boolean,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const handle = await open(
    filename,
    constants.O_RDONLY | (constants.O_NONBLOCK ?? 0),
  );
  try {
    if (!(await handle.stat()).isFile())
      throw new Error("metadata must be a regular file");
    const decoder = new StringDecoder("utf8");
    const buffer = Buffer.alloc(8192);
    const lines: string[] = [];
    const fragments: string[] = [];
    let first = true,
      bytes = 0;
    const consume = (line: string): boolean => {
      line = line.replace(/\r$/, "");
      if (first) {
        first = false;
        if (line.replace(/^\uFEFF/, "").trim() !== "---")
          throw new Error("missing frontmatter");
      } else if (["---", "..."].includes(line.trim())) return true;
      else lines.push(line);
      return false;
    };
    while (true) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      signal?.throwIfAborted();
      bytes += bytesRead;
      if (bytes > MAX_PAYLOAD_BYTES)
        throw new Error("metadata exceeds the transport safety bound");
      const chunk = bytesRead
        ? decoder.write(buffer.subarray(0, bytesRead))
        : decoder.end();
      if (!frontmatter) {
        lines.push(chunk);
        if (!bytesRead) return lines.join("");
        continue;
      }
      let newline: number,
        start = 0;
      while ((newline = chunk.indexOf("\n", start)) >= 0) {
        fragments.push(chunk.slice(start, newline));
        const complete = fragments.join("");
        fragments.length = 0;
        start = newline + 1;
        if (consume(complete)) return lines.join("\n");
      }
      fragments.push(chunk.slice(start));
      if (!bytesRead) {
        if (consume(fragments.join(""))) return lines.join("\n");
        throw new Error("unterminated frontmatter");
      }
    }
  } finally {
    await handle.close();
  }
}

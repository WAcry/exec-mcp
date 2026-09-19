import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { connect, cellId, jsonOutput, nodeCommand, texts } from "./helpers.js";
import { CONFIG_TEMPLATE, parseConfig } from "../src/config.js";
import { characterCount } from "../src/skills/render.js";

// Use a real temporary home without touching the service operator's own Skills.
const environment = vi.hoisted(() => ({ home: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => environment.home || actual.homedir() };
});
const clients: Awaited<ReturnType<typeof connect>>[] = [];
let dir: string;
beforeEach(async () => {
  dir = await realpath(await mkdtemp(path.join(tmpdir(), "exec-skills-mcp-")));
  environment.home = path.join(dir, "home");
  await mkdir(environment.home);
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  environment.home = "";
  await rm(dir, { recursive: true, force: true });
});
async function skill(
  root: string,
  name: string,
  description = `description ${name}`,
  explicit = false,
) {
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\nBODY_ONLY_READ_WHEN_SELECTED\n`,
  );
  if (explicit) {
    await mkdir(path.join(root, "agents"));
    await writeFile(
      path.join(root, "agents", "openai.yaml"),
      "policy:\n  allow_implicit_invocation: false\n",
    );
  }
}
async function connection(legacy: boolean, maxChars?: number) {
  const value = await connect(
    maxChars === undefined ? {} : { skills: { max_chars: maxChars } },
    legacy,
  );
  clients.push(value);
  return value;
}
function directoryText(result: CallToolResult): string {
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  const matches = texts(result).filter((text) =>
    text.startsWith("Skill 目录："),
  );
  expect(matches).toHaveLength(1);
  expect(result.structuredContent).toBeUndefined();
  return matches[0]!;
}

describe.each([false, true])(
  "Skill discovery through the real host and MCP (legacy=%s)",
  (legacy) => {
    it("applies TOML enablement across user and project skills without changing either tool catalog", async () => {
      await skill(
        path.join(environment.home, ".agents", "skills", "release"),
        "release",
        "USER_RELEASE_TRIGGER",
      );
      await skill(
        path.join(environment.home, ".codex", "skills", "release"),
        "release",
        "CODEX_RELEASE_TRIGGER",
      );
      await skill(
        path.join(environment.home, ".agents", "skills", "general"),
        "general",
      );
      await skill(
        path.join(environment.home, ".agents", "skills", "manual"),
        "manual",
        "PRIVATE_MANUAL_TRIGGER",
        true,
      );
      const project = path.join(dir, "repo");
      await mkdir(path.join(project, ".git"), { recursive: true });
      const local = path.join(project, ".agents", "skills", "release");
      await skill(local, "release", "PROJECT_RELEASE_TRIGGER");
      const config = parseConfig(
        CONFIG_TEMPLATE +
          `
[skills]
max_chars = 4000
[[skills.config]]
name = "release"
enabled = false
[[skills.config]]
path = "./repo/.agents/skills/release/SKILL.md"
enabled = true
[[skills.config]]
name = "manual"
enabled = true
`,
        path.join(dir, "config.toml"),
      );
      const plain = await connection(legacy);
      const configured = await connect({ skills: config.skills! }, legacy);
      clients.push(configured);
      expect((await configured.client.listTools()).tools).toEqual(
        (await plain.client.listTools()).tools,
      );
      const catalogCall = {
        name: "exec",
        arguments: {
          source: 'text(ALL_TOOLS.find(tool=>tool.name==="list_skills"));',
        },
      };
      expect(jsonOutput(await configured.client.callTool(catalogCall))).toEqual(
        jsonOutput(await plain.client.callTool(catalogCall)),
      );
      const output = directoryText(
        await configured.client.callTool({
          name: "exec",
          arguments: {
            workdir: project,
            source: "text(await tools.list_skills({}));",
          },
        }),
      );
      expect(output).toContain("3 项");
      expect(output).toContain("PROJECT_RELEASE_TRIGGER");
      expect(output).not.toMatch(
        /USER_RELEASE_TRIGGER|CODEX_RELEASE_TRIGGER|PRIVATE_MANUAL_TRIGGER|skills.config|enabled/,
      );
      expect(output).toContain('"general"');
      expect(output).toContain('"manual"');
      expect(output).toContain("仅用户明确要求使用时才可读取");
      expect(characterCount(output)).toBeLessThanOrEqual(4000);
    });
    it("can explicitly enable a previously disabled name while unchanged instances retain their own settings", async () => {
      const root = path.join(environment.home, ".agents", "skills", "toggle");
      await skill(root, "toggle");
      const filename = path.join(dir, "config.toml");
      const disabledConfig = parseConfig(
        CONFIG_TEMPLATE + '\n[[skills.config]]\nname="toggle"\nenabled=false\n',
        filename,
      );
      const enabledConfig = parseConfig(
        CONFIG_TEMPLATE + '\n[[skills.config]]\nname="toggle"\nenabled=true\n',
        filename,
      );
      const disabled = await connect(
        { skills: disabledConfig.skills! },
        legacy,
      );
      const enabled = await connect({ skills: enabledConfig.skills! }, legacy);
      clients.push(disabled, enabled);
      const call = {
        name: "exec",
        arguments: { source: "text(await tools.list_skills({}));" },
      };
      expect(directoryText(await disabled.client.callTool(call))).toContain(
        "0 项",
      );
      expect(directoryText(await enabled.client.callTool(call))).toContain(
        '"toggle"',
      );
      expect(directoryText(await disabled.client.callTool(call))).not.toContain(
        '"toggle"',
      );
      const restored = await connection(legacy);
      expect(directoryText(await restored.client.callTool(call))).toContain(
        '"toggle"',
      );
    });
    it("disables a real Skill reached through multiple directory links before returning metadata", async () => {
      const shared = path.join(dir, "shared-hidden");
      await skill(shared, "HIDDEN_ALIAS_SKILL", "HIDDEN_ALIAS_TRIGGER");
      const genericRoot = path.join(environment.home, ".agents", "skills");
      const codexRoot = path.join(environment.home, ".codex", "skills");
      await mkdir(genericRoot, { recursive: true });
      await mkdir(codexRoot, { recursive: true });
      await symlink(
        shared,
        path.join(genericRoot, "alias"),
        process.platform === "win32" ? "junction" : "dir",
      );
      await symlink(
        shared,
        path.join(codexRoot, "alias"),
        process.platform === "win32" ? "junction" : "dir",
      );
      const config = parseConfig(
        CONFIG_TEMPLATE +
          '\n[[skills.config]]\npath="~/.agents/skills/alias/SKILL.md"\nenabled=false\n',
        path.join(dir, "config.toml"),
      );
      const c = await connect({ skills: config.skills! }, legacy);
      clients.push(c);
      const output = directoryText(
        await c.client.callTool({
          name: "exec",
          arguments: { source: "text(await tools.list_skills({}));" },
        }),
      );
      expect(output).toContain("0 项");
      expect(output).not.toMatch(/HIDDEN_ALIAS|shared-hidden|enabled|禁用/);
    });
    it("returns the full default-budget directory above 10000 characters over the actual transport", async () => {
      const c = await connection(legacy);
      for (let start = 0; start < 180; start += 12) {
        await Promise.all(
          Array.from({ length: 12 }, (_, offset) => {
            const name = `large-${start + offset}`;
            return skill(
              path.join(environment.home, ".agents", "skills", name),
              name,
              "用途描述 ".repeat(150),
            );
          }),
        );
      }
      const result = await c.client.callTool({
        name: "exec",
        arguments: { source: "text(await tools.list_skills({}));" },
      });
      const text = directoryText(result);
      expect(characterCount(text)).toBeLessThanOrEqual(40000);
      expect(characterCount(text)).toBeGreaterThan(10000);
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(34000);
      expect(JSON.stringify(result)).not.toContain("返回文本已达");
      for (let i = 0; i < 180; i++) expect(text).toContain(`"large-${i}"`);
      expect(text).not.toContain("BODY_ONLY_READ_WHEN_SELECTED");
    });
    it("keeps only exec/wait at the top level and returns a single directory string through the internal tool", async () => {
      const c = await connection(legacy);
      const tools = (await c.client.listTools()).tools;
      expect(tools.map((tool) => tool.name)).toEqual(["exec", "wait"]);
      expect(tools[0]!.description).toContain(
        "先 text(await tools.list_skills({}))",
      );
      expect(tools[0]!.description).not.toMatch(
        /40000|max_chars|round.?robin/i,
      );
      await skill(
        path.join(environment.home, ".agents", "skills", "generic"),
        "generic",
      );
      await skill(
        path.join(environment.home, ".codex", "skills", "manual"),
        "manual",
        "PRIVATE_MANUAL_TRIGGER",
        true,
      );
      const result = await c.client.callTool({
        name: "exec",
        arguments: { source: "text(await tools.list_skills({}));" },
      });
      const text = directoryText(result);
      expect(text).toContain('"generic"');
      expect(text).toContain('"manual"');
      expect(text).not.toContain("PRIVATE_MANUAL_TRIGGER");
      expect(text).not.toContain("BODY_ONLY_READ_WHEN_SELECTED");
      const catalog = await c.client.callTool({
        name: "exec",
        arguments: {
          source: 'text(ALL_TOOLS.filter(tool=>tool.name==="list_skills"));',
        },
      });
      const [entry] =
        jsonOutput<{ name: string; description: string }[]>(catalog);
      expect(entry).toMatchObject({ name: "list_skills" });
      expect(entry!.description).toContain("workdir");
      expect(entry!.description).not.toContain("PRIVATE_MANUAL_TRIGGER");
    });
    it("inherits only an explicit exec.workdir and lets an internal workdir override it", async () => {
      const c = await connection(legacy);
      await skill(
        path.join(environment.home, ".agents", "skills", "global"),
        "global",
      );
      const project = path.join(dir, "project");
      const other = path.join(dir, "other");
      const nested = path.join(project, "src");
      await mkdir(nested, { recursive: true });
      await mkdir(path.join(project, ".git"));
      await skill(
        path.join(project, ".agents", "skills", "project"),
        "project",
      );
      await skill(path.join(other, ".agents", "skills", "other"), "other");
      const noProject = directoryText(
        await c.client.callTool({
          name: "exec",
          arguments: { source: "text(await tools.list_skills({}));" },
        }),
      );
      expect(noProject).toContain('"global"');
      expect(noProject).not.toContain('"project"');
      const inherited = directoryText(
        await c.client.callTool({
          name: "exec",
          arguments: {
            source: "text(await tools.list_skills({}));",
            workdir: nested,
          },
        }),
      );
      expect(inherited).toContain('"project"');
      expect(inherited).toContain('"global"');
      const explicit = directoryText(
        await c.client.callTool({
          name: "exec",
          arguments: {
            workdir: project,
            source: 'text(await tools.list_skills({workdir:"../other"}));',
          },
        }),
      );
      expect(explicit).toContain('"other"');
      expect(explicit).toContain('"global"');
      expect(explicit).not.toContain('"project"');
    });
    it("uses the TOML budget, protects explicit entries and preserves every name without a second JSON mirror", async () => {
      const config = parseConfig(
        CONFIG_TEMPLATE + "\n[skills]\nmax_chars=1800\n",
        "config.toml",
      );
      const c = await connection(legacy, config.skills!.max_chars);
      for (let i = 0; i < 12; i++)
        await skill(
          path.join(environment.home, ".agents", "skills", `skill-${i}`),
          `skill-${i}`,
          (i === 4 ? "PRIVATE_EXPLICIT" : "very-long-description-").repeat(120),
          i === 4,
        );
      const result = await c.client.callTool({
        name: "exec",
        arguments: { source: "text(await tools.list_skills({}));" },
      });
      const text = directoryText(result);
      expect(characterCount(text)).toBeLessThanOrEqual(1800);
      for (let i = 0; i < 12; i++) expect(text).toContain(`"skill-${i}"`);
      expect(text).toContain("描述按公平前缀压缩");
      expect(text).not.toContain("PRIVATE_EXPLICIT");
      expect(texts(result)).toHaveLength(2); // Status plus the one explicitly emitted directory.
    });
    it("can deliver the directory after yielding and refresh policy changes across execs", async () => {
      const c = await connection(legacy);
      const bundle = path.join(environment.home, ".agents", "skills", "live");
      await skill(bundle, "live", "trigger-before");
      const first = await c.client.callTool({
        name: "exec",
        arguments: {
          source:
            "yield_control();await new Promise(r=>setTimeout(r,60));text(await tools.list_skills({}));",
        },
      });
      const result = await c.client.callTool({
        name: "wait",
        arguments: { cell_id: cellId(first) },
      });
      expect(directoryText(result)).toContain("trigger-before");
      await mkdir(path.join(bundle, "agents"));
      await writeFile(
        path.join(bundle, "agents", "openai.yaml"),
        "policy:\n  allow_implicit_invocation: false\n",
      );
      const after = directoryText(
        await c.client.callTool({
          name: "exec",
          arguments: { source: "text(await tools.list_skills({}));" },
        }),
      );
      expect(after).toContain('"live"');
      expect(after).not.toContain("trigger-before");
      expect(after).toContain("仅用户明确要求使用时才可读取");
    });
    it("follows a directory link to real auxiliary files and leaves full reading to exec_command", async () => {
      const c = await connection(legacy);
      const actual = path.join(dir, "shared-bundle");
      await skill(actual, "linked");
      await mkdir(path.join(actual, "references"));
      await writeFile(
        path.join(actual, "references", "guide.txt"),
        "ACTUAL_AUXILIARY_FILE",
      );
      const root = path.join(environment.home, ".agents", "skills");
      await mkdir(root, { recursive: true });
      await symlink(
        actual,
        path.join(root, "alias"),
        process.platform === "win32" ? "junction" : "dir",
      );
      const text = directoryText(
        await c.client.callTool({
          name: "exec",
          arguments: { source: "text(await tools.list_skills({}));" },
        }),
      );
      expect(text).toContain(JSON.stringify(path.join(actual, "SKILL.md")));
      const command = nodeCommand(
        `const fs=require('node:fs');console.log(fs.readFileSync(${JSON.stringify(path.join(actual, "SKILL.md"))},'utf8'));console.log(fs.readFileSync(${JSON.stringify(path.join(actual, "references", "guide.txt"))},'utf8'));`,
      );
      const read = await c.client.callTool({
        name: "exec",
        arguments: {
          source: `text(await tools.exec_command({cmd:${JSON.stringify(command)},yield_time_ms:30000}));`,
        },
      });
      const content = jsonOutput<{ output: string; exit_code: number }>(read);
      expect(content.exit_code).toBe(0);
      expect(content.output).toContain("BODY_ONLY_READ_WHEN_SELECTED");
      expect(content.output).toContain("ACTUAL_AUXILIARY_FILE");
    });
  },
);

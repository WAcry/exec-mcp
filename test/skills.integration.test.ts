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
      expect(characterCount(text)).toBeGreaterThan(39990);
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
      expect(tools[0]!.description).toContain("40000");
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

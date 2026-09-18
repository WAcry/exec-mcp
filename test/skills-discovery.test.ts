import { afterEach, describe, expect, it } from "vitest";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { discoverSkills } from "../src/skills/discover.js";
import { listSkills } from "../src/skills/index.js";

const dirs: string[] = [];
async function directory() {
  const dir = await realpath(
    await mkdtemp(path.join(tmpdir(), "exec-skills-")),
  );
  dirs.push(dir);
  return dir;
}
async function skill(
  root: string,
  name: string,
  description = `用途 ${name}`,
  policy?: string,
): Promise<string> {
  await mkdir(root, { recursive: true });
  const file = path.join(root, "SKILL.md");
  await writeFile(
    file,
    `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\nPRIVATE_BODY_NOT_METADATA\n`,
  );
  if (policy !== undefined) {
    await mkdir(path.join(root, "agents"), { recursive: true });
    await writeFile(path.join(root, "agents", "openai.yaml"), policy);
  }
  return file;
}
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("live metadata discovery", () => {
  it("reads frontmatter across buffer boundaries but does not scan a large Skill body", async () => {
    const home = await directory();
    const bundle = path.join(home, ".agents", "skills", "large");
    const description = "line of text ".repeat(1800) + "😀末尾";
    const file = await skill(bundle, "large", description);
    await truncate(file, 64 * 1024 * 1024);
    const result = await discoverSkills({ homeDir: home });
    expect(result.warnings).toEqual([]);
    expect(result.skills[0]!.description).toBe(description);
    expect(result.skills[0]!.path).toBe(file);
    expect(JSON.stringify(result).length).toBeLessThan(30000);
  });
  it("always finds both user roots without a project and does not load bodies or create directories", async () => {
    const home = await directory();
    expect(await discoverSkills({ homeDir: home })).toEqual({
      skills: [],
      warnings: [],
    });
    await expect(stat(path.join(home, ".agents"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const generic = await skill(
      path.join(home, ".agents", "skills", "review"),
      "review",
    );
    const codex = await skill(
      path.join(home, ".codex", "skills", "coding"),
      "coding",
    );
    const result = await discoverSkills({ homeDir: home });
    expect(result.skills).toEqual([
      {
        name: "review",
        path: generic,
        description: "用途 review",
        implicit: true,
      },
      {
        name: "coding",
        path: codex,
        description: "用途 coding",
        implicit: true,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_BODY");
  });
  it("finds ancestors up to a .git directory, nearest project first, without sibling or outside projects", async () => {
    const dir = await directory();
    const home = path.join(dir, "home");
    const repo = path.join(dir, "repo");
    const cwd = path.join(repo, "services", "api", "src");
    await mkdir(cwd, { recursive: true });
    await mkdir(path.join(repo, ".git"));
    await skill(path.join(repo, ".agents", "skills", "root"), "root");
    await skill(
      path.join(repo, "services", "api", ".agents", "skills", "near"),
      "near",
    );
    await skill(
      path.join(repo, "other", ".agents", "skills", "sibling"),
      "sibling",
    );
    await skill(path.join(dir, ".agents", "skills", "outside"), "outside");
    await skill(path.join(home, ".agents", "skills", "global"), "global");
    const result = await discoverSkills({ homeDir: home, workdir: cwd });
    expect(result.skills.map((item) => item.name)).toEqual([
      "near",
      "root",
      "global",
    ]);
    expect(result.warnings).toEqual([]);
  });
  it("recognizes a worktree/submodule .git file and ignores parent repository skills", async () => {
    const dir = await directory();
    const outer = path.join(dir, "outer");
    const inner = path.join(outer, "worktree");
    await mkdir(inner, { recursive: true });
    await mkdir(path.join(outer, ".git"));
    await writeFile(path.join(inner, ".git"), "gitdir: ../elsewhere\n");
    await skill(path.join(outer, ".agents", "skills", "outer"), "outer");
    await skill(path.join(inner, ".agents", "skills", "inner"), "inner");
    expect(
      (
        await discoverSkills({
          homeDir: path.join(dir, "home"),
          workdir: inner,
        })
      ).skills.map((item) => item.name),
    ).toEqual(["inner"]);
  });
  it("without a git boundary only uses the explicit directory, and warns rather than hiding global skills on bad workdir", async () => {
    const dir = await directory();
    const home = path.join(dir, "home");
    const child = path.join(dir, "project");
    await mkdir(child);
    await skill(path.join(dir, ".agents", "skills", "parent"), "parent");
    await skill(path.join(child, ".agents", "skills", "child"), "child");
    await skill(path.join(home, ".codex", "skills", "global"), "global");
    expect(
      (await discoverSkills({ homeDir: home, workdir: child })).skills.map(
        (item) => item.name,
      ),
    ).toEqual(["child", "global"]);
    const missing = await discoverSkills({
      homeDir: home,
      workdir: path.join(dir, "missing"),
    });
    expect(missing.skills.map((item) => item.name)).toEqual(["global"]);
    expect(missing.warnings).toHaveLength(1);
  });
  it("supports nested collections and hidden .system bundles without scanning inside a skill bundle or .git", async () => {
    const home = await directory();
    const root = path.join(home, ".codex", "skills");
    await skill(path.join(root, ".system", "builtin"), "builtin");
    await skill(path.join(root, "collection", "workflow"), "workflow");
    await skill(
      path.join(root, "collection", "workflow", "references", "not-a-skill"),
      "should-not-scan",
    );
    await skill(path.join(root, ".git", "internal"), "git-internal");
    expect(
      (await discoverSkills({ homeDir: home })).skills.map((item) => item.name),
    ).toEqual(["builtin", "workflow"]);
  });
  it("handles YAML folded/block descriptions, BOM and CRLF without parsing the Markdown body", async () => {
    const home = await directory();
    const root = path.join(home, ".agents", "skills", "multi");
    const file = await skill(root, "temporary");
    await writeFile(
      file,
      "\uFEFF---\r\nname: 测试😀\r\ndescription: >\r\n  第一行\r\n  第二行\r\n---\r\nnot: [valid YAML BODY_SECRET",
    );
    const before = await stat(file);
    expect((await discoverSkills({ homeDir: home })).skills).toEqual([
      {
        name: "测试😀",
        description: "第一行 第二行",
        path: file,
        implicit: true,
      },
    ]);
    expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
    expect(await readFile(file, "utf8")).toContain("BODY_SECRET");
  });
  it("refreshes edits/removal on every call and never caches a prior empty catalog", async () => {
    const home = await directory();
    expect((await discoverSkills({ homeDir: home })).skills).toEqual([]);
    const root = path.join(home, ".agents", "skills", "live");
    await skill(root, "first");
    expect((await discoverSkills({ homeDir: home })).skills[0]!.name).toBe(
      "first",
    );
    await skill(root, "second");
    expect((await discoverSkills({ homeDir: home })).skills[0]!.name).toBe(
      "second",
    );
    await rm(root, { recursive: true });
    expect((await discoverSkills({ homeDir: home })).skills).toEqual([]);
  });
  it.each([
    "missing frontmatter",
    "---\nname: missing-description\n---",
    "---\nname: x\ndescription: [not, text]\n---",
    "---\nname: x\nname: y\ndescription: test\n---",
    "---\nname: x\ndescription: unterminated",
  ])(
    "reports invalid metadata without echoing file contents",
    async (source) => {
      const home = await directory();
      const root = path.join(home, ".agents", "skills", "bad");
      const file = await skill(root, "temp");
      await writeFile(file, source + "\nPRIVATE_PARSE_INPUT");
      const result = await discoverSkills({ homeDir: home });
      expect(result.skills).toEqual([]);
      expect(result.warnings).toHaveLength(1);
      expect(JSON.stringify(result)).not.toContain("PRIVATE_PARSE_INPUT");
    },
  );
  it("allows valid YAML aliases but rejects cyclic/non-string metadata and pre-aborted work", async () => {
    const home = await directory();
    const root = path.join(home, ".agents", "skills", "alias");
    const file = await skill(root, "temp");
    await writeFile(
      file,
      "---\nlabel: &name anchored\nname: *name\ndescription: useful task\n---\n",
    );
    expect((await discoverSkills({ homeDir: home })).skills[0]!.name).toBe(
      "anchored",
    );
    await expect(
      discoverSkills({ homeDir: home, signal: AbortSignal.abort() }),
    ).rejects.toThrow();
  });
});

describe("real paths and invocation policy", () => {
  it("follows symlinked user roots, collection links and loops with one entry per real file", async () => {
    const dir = await directory();
    const home = path.join(dir, "home");
    const shared = path.join(dir, "shared");
    const review = await skill(path.join(shared, "review"), "same-name");
    const other = await skill(path.join(shared, "other"), "same-name");
    await mkdir(path.join(home, ".agents"), { recursive: true });
    await mkdir(path.join(home, ".codex"), { recursive: true });
    const type = process.platform === "win32" ? "junction" : "dir";
    await symlink(shared, path.join(home, ".agents", "skills"), type);
    await symlink(shared, path.join(home, ".codex", "skills"), type);
    await symlink(shared, path.join(shared, "cycle"), type);
    await mkdir(path.join(shared, "aliases"));
    await symlink(
      path.dirname(review),
      path.join(shared, "aliases", "review"),
      type,
    );
    const result = await discoverSkills({ homeDir: home });
    expect(result.warnings).toEqual([]);
    expect(result.skills.map((item) => item.path).sort()).toEqual(
      [review, other].sort(),
    );
    expect(result.skills.every((item) => item.name === "same-name")).toBe(true);
  });
  it.skipIf(process.platform === "win32")(
    "resolves a file symlink to the actual bundle policy and auxiliary-file directory",
    async () => {
      const home = await directory();
      const target = path.join(home, "real-bundle");
      const file = await skill(
        target,
        "manual",
        "TRIGGER_MUST_NOT_BE_SHOWN",
        "policy:\n  allow_implicit_invocation: false\n",
      );
      await mkdir(path.join(target, "references"));
      await writeFile(path.join(target, "references", "guide.md"), "auxiliary");
      const alias = path.join(home, ".agents", "skills", "linked");
      await mkdir(path.join(alias, "agents"), { recursive: true });
      await writeFile(
        path.join(alias, "agents", "openai.yaml"),
        "policy:\n  allow_implicit_invocation: true\n",
      );
      await symlink(file, path.join(alias, "SKILL.md"));
      const result = await discoverSkills({ homeDir: home });
      expect(result.skills).toEqual([
        { name: "manual", path: file, implicit: false },
      ]);
      expect(
        await readFile(
          path.join(
            path.dirname(result.skills[0]!.path),
            "references",
            "guide.md",
          ),
          "utf8",
        ),
      ).toBe("auxiliary");
      expect(await listSkills({ homeDir: home })).not.toContain(
        "TRIGGER_MUST_NOT_BE_SHOWN",
      );
    },
  );
  it.each([
    "policy:\n  allow_implicit_invocation: false\n",
    "policy:\n  allow_implicit_invocation: 'false'\n",
    "policy:\n  allow_implicit_invocation: [broken\n",
    "policy: null\n",
    "policy:\n  allowImplicitInvocation: false\n",
  ])(
    "never exposes trigger descriptions when invocation policy is false or ambiguous",
    async (policy) => {
      const home = await directory();
      await skill(
        path.join(home, ".agents", "skills", "manual"),
        "manual",
        "PRIVATE_TRIGGER",
        policy,
      );
      const result = await discoverSkills({ homeDir: home });
      expect(result.skills[0]).toMatchObject({
        name: "manual",
        implicit: false,
      });
      expect(Object.hasOwn(result.skills[0]!, "description")).toBe(false);
      expect(await listSkills({ homeDir: home })).not.toContain(
        "PRIVATE_TRIGGER",
      );
      expect(result.warnings.length).toBe(
        policy.includes(": false\n") && !policy.includes("allowImplicit")
          ? 0
          : 1,
      );
    },
  );
  it.each([
    "",
    "interface:\n  display_name: Display\n",
    "policy: {}\n",
    "policy:\n  allow_implicit_invocation: true\n",
  ])(
    "keeps the default when no implicit invocation prohibition exists",
    async (policy) => {
      const home = await directory();
      await skill(
        path.join(home, ".agents", "skills", "auto"),
        "auto",
        "match this",
        policy,
      );
      const result = await discoverSkills({ homeDir: home });
      expect(result.skills[0]).toMatchObject({
        implicit: true,
        description: "match this",
      });
      expect(result.warnings).toEqual([]);
    },
  );
  it.skipIf(process.platform === "win32")(
    "reports dangling root links and treats dangling policy links as explicit-only",
    async () => {
      const home = await directory();
      await mkdir(path.join(home, ".agents"));
      await symlink(
        path.join(home, "missing"),
        path.join(home, ".agents", "skills"),
      );
      const dir = path.join(home, ".codex", "skills", "policy-link");
      await skill(dir, "policy-link", "hidden");
      await mkdir(path.join(dir, "agents"));
      await symlink(
        path.join(home, "missing.yaml"),
        path.join(dir, "agents", "openai.yaml"),
      );
      const result = await discoverSkills({ homeDir: home });
      expect(result.skills[0]!.implicit).toBe(false);
      expect(result.warnings).toHaveLength(2);
    },
  );
});

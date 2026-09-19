import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONFIG_TEMPLATE, parseConfig } from "../src/config.js";
import { discoverSkills } from "../src/skills/discover.js";
import { listSkills } from "../src/skills/index.js";
import type { SkillSetting } from "../src/skills/types.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function setup() {
  const home = await realpath(
    await mkdtemp(path.join(tmpdir(), "exec-skill-config-")),
  );
  directories.push(home);
  const generic = path.join(home, ".agents", "skills");
  const codex = path.join(home, ".codex", "skills");
  async function skill(root: string, name: string, manual = false) {
    await mkdir(root, { recursive: true });
    const file = path.join(root, "SKILL.md");
    await writeFile(
      file,
      `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify("TRIGGER_" + name)}\n---\nBODY_PRIVATE\n`,
    );
    if (manual) {
      await mkdir(path.join(root, "agents"), { recursive: true });
      await writeFile(
        path.join(root, "agents", "openai.yaml"),
        "policy:\n  allow_implicit_invocation: false\n",
      );
    }
    return file;
  }
  const discover = (config: SkillSetting[] = []) =>
    discoverSkills({ homeDir: home, config });
  return { home, generic, codex, skill, discover };
}

describe("Codex-style Skill configuration", () => {
  it("preserves default enablement and the existing character budget when no rules are supplied", () => {
    expect(parseConfig(CONFIG_TEMPLATE, "config.toml").skills).toBeUndefined();
    expect(
      parseConfig(CONFIG_TEMPLATE + "\n[skills]\n", "config.toml").skills,
    ).toEqual({ max_chars: 40000 });
    expect(
      parseConfig(
        CONFIG_TEMPLATE + "\n[skills]\nmax_chars=12000\nconfig=[]\n",
        "config.toml",
      ).skills,
    ).toEqual({ max_chars: 12000, config: [] });
  });
  it("accepts explicit booleans and exactly one selector, preserving rule order", () => {
    const filename = path.join(tmpdir(), "config with spaces", "config.toml");
    const text =
      CONFIG_TEMPLATE +
      `
[[skills.config]]
name = " review "
enabled = false
[[skills.config]]
path = "./local/SKILL.md"
enabled = true
[[skills.config]]
path = "~/.codex/skills/other/SKILL.md"
enabled = false
`;
    expect(parseConfig(text, filename).skills).toEqual({
      max_chars: 40000,
      config: [
        { name: "review", enabled: false },
        {
          path: path.join(path.dirname(filename), "local", "SKILL.md"),
          enabled: true,
        },
        {
          path: path.join(homedir(), ".codex", "skills", "other", "SKILL.md"),
          enabled: false,
        },
      ],
    });
  });
  it.each([
    'name="x"',
    'path="file/SKILL.md"',
    "enabled=false",
    'name="x"\npath="file/SKILL.md"\nenabled=false',
    'name="x"\nenabled="false"',
    'name="x"\nenabled=1',
    'name=" "\nenabled=false',
    'path=" "\nenabled=false',
    'path="bad\\u0000path"\nenabled=false',
    'name="x"\nenabled=false\nextra=true',
  ])(
    "rejects malformed or ambiguous entries rather than silently enabling them",
    (fields) => {
      expect(() =>
        parseConfig(
          CONFIG_TEMPLATE + `\n[[skills.config]]\n${fields}\n`,
          "config.toml",
        ),
      ).toThrow("skills.config");
    },
  );
});

describe("Skill enablement during discovery", () => {
  it("defaults unmentioned files to enabled and matches names exactly across user roots", async () => {
    const f = await setup();
    const generic = await f.skill(path.join(f.generic, "review"), "review");
    const codex = await f.skill(path.join(f.codex, "review"), "review");
    const other = await f.skill(
      path.join(f.generic, "review-extra"),
      "review-extra",
    );
    expect(
      (await f.discover()).skills.map((skill) => skill.path).sort(),
    ).toEqual([generic, codex, other].sort());
    const disabled = await f.discover([{ name: "review", enabled: false }]);
    expect(disabled.warnings).toEqual([]);
    expect(disabled.skills.map((skill) => skill.path)).toEqual([other]);
    expect(
      (await f.discover([{ name: "review", enabled: true }])).skills,
    ).toHaveLength(3);
    expect(
      (await f.discover([{ name: "REVIEW", enabled: false }])).skills,
    ).toHaveLength(3);
  });
  it("applies the last matching rule without giving paths automatic priority over later names", async () => {
    const f = await setup();
    const one = await f.skill(path.join(f.generic, "one"), "same");
    const two = await f.skill(path.join(f.codex, "two"), "same");
    const selected = async (rules: SkillSetting[]) =>
      (await f.discover(rules)).skills.map((skill) => skill.path).sort();
    expect(
      await selected([
        { name: "same", enabled: false },
        { path: two, enabled: true },
      ]),
    ).toEqual([two]);
    expect(
      await selected([
        { path: one, enabled: false },
        { name: "same", enabled: true },
      ]),
    ).toEqual([one, two].sort());
    expect(
      await selected([
        { path: one, enabled: true },
        { name: "same", enabled: false },
      ]),
    ).toEqual([]);
    expect(
      await selected([
        { path: one, enabled: false },
        { path: one, enabled: true },
      ]),
    ).toEqual([one, two].sort());
    expect(
      await selected([
        { path: one, enabled: true },
        { path: one, enabled: false },
      ]),
    ).toEqual([two]);
  });
  it("uses canonical paths so aliases cannot reintroduce a disabled file", async () => {
    const f = await setup();
    const shared = path.join(f.home, "shared");
    const file = await f.skill(shared, "linked");
    await mkdir(f.generic, { recursive: true });
    await mkdir(f.codex, { recursive: true });
    const alias = path.join(f.generic, "alias");
    const type = process.platform === "win32" ? "junction" : "dir";
    await symlink(shared, alias, type);
    await symlink(shared, path.join(f.codex, "other-alias"), type);
    const aliasFile = path.join(alias, "SKILL.md");
    expect(
      (await f.discover([{ path: aliasFile, enabled: false }])).skills,
    ).toEqual([]);
    expect((await f.discover([{ path: file, enabled: false }])).skills).toEqual(
      [],
    );
    const enabled = await f.discover([
      { path: aliasFile, enabled: false },
      { path: file, enabled: true },
    ]);
    expect(enabled.skills.map((skill) => skill.path)).toEqual([file]);
    expect(
      (
        await f.discover([
          { path: aliasFile, enabled: true },
          { path: file, enabled: false },
        ])
      ).skills,
    ).toEqual([]);
  });
  it.skipIf(process.platform === "win32")(
    "matches a symlinked SKILL.md itself, not just its containing directory",
    async () => {
      const f = await setup();
      const file = await f.skill(path.join(f.home, "source"), "linked-file");
      const directory = path.join(f.generic, "alias");
      await mkdir(directory, { recursive: true });
      const link = path.join(directory, "SKILL.md");
      await symlink(file, link);
      expect(
        (await f.discover([{ path: link, enabled: false }])).skills,
      ).toEqual([]);
      expect(
        (await f.discover([{ path: file, enabled: false }])).skills,
      ).toEqual([]);
    },
  );
  it("re-resolves changed links on later scans rather than caching an old target", async () => {
    const f = await setup();
    const one = await f.skill(path.join(f.generic, "one"), "one");
    const two = await f.skill(path.join(f.generic, "two"), "two");
    const alias = path.join(f.home, "configured-link");
    const type = process.platform === "win32" ? "junction" : "dir";
    await symlink(path.dirname(one), alias, type);
    const config: SkillSetting[] = [
      { path: path.join(alias, "SKILL.md"), enabled: false },
    ];
    expect(
      (await f.discover(config)).skills.map((skill) => skill.name),
    ).toEqual(["two"]);
    await rm(alias);
    await symlink(path.dirname(two), alias, type);
    expect(
      (await f.discover(config)).skills.map((skill) => skill.name),
    ).toEqual(["one"]);
  });
  it("does not add search roots and honors preconfigured disabled paths when they later appear", async () => {
    const f = await setup();
    const future = path.join(f.generic, "future", "SKILL.md");
    const outside = await f.skill(
      path.join(f.home, "outside-discovery"),
      "outside",
    );
    const rules: SkillSetting[] = [
      { path: future, enabled: false },
      { path: outside, enabled: true },
    ];
    expect(await f.discover(rules)).toEqual({ skills: [], warnings: [] });
    await f.skill(path.dirname(future), "future");
    expect(await f.discover(rules)).toEqual({ skills: [], warnings: [] });
    expect(
      (await f.discover([{ path: future, enabled: true }])).skills.map(
        (skill) => skill.name,
      ),
    ).toEqual(["future"]);
  });
  it("does not expose disabled metadata, policy warnings or state through the directory", async () => {
    const f = await setup();
    const bad = await f.skill(path.join(f.generic, "bad"), "BAD_SKILL_SECRET");
    await writeFile(bad, "not valid frontmatter");
    const named = await f.skill(
      path.join(f.generic, "named"),
      "NAMED_SKILL_SECRET",
    );
    await mkdir(path.join(path.dirname(named), "agents"));
    await writeFile(
      path.join(path.dirname(named), "agents", "openai.yaml"),
      "policy: [INVALID_SECRET",
    );
    const rules: SkillSetting[] = [
      { path: bad, enabled: false },
      { name: "unrelated-enable", enabled: true },
      { name: "NAMED_SKILL_SECRET", enabled: false },
    ];
    expect(await f.discover(rules)).toEqual({ skills: [], warnings: [] });
    const text = await listSkills({
      homeDir: f.home,
      config: rules,
      maxChars: 1000,
    });
    expect(text).not.toMatch(
      /BAD_SKILL|NAMED_SKILL|INVALID_SECRET|skills.config|enabled|已禁用|禁用项/,
    );
    expect(text).toContain("0 项");
  });
  it("does not turn an enabled explicit-only Skill into an implicitly callable one", async () => {
    const f = await setup();
    const file = await f.skill(path.join(f.generic, "manual"), "manual", true);
    const rules: SkillSetting[] = [
      { name: "manual", enabled: false },
      { path: file, enabled: true },
    ];
    expect((await f.discover(rules)).skills).toEqual([
      { name: "manual", path: file, implicit: false },
    ]);
    const text = await listSkills({ homeDir: f.home, config: rules });
    expect(text).toContain('"manual"');
    expect(text).toContain("仅用户明确要求");
    expect(text).not.toContain("TRIGGER_manual");
  });
  it("keeps disabled entries out of the description budget rather than filtering the rendered output", async () => {
    const f = await setup();
    const retained = await f.skill(
      path.join(f.generic, "retained"),
      "retained",
    );
    const control = await listSkills({ homeDir: f.home, maxChars: 1000 });
    const disabled = await f.skill(
      path.join(f.generic, "large-hidden"),
      "hidden",
    );
    await writeFile(
      disabled,
      `---\nname: hidden\ndescription: ${"LONG_HIDDEN_TRIGGER_".repeat(500)}\n---\n`,
    );
    const output = await listSkills({
      homeDir: f.home,
      config: [{ path: disabled, enabled: false }],
      maxChars: 1000,
    });
    expect(output).toBe(control);
    expect(output).toContain(JSON.stringify(retained));
  });
  it("honors cancellation before resolving configured paths", async () => {
    const f = await setup();
    await expect(
      discoverSkills({
        homeDir: f.home,
        config: [{ path: "/not/read/SKILL.md", enabled: false }],
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow();
  });
});

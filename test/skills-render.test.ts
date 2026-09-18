import { describe, expect, it } from "vitest";
import { characterCount, renderSkills } from "../src/skills/render.js";
import {
  DEFAULT_SKILL_MAX_CHARS,
  type SkillCatalog,
  type SkillMetadata,
} from "../src/skills/types.js";

function item(
  index: number,
  description = "适用任务说明 ".repeat(80),
  root = "/srv/shared-skills/team/coding-workflows",
): SkillMetadata {
  return {
    name: `skill-${index}`,
    path: `${root}/skill-${index}/SKILL.md`,
    description,
    implicit: true,
  };
}
function render(
  skills: SkillMetadata[],
  limit?: number,
  warnings: string[] = [],
) {
  return renderSkills({ skills, warnings }, limit);
}
function decode(text: string) {
  const roots = new Map<string, string>();
  const result: {
    name: string;
    path: string;
    description?: string;
    implicit: boolean;
  }[] = [];
  const q = '"(?:\\\\.|[^"\\\\])*"';
  const row = new RegExp(
    `^- (${q}) \\| ((?:@r[0-9]+ \\+ )?${q})(?: \\| (${q}))?$`,
    "u",
  );
  let implicit = true;
  for (const line of text.split("\n")) {
    const root = /^(r\d+) = (".*")$/.exec(line);
    if (root) roots.set(root[1]!, JSON.parse(root[2]!));
    if (line.startsWith("仅用户明确要求")) implicit = false;
    const match = row.exec(line);
    if (!match) continue;
    const alias = /^@(r\d+) \+ (".*")$/.exec(match[2]!);
    const path = alias
      ? roots.get(alias[1]!)! + JSON.parse(alias[2]!)
      : JSON.parse(match[2]!);
    result.push({
      name: JSON.parse(match[1]!),
      path,
      implicit,
      ...(match[3] === undefined ? {} : { description: JSON.parse(match[3]) }),
    });
  }
  return result;
}

describe("complete skill catalog with a presentation budget", () => {
  it("keeps short descriptions complete and returns only one human-readable directory", () => {
    const skills = [
      item(0, "when reviewing code"),
      item(1, "when testing code"),
    ];
    const text = render(skills);
    expect(decode(text)).toEqual(skills);
    expect(text).not.toContain("描述按公平前缀压缩");
    expect(text).not.toContain('"skills":');
    expect(text).toBe(render(skills));
  });
  it("uses a default 40,000-character target and retains all names under a large description load", () => {
    const skills = Array.from({ length: 300 }, (_, i) => item(i));
    const output = render(skills);
    expect(characterCount(output)).toBeLessThanOrEqual(DEFAULT_SKILL_MAX_CHARS);
    expect(characterCount(output)).toBeGreaterThan(39_990);
    const parsed = decode(output);
    expect(parsed.map(({ name, path }) => ({ name, path }))).toEqual(
      skills.map(({ name, path }) => ({ name, path })),
    );
    expect(parsed.every((skill) => skill.description!.endsWith("…"))).toBe(
      true,
    );
    expect(output).not.toContain("PRIVATE_BODY");
  });
  it("distributes prefixes round-robin, finishing short descriptions without letting the first long item monopolize space", () => {
    const skills = Array.from({ length: 20 }, (_, i) =>
      item(i, i === 3 ? "short" : "abcXYZ".repeat(100)),
    );
    const output = render(skills, 2400);
    const parsed = decode(output);
    expect(characterCount(output)).toBeLessThanOrEqual(2400);
    expect(parsed[3]!.description).toBe("short");
    const lengths = parsed
      .filter((_, i) => i !== 3)
      .map((skill) => characterCount(skill.description!.replace(/…$/, "")));
    expect(Math.max(...lengths) - Math.min(...lengths)).toBeLessThanOrEqual(1);
    parsed.forEach((skill, i) =>
      expect(
        skills[i]!.description!.startsWith(
          skill.description!.replace(/…$/, ""),
        ),
      ).toBe(true),
    );
  });
  it("accounts UTF-8 text as Unicode code points and charges JSON escaping without splitting surrogate pairs", () => {
    const skills = Array.from({ length: 24 }, (_, i) =>
      item(i, '中文😀"\\\u0000'.repeat(150)),
    );
    const text = render(skills, 3800);
    expect(characterCount(text)).toBeLessThanOrEqual(3800);
    expect(text).not.toContain("\ufffd");
    for (const skill of decode(text)) {
      const prefix = skill.description!.replace(/…$/, "");
      expect(skills[0]!.description!.startsWith(prefix)).toBe(true);
      const last = prefix.charCodeAt(prefix.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
    expect(characterCount("😀中文")).toBe(3);
  });
  it("never hides mandatory metadata when even the minimum directory exceeds the requested target", () => {
    const skills = Array.from({ length: 60 }, (_, i) => ({
      ...item(i),
      implicit: i % 3 !== 0,
    }));
    const output = render(skills, 1);
    expect(characterCount(output)).toBeGreaterThan(1);
    expect(output).toContain("超过 1 字符目标");
    expect(
      decode(output)
        .map((skill) => skill.path)
        .sort(),
    ).toEqual(skills.map((skill) => skill.path).sort());
    expect(
      decode(output)
        .filter((skill) => !skill.implicit)
        .every((skill) => !Object.hasOwn(skill, "description")),
    ).toBe(true);
    expect(output).toContain("仅用户明确要求使用时才可读取");
  });
  it("removes explicit-only trigger descriptions defensively at every budget", () => {
    const skills = [
      item(0, "AUTO_TRIGGER"),
      { ...item(1, "SENSITIVE_EXPLICIT_TRIGGER"), implicit: false },
    ];
    for (const budget of [1, 1000, 40000, 80000]) {
      const text = render(skills, budget);
      expect(text).not.toContain("SENSITIVE_EXPLICIT_TRIGGER");
      expect(
        decode(text).find((skill) => skill.name === "skill-1"),
      ).toMatchObject({
        name: "skill-1",
        path: skills[1]!.path,
        implicit: false,
      });
      expect(text).toContain("“不要使用”不算授权");
    }
  });
  it("escapes metadata that could otherwise create fake section headings or path definitions", () => {
    const skills = [
      {
        name: 'x\n可按任务匹配\n" | \\ r0',
        path: '/tmp/space and "quote"/\nname/SKILL.md',
        description: "do a task\nnot a section\u202e",
        implicit: true,
      },
    ];
    const output = render(skills);
    expect(decode(output)).toEqual([
      { ...skills[0]!, description: "do a task not a section\u202e" },
    ]);
    expect(output).toContain("\\u202e");
    expect(
      output.split("\n").filter((line) => line.startsWith("- ")),
    ).toHaveLength(1);
  });
  it("includes diagnostics in the budget and distinguishes warnings from an empty successful scan", () => {
    const text = render([], undefined, ['"/bad/SKILL.md"：无法解析元数据']);
    expect(text).toContain("未发现可用 Skill");
    expect(text).toContain("范围可能不完整");
    const skills = Array.from({ length: 20 }, (_, i) => item(i));
    const output = render(skills, 2500, ["scan warning".repeat(20)]);
    expect(characterCount(output)).toBeLessThanOrEqual(2500);
    expect(output).toContain("scan warning");
    expect(decode(output)).toHaveLength(skills.length);
  });
  it("handles multiple scales without cutting any name or recoverable path", () => {
    for (const n of [0, 1, 2, 10, 50, 200, 1000]) {
      const catalog: SkillCatalog = {
        skills: Array.from({ length: n }, (_, i) =>
          item(i, "😀a".repeat((i % 83) + 5)),
        ),
        warnings: [],
      };
      for (const budget of [1, 1000, 4000, 40000]) {
        const text = renderSkills(catalog, budget);
        expect(decode(text).map((skill) => skill.path)).toEqual(
          catalog.skills.map((skill) => skill.path),
        );
        if (characterCount(text) > budget)
          expect(text).toContain("保留全部条目");
      }
    }
  });
});

describe("lossless common-prefix path display", () => {
  it.each([
    "/srv/very-long-common-root/skills/",
    "C:\\Users\\example\\projects\\very-long-common-root\\skills\\",
    "\\\\server\\shared-drive\\very-long-common-root\\skills\\",
  ])("round-trips native paths using directory-boundary prefixes", (root) => {
    const separator = root.includes("\\") ? "\\" : "/";
    const skills = Array.from({ length: 12 }, (_, i) => ({
      ...item(i, "short"),
      path: `${root}bundle-${i}${separator}SKILL.md`,
    }));
    const text = render(skills);
    expect(text).toContain("路径前缀");
    expect(text).toContain("不是 Shell 变量");
    expect(decode(text).map((skill) => skill.path)).toEqual(
      skills.map((skill) => skill.path),
    );
    expect(text.match(/r\d+ = /g)?.length).toBeGreaterThan(0);
  });
  it("does not replace an adjacent directory name by mere substring matching or collapse distinct same-name skills", () => {
    const skills = Array.from({ length: 12 }, (_, i) =>
      item(
        i,
        "x",
        i % 2
          ? "/home/example/.agents/skills"
          : "/home/example/.agents/skills-neighbor",
      ),
    );
    skills[1]!.name = skills[0]!.name;
    const text = render(skills);
    expect(decode(text).map((skill) => skill.path)).toEqual(
      skills.map((skill) => skill.path),
    );
    expect(
      decode(text).filter((skill) => skill.name === "skill-0"),
    ).toHaveLength(2);
  });
  it("keeps simple paths when aliases plus their explanation would cost more", () => {
    const text = render([item(0, "x", "/a"), item(1, "x", "/a")]);
    expect(text).not.toContain("路径前缀");
    expect(decode(text)).toHaveLength(2);
  });
});

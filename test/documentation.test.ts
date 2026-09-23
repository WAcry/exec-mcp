import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const tick = String.fromCharCode(96);

async function markdownFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await markdownFiles(filename)));
    else if (entry.name.endsWith(".md")) files.push(filename);
  }
  return files;
}

const paths = [
  ...(await readdir(root))
    .filter((name) => name.endsWith(".md"))
    .map((name) => path.join(root, name)),
  ...(await markdownFiles(path.join(root, "docs"))),
].sort();
const documents = new Map(
  await Promise.all(
    paths.map(async (file) => [file, await readFile(file, "utf8")] as const),
  ),
);

/** Only inspect prose links; code examples can contain Markdown of their own. */
function sections(source: string) {
  const prose: string[] = [];
  const blocks: { language: string; content: string }[] = [];
  let fence = "";
  let language = "";
  let content: string[] = [];
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (fence) {
      if (
        trimmed.length >= fence.length &&
        [...trimmed].every((ch) => ch === fence[0])
      ) {
        blocks.push({ language, content: content.join("\n") });
        fence = "";
        content = [];
      } else content.push(line);
      continue;
    }
    if (trimmed.startsWith(tick.repeat(3)) || trimmed.startsWith("~~~")) {
      let length = 0;
      while (trimmed[length] === trimmed[0]) length++;
      fence = trimmed.slice(0, length);
      language = trimmed.slice(length).trim();
    } else prose.push(line);
  }
  expect(fence, "Unclosed documentation code fence").toBe("");
  return { prose: prose.join("\n"), blocks };
}

function headings(source: string) {
  return [...sections(source).prose.matchAll(/^(#{1,6}) (.+)$/gm)];
}

function anchors(source: string) {
  const used = new Set<string>();
  for (const [, , heading] of headings(source)) {
    const base = heading!
      .split(tick)
      .join("")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, "")
      .trim()
      .replace(/\s/g, "-");
    let candidate = base;
    let count = 0;
    while (used.has(candidate)) candidate = base + "-" + ++count;
    used.add(candidate);
  }
  return used;
}

const pairs = paths.filter((file) => !file.endsWith(".zh.md"));

describe("bilingual project documentation", () => {
  it("pairs every project document, cross-links languages, and keeps executable examples aligned", () => {
    expect(paths.length).toBe(pairs.length * 2);
    for (const english of pairs) {
      const chinese = english.replace(/\.md$/, ".zh.md");
      const en = documents.get(english)!;
      const zh = documents.get(chinese);
      expect(zh, path.relative(root, chinese)).toBeDefined();
      expect(en.split("\n").slice(0, 5).join("\n")).toContain(
        "[简体中文](" + path.basename(chinese) + ")",
      );
      expect(zh!.split("\n").slice(0, 5).join("\n")).toContain(
        "[English](" + path.basename(english) + ")",
      );
      expect(
        headings(en).map((match) => match[1]),
        english,
      ).toEqual(headings(zh!).map((match) => match[1]));
      const executable = (value: string) =>
        sections(value).blocks.filter((block) => block.language !== "text");
      expect(executable(en), english).toEqual(executable(zh!));
    }
  });

  it("resolves local links and anchors while retaining the selected language", async () => {
    for (const [file, source] of documents) {
      const prose = sections(source).prose.replace(
        new RegExp(tick + "+[^" + tick + "]*" + tick + "+", "g"),
        "",
      );
      for (const [, href] of prose.matchAll(/\]\(([^)\n]+)\)/g)) {
        if (/^[a-z][a-z\d+.-]*:/i.test(href!)) continue;
        const [destination, fragment] = href!.split("#");
        const target = destination
          ? path.resolve(path.dirname(file), decodeURIComponent(destination))
          : file;
        const label = path.relative(root, file) + " -> " + href;
        await expect(access(target), label).resolves.toBeUndefined();
        if (!target.endsWith(".md")) continue;
        const body = documents.get(target);
        expect(body, label).toBeDefined();
        if (fragment)
          expect(anchors(body!), label).toContain(decodeURIComponent(fragment));
        const peer = file.endsWith(".zh.md")
          ? file.replace(/\.zh\.md$/, ".md")
          : file.replace(/\.md$/, ".zh.md");
        if (target !== peer)
          expect(target.endsWith(".zh.md"), label).toBe(
            file.endsWith(".zh.md"),
          );
      }
    }
  });

  it("ships both root languages and records only the requested 1.0.0 release", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(root, "package.json"), "utf8"),
    ) as { files: string[] };
    for (const filename of paths.filter((file) => path.dirname(file) === root))
      expect(manifest.files).toContain(path.basename(filename));
    expect(manifest.files).toContain("docs");
    for (const name of ["CHANGELOG.md", "CHANGELOG.zh.md"]) {
      const source = documents.get(path.join(root, name))!;
      expect(
        headings(source)
          .filter((match) => match[1] === "##")
          .map((match) => match[2]),
      ).toEqual(["1.0.0"]);
    }
  });
});

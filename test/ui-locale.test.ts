import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { messages } from "../ui/src/lib/messages.js";
import {
  LANGUAGE_KEY,
  createTranslator,
  feedback,
  languagePreference,
  message,
  readLanguagePreference,
  resolveLocale,
} from "../ui/src/lib/locale.js";
import { callStatusLabel } from "../ui/src/lib/call-presentation.js";

describe("console language", () => {
  it.each([
    [["en-US", "zh-CN"], "en"],
    [["zh-CN", "en"], "zh-CN"],
    [["zh-TW", "en-US"], "zh-CN"],
    [["zh-Hant-HK"], "zh-CN"],
    [["fr-FR", "zh", "en"], "zh-CN"],
    [["de-DE", "en-GB", "zh"], "en"],
    [["fr-FR"], "en"],
    [[], "en"],
    [["not-zh", "zhuang", "english"], "en"],
  ] as const)(
    "matches the first supported preference in %j",
    (languages, expected) => {
      expect(resolveLocale("auto", languages)).toBe(expected);
    },
  );

  it("keeps explicit choices and rejects corrupt or unrelated stored values", () => {
    expect(resolveLocale("en", ["zh-CN"])).toBe("en");
    expect(resolveLocale("zh", ["en-US"])).toBe("zh-CN");
    for (const value of [null, undefined, "auto", "fr", "{}", "__proto__", 42])
      expect(languagePreference(value)).toBe("auto");
    expect(languagePreference("en")).toBe("en");
    expect(languagePreference("zh")).toBe("zh");
    expect(
      readLanguagePreference({
        getItem: (key) => (key === LANGUAGE_KEY ? "zh" : null),
      }),
    ).toBe("zh");
    expect(
      readLanguagePreference({
        getItem: () => {
          throw new Error("blocked");
        },
      }),
    ).toBe("auto");
  });

  it("has complete English and Chinese messages with identical placeholder slots", () => {
    const slots = (text: string) =>
      [...new Set([...text.matchAll(/\{(\d+)\}/g)].map((m) => m[1]))].sort();
    expect(Object.keys(messages).length).toBeGreaterThan(250);
    for (const [key, value] of Object.entries(messages)) {
      expect(typeof value.en, key).toBe("string");
      expect(typeof value.zh, key).toBe("string");
      expect(value.zh.length, key).toBeGreaterThan(0);
      expect(/\p{Script=Han}/u.test(value.en), key).toBe(false);
      expect(slots(value.en), key).toEqual(slots(value.zh));
      if (!["common.callsUnit", "common.itemsUnit"].includes(key))
        expect(value.en.length, key).toBeGreaterThan(0);
    }
  });

  it("substitutes values once, preserving user text rather than interpreting it as a translation", () => {
    const t = createTranslator("en");
    const raw = "原文 ${value} {1} <script> & \n";
    expect(t("calls.open", raw)).toBe("View " + raw + " call details");
    expect(t("calls.page", 0, 1, 2)).toBe("0 records · Page 1 / 2");
    expect(feedback(raw, t)).toBe(raw);
    const saved = message("notes.copied");
    expect(feedback(saved, t)).toBe(messages["notes.copied"].en);
    expect(feedback(saved, createTranslator("zh-CN"))).toBe(
      messages["notes.copied"].zh,
    );
  });

  it("localizes call status without changing its machine status or nested results", () => {
    const call = {
      tool: "exec",
      status: "completed" as const,
      output: { content: [{ type: "text", text: "原始日志" }] },
    };
    const before = JSON.stringify(call);
    expect(callStatusLabel(call, createTranslator("en"))).toBe(
      "Script completed",
    );
    expect(callStatusLabel(call, createTranslator("zh-CN"))).toBe("脚本完成");
    expect(JSON.stringify(call)).toBe(before);
  });

  it("keeps UI-owned Chinese strings in the bilingual catalog", async () => {
    const root = fileURLToPath(new URL("../ui/src", import.meta.url));
    const violations: string[] = [];
    async function visitDirectory(dir: string) {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const filename = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await visitDirectory(filename);
          continue;
        }
        if (!/\.tsx?$/.test(filename) || filename.endsWith("messages.ts"))
          continue;
        const source = ts.createSourceFile(
          filename,
          await readFile(filename, "utf8"),
          ts.ScriptTarget.Latest,
          true,
        );
        function visit(node: ts.Node) {
          if (
            ts.isStringLiteral(node) ||
            ts.isNoSubstitutionTemplateLiteral(node) ||
            ts.isTemplateHead(node) ||
            ts.isTemplateMiddle(node) ||
            ts.isTemplateTail(node) ||
            ts.isJsxText(node)
          ) {
            if (
              /\p{Script=Han}/u.test(node.text) &&
              !(
                entry.name === "LanguageControl.tsx" &&
                node.text.trim() === "简体中文"
              )
            )
              violations.push(
                path.relative(root, filename) + ": " + node.text.trim(),
              );
          }
          ts.forEachChild(node, visit);
        }
        visit(source);
      }
    }
    await visitDirectory(root);
    expect(violations).toEqual([]);
  });
});

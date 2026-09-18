import { afterEach, describe, expect, it } from "vitest";
import { CodeModeService, parseExecSource } from "../src/code-mode/service.js";
import { applyOutputBudget } from "../src/code-mode/output-budget.js";
import { cellId, jsonOutput, texts } from "./helpers.js";
import type { CodeModeOutputItem } from "../src/code-mode/types.js";
const services: CodeModeService[] = [];
function service() {
  const s = new CodeModeService();
  services.push(s);
  return s;
}
afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.close()));
});
const text = (value: string): CodeModeOutputItem => ({
  type: "text",
  text: value,
});
const png =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5xkAAAAASUVORK5CYII=";

describe("explicit output budgets", () => {
  it("leaves unlimited and within-budget data untouched", () => {
    const input = [text("中文".repeat(10000)), text("tail")];
    expect(applyOutputBudget(input, undefined)).toEqual({
      items: input,
      truncated: false,
    });
    expect(applyOutputBudget([text("abcd")], 1)).toEqual({
      items: [text("abcd")],
      truncated: false,
    });
  });
  it("uses one head/tail budget across blocks and retains Unicode and native media", () => {
    const media: CodeModeOutputItem = {
      type: "image",
      imageUrl: png,
      detail: "original",
    };
    const limited = applyOutputBudget(
      [text("HEAD" + "x".repeat(100)), media, text("y".repeat(100) + "TAIL")],
      2,
    );
    expect(limited).toEqual({
      items: [text("HEAD"), media, text("TAIL")],
      truncated: true,
    });
    const unicode = applyOutputBudget([text("中文🙂".repeat(30))], 2);
    expect(unicode.truncated).toBe(true);
    expect(JSON.stringify(unicode.items)).not.toContain("�");
    const audio: CodeModeOutputItem = {
      type: "audio",
      audioUrl: "data:audio/wav;base64,AAAA",
    };
    expect(applyOutputBudget([text("body"), media, audio], 0)).toEqual({
      items: [media, audio],
      truncated: true,
    });
  });
  it("does not inherit a hidden 10,000-token default from the host", async () => {
    const value = service();
    const result = await value.exec({
      source: 'text("x".repeat(80000));',
      tools: [],
    });
    expect(texts(result).at(-1)).toHaveLength(80000);
    expect(texts(result)[0]).not.toContain("截断");
  });
  it("rejects invalid budgets before invoking any tool", async () => {
    const value = service();
    let called = 0;
    const tools = [
      { name: "effect", description: "副作用计数", call: async () => ++called },
    ];
    for (const maxOutputTokens of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN]) {
      await expect(
        value.exec({
          source: "await tools.effect({});",
          tools,
          maxOutputTokens,
        }),
      ).rejects.toThrow("预算");
    }
    await expect(
      value.wait({ cellId: "missing", maxTokens: -1 }),
    ).rejects.toThrow("预算");
    expect(called).toBe(0);
  });
  it("accepts the Codex pragma and lets top-level options override it, including zero", async () => {
    expect(
      parseExecSource(
        '// @exec: {"yield_time_ms":0,"max_output_tokens":2}\ntext(1);',
      ),
    ).toEqual({ code: "text(1);", yieldTimeMs: 0, maxOutputTokens: 2 });
    const value = service();
    const result = await value.exec({
      source: '// @exec: {"max_output_tokens":1}\ntext("abcdefgh");',
      tools: [],
      maxOutputTokens: 2,
    });
    expect(texts(result).at(-1)).toBe("abcdefgh");
    expect(texts(result)[0]).not.toContain("截断");
    const zero = await value.exec({
      source: '// @exec: {"max_output_tokens":5}\ntext("body");',
      tools: [],
      maxOutputTokens: 0,
    });
    expect(texts(zero)).toHaveLength(1);
    expect(texts(zero)[0]).toContain("Script completed");
    const pragma = await value.exec({
      source:
        '// @exec: {"max_output_tokens":2}\ntext("HEAD"+"x".repeat(100)+"TAIL");',
      tools: [],
    });
    expect(texts(pragma)[0]).toContain("截断");
    expect(texts(pragma).at(-1)).toBe("HEAD\n…\nTAIL");
  });
  it("limits final presentation, not nested data or store/load", async () => {
    const value = service();
    const result = await value.exec({
      source: 'const r=await tools.data({});store("raw",r);text(r);',
      tools: [
        {
          name: "data",
          description: "返回完整测试结果",
          call: async () => "z".repeat(20000),
        },
      ],
      sessionScope: "a",
      maxOutputTokens: 2,
    });
    expect(texts(result)[0]).toContain("截断");
    expect(
      jsonOutput(
        await value.exec({
          source: 'text(load("raw").length);',
          tools: [],
          sessionScope: "a",
        }),
      ),
    ).toBe(20000);
  });
  it("applies wait budgets per response, preserves handles/errors, and never repeats omitted output", async () => {
    const value = service();
    const begun = await value.exec({
      source:
        'text("first".repeat(1000));yield_control();await new Promise(r=>setTimeout(r,80));text("second".repeat(1000));yield_control();await new Promise(r=>setTimeout(r,80));text("third".repeat(1000));',
      tools: [],
      maxOutputTokens: 0,
    });
    const id = cellId(begun);
    const next = await value.wait({ cellId: id, maxTokens: 1 });
    expect(cellId(next)).toBe(id);
    expect(texts(next)[0]).toContain("截断");
    const final = await value.wait({ cellId: id });
    expect(texts(final).at(-1)).toBe("third".repeat(1000));
    expect(texts(final).join("\n")).not.toContain("first");
    const failed = await value.exec({
      source: 'throw new Error("detail");',
      tools: [],
      maxOutputTokens: 0,
    });
    expect(failed.isError).toBe(true);
    expect(texts(failed)[0]).toContain("Script failed");
  });
});

describe("generatedImage native result", () => {
  it("emits an existing image and optional hint without invoking any tool or generator", async () => {
    const value = service();
    const result = await value.exec({
      source: `generatedImage({image_url:${JSON.stringify(png)},output_hint:"中文说明"});`,
      tools: [],
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(
      result.content.filter((block) => block.type === "image"),
    ).toMatchObject([{ mimeType: "image/png", data: png.split(",")[1] }]);
    expect(texts(result).at(-1)).toBe("中文说明");
    const limited = await value.exec({
      source: `generatedImage({image_url:${JSON.stringify(png)},output_hint:"说明"});`,
      tools: [],
      maxOutputTokens: 0,
    });
    expect(
      limited.content.filter((block) => block.type === "image"),
    ).toHaveLength(1);
    expect(texts(limited).join("\n")).not.toContain("说明");
    const noHint = await value.exec({
      source: `generatedImage({image_url:${JSON.stringify(png)}});`,
      tools: [],
    });
    expect(noHint.content).toHaveLength(2);
  });
  it("rejects HTTP URLs, file paths and non-string hints rather than fetching or generating", async () => {
    const value = service();
    for (const args of [
      { image_url: "https://example.com/image.png" },
      { image_url: "/tmp/image.png" },
      { image_url: png, output_hint: 42 },
    ]) {
      const result = await value.exec({
        source: `generatedImage(${JSON.stringify(args)});`,
        tools: [],
      });
      expect(result.isError).toBe(true);
    }
  });
});

import { describe, expect, it } from "vitest";
import { isJsonMirror, normalizeResult } from "../src/results.js";
import { encodePayload } from "../src/limits.js";
import {
  outputItemsToCallToolResult,
  prepareNestedToolResult,
} from "../src/code-mode/result.js";

describe("lossless result boundary", () => {
  it("removes only equivalent JSON mirrors and transport-private metadata", () => {
    const result = normalizeResult({
      _meta: { secret: true },
      structuredContent: { n: 3 },
      isError: true,
      content: [
        { type: "text", text: '{ "n": 3 }' },
        { type: "text", text: "说明" },
        {
          type: "image",
          data: "xxx",
          mimeType: "image/png",
          _meta: { detail: "original" },
        },
      ],
    });
    expect(result).toEqual({
      structuredContent: { n: 3 },
      isError: true,
      content: [
        { type: "text", text: "说明" },
        {
          type: "image",
          data: "xxx",
          mimeType: "image/png",
          _meta: { detail: "original" },
        },
      ],
    });
  });
  it.each([null, [1, 2], "value", 0, false])(
    "deduplicates valid structured value %j",
    (value) => {
      expect(
        normalizeResult({
          structuredContent: value,
          content: [{ type: "text", text: JSON.stringify(value) }],
        }),
      ).toEqual({ structuredContent: value, content: [] });
    },
  );
  it.each(['{"n":9007199254740993}', '{"n":1,"n":2}', '{"n":1e0}', '{"n":-0}'])(
    "preserves lexical information in %s",
    (text) => {
      expect(isJsonMirror(text, JSON.parse(text))).toBe(false);
    },
  );
  it("preserves distinct content metadata and ordinary object _meta", () => {
    const block = { type: "text", text: "1", annotations: { priority: 1 } };
    expect(normalizeResult({ content: [block], structuredContent: 1 })).toEqual(
      { content: [block], structuredContent: 1 },
    );
    expect(normalizeResult({ _meta: "application data" })).toEqual({
      _meta: "application data",
    });
  });
  it("keeps large text intact without spill or duplicate structured output", async () => {
    const text = "大结果😀".repeat(5000);
    const nested = await prepareNestedToolResult({ text });
    expect(JSON.parse(nested.toString())).toEqual({ text });
    const result = outputItemsToCallToolResult([{ type: "text", text }], false);
    expect(result).toEqual({ content: [{ type: "text", text }] });
  });
  it("rejects an actual byte boundary rather than truncating", () => {
    expect(encodePayload("x", 3).toString()).toBe('"x"');
    expect(() => encodePayload("x", 2)).toThrow("传输边界");
  });
  it("emits media as native blocks", () => {
    expect(
      outputItemsToCallToolResult(
        [{ type: "image", imageUrl: "data:image/png;base64,YQ==" }],
        false,
      ),
    ).toEqual({
      content: [{ type: "image", mimeType: "image/png", data: "YQ==" }],
    });
  });
});

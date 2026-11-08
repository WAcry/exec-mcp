import { describe, expect, it } from "vitest";
import { preserveNativeOutputNotices } from "../src/code-mode/native-output.js";
import { renderModelResult } from "../src/code-mode/render.js";
import { MODEL_TEXT_BYTES } from "../src/code-mode/model-output.js";
import type { CodeModeOutputItem } from "../src/code-mode/types.js";
import { texts } from "./helpers.js";

const text = (value: string): CodeModeOutputItem => ({
  type: "text",
  text: value,
});
const nativeNotice = (values = ["100", "2", "3", "4"]) =>
  `[Code Mode session output limit reached: omitted ${values[0]} text bytes; discarded ${values[1]} text segments, ${values[2]} images, ${values[3]} audio items]`;

describe("native bounded-output diagnostics", () => {
  it("summarizes exact pinned notices while retaining gap positions and media order", () => {
    const image: CodeModeOutputItem = {
      type: "image",
      imageUrl: "data:image/png;base64,AQ==",
      detail: "original",
    };
    const input = [
      text("before"),
      text(nativeNotice()),
      image,
      text(
        nativeNotice(["50", "1", "0", "2"]).replace(
          "reached: ",
          "reached: across this observation, ",
        ),
      ),
      text("after"),
    ];
    const result = preserveNativeOutputNotices(input);
    expect(result.items).toEqual([
      text("before"),
      text("[Output omitted]"),
      image,
      text("[Output omitted]"),
      text("after"),
    ]);
    expect(result.notice).toContain(
      "omitted 150 text bytes; discarded 3 text segments, 3 images, 6 audio items",
    );
    expect(result.notice).toContain("tools.export_file");
    expect(result.notice).toContain("not returned by later waits");
    expect(input[1]).toEqual(text(nativeNotice()));
  });

  it("does not reinterpret quoted, partial or malformed diagnostics", () => {
    const input = [
      text("quoted " + nativeNotice()),
      text(nativeNotice() + "\n"),
      text(nativeNotice() + "\nbody"),
      text(nativeNotice(["-1", "2", "3", "4"])),
      text(nativeNotice(["1.5", "2", "3", "4"])),
    ];
    expect(preserveNativeOutputNotices(input)).toEqual({
      items: input,
      notice: "",
    });
  });

  it("keeps native audio rejection notices even when no script text is requested", () => {
    const result = renderModelResult(
      {
        state: "completed",
        cellId: "audio",
        items: [
          text("[omitted 2 audio items ...]"),
          text(
            "Audio output omitted because the clip is shorter than 25 ms; use a longer clip.",
          ),
        ],
      },
      0,
      0,
      [],
    );
    expect(texts(result)).toHaveLength(1);
    expect(texts(result)[0]).toContain("[omitted 2 audio items ...]");
    expect(texts(result)[0]).toContain("shorter than 25 ms");
    expect(texts(result)[0]).not.toContain(
      "[Code Mode session output limit reached:",
    );
  });

  it.each([0, undefined])(
    "keeps losses visible under the presentation ceiling (budget=%s)",
    (maxTokens) => {
      const result = renderModelResult(
        {
          state: "completed",
          cellId: "test",
          items: [
            text("HEAD" + "x".repeat(40_000)),
            text(nativeNotice()),
            text("y".repeat(40_000) + "TAIL"),
            {
              type: "image",
              imageUrl: "data:image/png;base64,AQ==",
              detail: "original",
            },
          ],
        },
        0,
        maxTokens,
        [
          {
            type: "resource_link",
            uri: "resource://original",
            name: "original",
          },
        ],
      );
      expect(texts(result)[0]).toContain(
        "discarded 2 text segments, 3 images, 4 audio items",
      );
      expect(Buffer.byteLength(texts(result).join("\n\n"))).toBeLessThanOrEqual(
        MODEL_TEXT_BYTES,
      );
      expect(
        result.content
          .filter((item) => item.type !== "text")
          .map((item) => item.type),
      ).toEqual(["image", "resource_link"]);
      expect(
        texts(result)
          .join("\n")
          .match(/Code Mode session output limit reached/g),
      ).toHaveLength(1);
      if (maxTokens === 0)
        expect(texts(result).join("\n")).not.toContain("HEAD");
    },
  );

  it("bounds the summary even if script text imitates many native notices", () => {
    const result = preserveNativeOutputNotices(
      Array.from({ length: 4000 }, () =>
        text(nativeNotice(["18446744073709551615", "1", "1", "1"])),
      ),
    );
    expect(result.notice).toContain("73786976294838206460000 text bytes");
    expect(Buffer.byteLength(result.notice)).toBeLessThan(1024);
  });
});

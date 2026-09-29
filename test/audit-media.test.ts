import { describe, expect, it } from "vitest";
import { encodePng, renderBrandMark } from "../src/brand-icon.js";
import { ActivityStore } from "../src/web/activity.js";
import { AuditMedia } from "../src/web/audit-media.js";
import { parseToolResult } from "../ui/src/lib/results.js";

const png = (size: number) =>
  encodePng(size, renderBrandMark(size)).toString("base64");

function viewImage(data: string, mimeType = "image/png") {
  return {
    content: [
      { type: "image", data, mimeType, _meta: { "codex/imageDetail": "high" } },
    ],
  };
}

describe("images kept for the Web audit", () => {
  it("keeps one copy per image and gives the audit a reference instead of base64", () => {
    const activity = new ActivityStore();
    const first = png(64);
    const second = png(96);
    const tracker = activity.startCall({
      tool: "exec",
      sessionId: "scope",
      args: { source: "image(...)" },
    });
    const nested = viewImage(first);
    const before = structuredClone(nested);
    tracker.recordSubcall({
      name: "view_image",
      durationMs: 3,
      input: { path: "/tmp/first.png" },
      output: nested,
      status: "success",
    });
    const final = {
      content: [
        {
          type: "text",
          text: "Script completed\nWall time 0.1 seconds\nOutput:\n",
        },
        viewImage(first).content[0],
        viewImage(second).content[0],
      ],
    };
    tracker.finish({ status: "completed", output: final });
    expect(nested).toEqual(before);
    expect(final.content[1]).toHaveProperty("data", first);

    const call = activity.getCall(tracker.id)!;
    const recorded = call.subcalls[0]!.output as ReturnType<typeof viewImage>;
    const block = recorded.content[0] as Record<string, unknown>;
    expect(block).not.toHaveProperty("data");
    expect(block).toMatchObject({
      type: "image",
      mimeType: "image/png",
      bytes: Buffer.from(first, "base64").length,
      _meta: { "codex/imageDetail": "high" },
    });
    const parsed = parseToolResult(call.output);
    expect(parsed.preview).toBeUndefined();
    expect(parsed.text).toBe("");
    expect(parsed.media.map((item) => item.media)).toEqual([
      block.media,
      expect.stringMatching(/^[a-f0-9]{64}$/),
    ]);
    expect(JSON.stringify(call)).not.toContain(first.slice(0, 64));
    const kept = activity.media.get(block.media as string)!;
    expect(kept.mimeType).toBe("image/png");
    expect(kept.data.equals(Buffer.from(first, "base64"))).toBe(true);
    expect(call.truncatedFields).toBeUndefined();

    activity.clear();
    expect(activity.media.get(block.media as string)).toBeUndefined();
  });

  it("keeps only size for other binary blocks, unknown formats and oversized images", () => {
    const media = new AuditMedia(1024, 100);
    const small = Buffer.alloc(40, 7).toString("base64");
    const large = Buffer.alloc(200, 7).toString("base64");
    const copy = media.extract(
      {
        isError: false,
        content: [
          { type: "image", data: small, mimeType: "image/svg+xml" },
          { type: "image", data: large, mimeType: "image/png" },
          { type: "audio", data: small, mimeType: "audio/wav" },
          {
            type: "resource",
            resource: {
              uri: "memo://a",
              mimeType: "application/pdf",
              blob: small,
            },
          },
          { type: "text", text: "kept" },
        ],
      },
      "call",
    );
    expect(copy).toEqual({
      isError: false,
      content: [
        { type: "image", mimeType: "image/svg+xml", bytes: 40 },
        { type: "image", mimeType: "image/png", bytes: 200 },
        { type: "audio", mimeType: "audio/wav", bytes: 40 },
        {
          type: "resource",
          resource: { uri: "memo://a", mimeType: "application/pdf", bytes: 40 },
        },
        { type: "text", text: "kept" },
      ],
    });
    const plain = { content: [{ type: "text", text: "unchanged" }] };
    expect(media.extract(plain, "call")).toBe(plain);
    expect(media.extract("text", "call")).toBe("text");
  });

  it("evicts the oldest images within its budget and releases a call's images with the call", () => {
    const image = (fill: number) =>
      viewImage(Buffer.alloc(40, fill).toString("base64"));
    const id = (value: unknown) =>
      ((value as ReturnType<typeof viewImage>).content[0] as { media?: string })
        .media;
    const media = new AuditMedia(100, 60);
    const a = id(media.extract(image(1), "one"));
    const b = id(media.extract(image(2), "two"));
    expect(id(media.extract(image(1), "two"))).toBe(a);
    const c = id(media.extract(image(3), "three"));
    expect([a, b, c].map((key) => !!media.get(key!))).toEqual([
      true,
      false,
      true,
    ]);
    media.release("one");
    expect(media.get(a!)).toBeDefined();
    media.release("two");
    expect(media.get(a!)).toBeUndefined();

    const activity = new ActivityStore({ maxCalls: 1 });
    const record = (fill: number) => {
      const tracker = activity.startCall({
        tool: "exec",
        sessionId: "scope",
        args: {},
      });
      tracker.finish({ status: "completed", output: image(fill) });
      return id(activity.getCall(tracker.id)!.output);
    };
    const evicted = record(4);
    expect(activity.media.get(evicted!)).toBeDefined();
    record(5);
    expect(activity.media.get(evicted!)).toBeUndefined();
  });

  it("never runs getters or lets inspection change the call", () => {
    let reads = 0;
    const hostile = {
      get content() {
        reads++;
        throw new Error("getter ran");
      },
    };
    const media = new AuditMedia();
    expect(media.extract(hostile, "call")).toBe(hostile);
    const block = {
      type: "image",
      data: png(8),
      mimeType: "image/png",
      get secret() {
        reads++;
        return "value";
      },
    };
    const copy = media.extract({ content: [block] }, "call") as {
      content: Record<string, unknown>[];
    };
    expect(copy.content[0]!.secret).toBe("[Accessor]");
    expect(reads).toBe(0);
  });
});

import { describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { SessionNotes, modelTextBytes } from "../src/session-notes.js";
import {
  NOTE_MAX_BYTES,
  NOTE_RETENTION_MS,
  NOTES_RESPONSE_BYTES,
} from "../src/session-notes-types.js";
import { MAX_PAYLOAD_BYTES } from "../src/limits.js";

const result = (text = "normal"): CallToolResult => ({
  content: [{ type: "text", text }],
});
function fixture(maximum?: number) {
  let now = Date.UTC(2026, 8, 20);
  const store = new SessionNotes(maximum, () => now);
  const events: unknown[] = [];
  const close = store.openWeb((event) => events.push(event));
  store.observe("a");
  store.observe("b");
  return {
    store,
    events,
    close,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("ephemeral session notes", () => {
  it("requires an observed conversation, never creates a global inbox and captures only with Web listening", () => {
    const store = new SessionNotes();
    store.observe("hidden");
    expect(() => store.enqueue("hidden", "id", "message")).toThrow(
      "会话不存在",
    );
    const close = store.openWeb(() => {});
    store.observe(undefined);
    expect(() => store.enqueue("unscoped", "id", "message")).toThrow();
    store.observe("a");
    close();
    close();
    store.observe("b");
    expect(() => store.enqueue("b", "id", "message")).toThrow();
    store.enqueue("a", "id", "existing pending message");
    expect(store.attach(result(), "a", "call").content).toHaveLength(2);
  });

  it("defaults to hashes, keeps manual labels separate from routing and de-duplicates per conversation", () => {
    const { store } = fixture();
    expect(store.page("a").label).toBe("");
    store.rename("a", "manual label");
    const first = store.enqueue(
      "a",
      "retry-key",
      "用户原文\n keep indentation  ",
    );
    expect(store.enqueue("a", "retry-key", first.text)).toEqual(first);
    expect(() => store.enqueue("a", "retry-key", "different")).toThrow(
      "内容已改变",
    );
    store.enqueue("b", "retry-key", "other conversation");
    const response = store.attach(result(), "b", "b-call");
    expect(JSON.stringify(response)).not.toContain(first.text);
    expect(store.page("a").pendingCount).toBe(1);
    expect(store.page("a").label).toBe("manual label");
    store.rename("a", "");
    expect(store.page("a").label).toBe("");
    expect(() => store.rename("a", "汉".repeat(86))).toThrow("备注名最多");
  });

  it("uses UTF-8 byte limits without clipping text or spending ordinary tool output", () => {
    const { store } = fixture();
    const body = "😀".repeat(NOTE_MAX_BYTES / 4);
    store.enqueue("a", "max", body);
    expect(() => store.enqueue("a", "large", body + "x")).toThrow("最多");
    expect(() => store.enqueue("a", "blank", "\n  \t")).toThrow("填写");
    const ordinary = result("ORIGINAL");
    const response = store.attach(ordinary, "a", "call");
    expect(response.content[0]).toBe(ordinary.content[0]);
    expect(response.content[1]).toMatchObject({
      text: expect.stringContaining(body),
    });
    expect(modelTextBytes(response)).toBeLessThanOrEqual(NOTES_RESPONSE_BYTES);
    expect(ordinary.content).toHaveLength(1);
  });

  it("strictly preserves FIFO even when a short later message would fit; repeated full responses leave the queue pending", () => {
    const { store } = fixture();
    store.enqueue("a", "long", "L".repeat(5000));
    store.enqueue("a", "short", "short");
    const full = result("x".repeat(35_998));
    expect(modelTextBytes(full)).toBe(36_000);
    for (let i = 0; i < 5; i++)
      expect(store.attach(full, "a", `call-${i}`)).toBe(full);
    expect(store.page("a").items.every((n) => n.status === "pending")).toBe(
      true,
    );
    const response = store.attach(result("small"), "a", "fits");
    expect(response.content.slice(1)).toEqual([
      { type: "text", text: "用户额外补充：\n" + "L".repeat(5000) },
      { type: "text", text: "用户额外补充：\nshort" },
    ]);
    expect(store.page("a").items.every((n) => n.callId === "fits")).toBe(true);
    const next = result();
    expect(store.attach(next, "a", "no-repeat")).toBe(next);
  });

  it("adds a short note to a 36 KB response without changing it, counts structured content and emits no JSON mirror", () => {
    const { store } = fixture();
    store.enqueue("a", "id", "s".repeat(700));
    const ordinary: CallToolResult = {
      content: [],
      structuredContent: { output: "x".repeat(35_980) },
    };
    const original = JSON.stringify(ordinary);
    const response = store.attach(ordinary, "a", "call");
    expect(response.structuredContent).toEqual({
      result: ordinary.structuredContent,
      user_notes: ["s".repeat(700)],
    });
    expect(response.content).toEqual([]);
    expect(JSON.stringify(ordinary)).toBe(original);
    expect(modelTextBytes(response)).toBeLessThanOrEqual(37_000);
    store.enqueue("a", "blocked", "y".repeat(2000));
    expect(store.attach(ordinary, "a", "too-full")).toBe(ordinary);
  });

  it("keeps a structured-first consumer's tool result and user notes together, with metadata only in Web history", () => {
    const { store } = fixture();
    store.rename("a", "PRIVATE_WEB_LABEL");
    const text = "补充：先保留原文件。\n  Keep this note verbatim.  ";
    const saved = store.enqueue("a", "PRIVATE_MESSAGE_ID", text);
    const tool = {
      output: "sleep 1/10\r\nsleep 2/10\r\n",
      wall_time_seconds: 30.00413789999997,
      session_id: "term-running",
    };
    const response = store.attach(
      { content: [], structuredContent: tool },
      "a",
      "PRIVATE_CALL_ID",
    );
    // This is deliberately how a consumer that ignores content text would read.
    const visible = response.structuredContent ?? response.content;
    expect(visible).toEqual({ result: tool, user_notes: [text] });
    expect(response.content).toEqual([]);
    expect(JSON.stringify(response)).not.toMatch(
      /PRIVATE_|Web 操作者|createdAt|sequence/,
    );
    expect(JSON.stringify(response)).not.toContain(saved.createdAt);
    expect(store.page("a").items[0]).toMatchObject({
      id: "PRIVATE_MESSAGE_ID",
      sequence: 1,
      createdAt: saved.createdAt,
      status: "attached",
      callId: "PRIVATE_CALL_ID",
    });
  });

  it.each([
    null,
    false,
    0,
    "",
    [],
    { result: "original field", user_notes: ["tool data"] },
  ])(
    "wraps structured values without overwriting or flattening the original data (%j)",
    (value) => {
      const { store } = fixture();
      store.enqueue("a", "one", "first");
      store.enqueue("a", "two", "second");
      const ordinary: CallToolResult = {
        content: [],
        structuredContent: value,
      };
      const response = store.attach(ordinary, "a", "call");
      expect(response.structuredContent).toEqual({
        result: value,
        user_notes: ["first", "second"],
      });
      expect(ordinary.structuredContent).toBe(value);
      expect(response.content).toEqual([]);
      expect(store.attach(ordinary, "a", "again")).toBe(ordinary);
    },
  );

  it("unifies distinct text with structured data and preserves error, media, links and content metadata", () => {
    const { store } = fixture();
    store.enqueue("a", "id", "do not repeat the failed operation");
    const structured = { failed: true };
    const explanation = {
      type: "text" as const,
      text: "Partial changes occurred.",
      annotations: { priority: 1 },
    };
    const annotatedMirror = {
      type: "text" as const,
      text: JSON.stringify(structured),
      _meta: { original: true },
    };
    const media: CallToolResult["content"] = [
      { type: "image", data: "fixture", mimeType: "image/png" },
      { type: "audio", data: "fixture", mimeType: "audio/wav" },
      { type: "resource_link", uri: "fixture://file", name: "result.txt" },
      {
        type: "resource",
        resource: { uri: "fixture://embedded", text: "embedded text" },
      },
    ];
    const ordinary: CallToolResult = {
      content: [
        media[0]!,
        { type: "text", text: JSON.stringify(structured) },
        explanation,
        annotatedMirror,
        ...media.slice(1),
      ],
      structuredContent: structured,
      isError: true,
      _meta: { retained: "private metadata" },
    };
    const snapshot = JSON.stringify(ordinary);
    const response = store.attach(ordinary, "a", "call");
    expect(response.structuredContent).toEqual({
      result: structured,
      result_content: [explanation, annotatedMirror],
      user_notes: ["do not repeat the failed operation"],
    });
    expect(response.content).toEqual(media);
    expect(response.isError).toBe(true);
    expect(response._meta).toBe(ordinary._meta);
    expect(JSON.stringify(ordinary)).toBe(snapshot);
  });

  it("counts the structured envelope, JSON escapes and commas exactly at the delivery boundary", () => {
    const { store } = fixture();
    const ordinary: CallToolResult = {
      content: [],
      structuredContent: { output: "x".repeat(35_900) },
    };
    const envelopeBytes = modelTextBytes({
      content: [],
      structuredContent: { result: ordinary.structuredContent, user_notes: [] },
    });
    const room = NOTES_RESPONSE_BYTES - envelopeBytes;
    const body =
      "\0".repeat(Math.floor((room - 2) / 6)) + "x".repeat((room - 2) % 6);
    expect(Buffer.byteLength(JSON.stringify(body))).toBe(room);
    store.enqueue("a", "exact", body);
    store.enqueue("a", "later", "next");
    const response = store.attach(ordinary, "a", "exact-call");
    expect(modelTextBytes(response)).toBe(NOTES_RESPONSE_BYTES);
    expect(response.structuredContent).toEqual({
      result: ordinary.structuredContent,
      user_notes: [body],
    });
    expect(store.page("a").pendingCount).toBe(1);
    const small: CallToolResult = { content: [], structuredContent: {} };
    expect(store.attach(small, "a", "next-call").structuredContent).toEqual({
      result: {},
      user_notes: ["next"],
    });

    store.enqueue("b", "one-too-many", body + "x");
    store.enqueue("b", "blocked", "short");
    expect(store.attach(ordinary, "b", "no-room")).toBe(ordinary);
    expect(store.page("b").pendingCount).toBe(2);
    const smaller = store.attach(small, "b", "both-fit");
    expect(smaller.structuredContent).toEqual({
      result: {},
      user_notes: [body + "x", "short"],
    });
    expect(modelTextBytes(smaller)).toBeLessThanOrEqual(NOTES_RESPONSE_BYTES);
  });

  it("uses only a short text heading without adding structured content to text-only responses", () => {
    const { store } = fixture();
    store.enqueue("a", "PRIVATE_MESSAGE_ID", "  原文\n保留缩进与换行。  ");
    const response = store.attach(
      result("Script completed"),
      "a",
      "PRIVATE_CALL_ID",
    );
    expect(response).toEqual({
      content: [
        { type: "text", text: "Script completed" },
        { type: "text", text: "用户额外补充：\n  原文\n保留缩进与换行。  " },
      ],
    });
    expect(response.structuredContent).toBeUndefined();
  });

  it("counts the separator between structured notes at an exact 37 KB boundary", () => {
    const { store } = fixture();
    const text = 'a"\\\n汉😀'.repeat(100);
    const notes = [text, text];
    const overhead = modelTextBytes({
      content: [],
      structuredContent: { result: { output: "" }, user_notes: notes },
    });
    const ordinary: CallToolResult = {
      content: [],
      structuredContent: {
        output: "x".repeat(NOTES_RESPONSE_BYTES - overhead),
      },
    };
    expect(modelTextBytes(ordinary)).toBeLessThanOrEqual(36_000);
    store.enqueue("a", "one", text);
    store.enqueue("a", "two", text);
    store.enqueue("a", "three", "later");
    const response = store.attach(ordinary, "a", "exact-multiple");
    expect(modelTextBytes(response)).toBe(NOTES_RESPONSE_BYTES);
    expect(response.structuredContent).toEqual({
      result: ordinary.structuredContent,
      user_notes: notes,
    });
    expect(store.page("a").pendingCount).toBe(1);

    store.enqueue("b", "one", text);
    store.enqueue("b", "two", text);
    const slightlyLarger: CallToolResult = {
      content: [],
      structuredContent: {
        output: "x".repeat(NOTES_RESPONSE_BYTES - overhead + 1),
      },
    };
    const partial = store.attach(slightlyLarger, "b", "only-first");
    expect(partial.structuredContent).toEqual({
      result: slightlyLarger.structuredContent,
      user_notes: [text],
    });
    expect(modelTextBytes(partial)).toBeLessThanOrEqual(NOTES_RESPONSE_BYTES);
    expect(store.page("b").pendingCount).toBe(1);
  });

  it("leaves mixed results completely unchanged when moving their text would leave no room for a note", () => {
    const { store } = fixture();
    store.enqueue("a", "pending", "message");
    // Original text fits; JSON encoding this distinct text needs more space.
    const ordinary: CallToolResult = {
      structuredContent: { success: false },
      content: [{ type: "text", text: "\0".repeat(7000) }],
      isError: true,
    };
    expect(modelTextBytes(ordinary)).toBeLessThan(36_000);
    const original = JSON.stringify(ordinary);
    expect(store.attach(ordinary, "a", "too-big")).toBe(ordinary);
    expect(JSON.stringify(ordinary)).toBe(original);
    expect(store.page("a").pendingCount).toBe(1);
    expect(store.attach(result("small"), "a", "later").content).toEqual([
      { type: "text", text: "small" },
      { type: "text", text: "用户额外补充：\nmessage" },
    ]);
  });

  it("supports normal errors, media and no output; cancellation or missing scope consumes nothing", () => {
    const { store } = fixture();
    store.enqueue("a", "id", "instruction");
    const ordinary: CallToolResult = {
      isError: true,
      content: [
        { type: "image", mimeType: "image/png", data: "fixture" },
        { type: "text", text: "Script failed" },
      ],
    };
    const controller = new AbortController();
    controller.abort();
    expect(store.attach(ordinary, "a", "cancelled", controller.signal)).toBe(
      ordinary,
    );
    expect(store.attach(ordinary, undefined, "unscoped")).toBe(ordinary);
    expect(store.page("a").pendingCount).toBe(1);
    const response = store.attach(ordinary, "a", "actual");
    expect(response.isError).toBe(true);
    expect(response.content.slice(0, 2)).toEqual(ordinary.content);
    store.enqueue("a", "empty", "no text budget dependency");
    expect(
      store.attach({ content: [] }, "a", "audit-disabled").content,
    ).toHaveLength(1);
    expect(store.page("a").items.at(-1)?.callId).toBeUndefined();
  });

  it("checks transport limits before committing delivery and never changes a failed operation into a retry", () => {
    const { store } = fixture();
    store.enqueue("a", "id", "message");
    const ordinary: CallToolResult = {
      content: [
        {
          type: "image",
          mimeType: "image/png",
          data: "x".repeat(MAX_PAYLOAD_BYTES),
        },
      ],
    };
    expect(store.attach(ordinary, "a", "oversize")).toBe(ordinary);
    expect(store.page("a").pendingCount).toBe(1);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const invalid: CallToolResult = {
      content: [],
      structuredContent: circular,
    };
    expect(store.attach(invalid, "a", "unencodable")).toBe(invalid);
    expect(store.page("a").pendingCount).toBe(1);
  });

  it("commits one synchronous batch before observers run, so concurrent returns cannot repeat messages", async () => {
    const { store, events } = fixture();
    store.enqueue("a", "id", "one");
    store.openWeb(() => {
      throw new Error("broken observer");
    });
    const normal = result();
    const responses = await Promise.all(
      [1, 2, 3].map(async (i) => store.attach(normal, "a", `call-${i}`)),
    );
    expect(responses.filter((r) => r !== normal)).toHaveLength(1);
    expect(events).toEqual([
      { type: "session:notes", sessionId: "a" },
      { type: "session:notes", sessionId: "a" },
    ]);
    expect(JSON.stringify(events)).not.toContain("one");
  });

  it("withdraws pending messages only, preserving history and creation retry identity", () => {
    const { store } = fixture();
    store.enqueue("a", "one", "withdraw me");
    store.enqueue("a", "two", "send me");
    store.withdraw("a", "one");
    store.withdraw("a", "one");
    expect(store.enqueue("a", "one", "withdraw me").status).toBe("withdrawn");
    const response = JSON.stringify(store.attach(result(), "a", "call"));
    expect(response).not.toContain("withdraw me");
    expect(response).toContain("send me");
    expect(() => store.withdraw("a", "two")).toThrow("无法撤回");
  });

  it("retains independent session metadata when audit is cleared, supports name search and history pagination", () => {
    const { store } = fixture();
    store.rename("a", "项目 Alpha");
    for (let i = 0; i < 32; i++) store.enqueue("a", `id-${i}`, `text-${i}`);
    const listed = store.sessions([], {
      page: 9,
      pageSize: 18,
      search: "alpha",
    });
    expect(listed.page).toBe(1);
    expect(listed.items).toEqual([
      expect.objectContaining({
        id: "a",
        canMessage: true,
        pendingNotes: 32,
        label: "项目 Alpha",
        callCount: 0,
      }),
    ]);
    expect(store.page("a").items).toHaveLength(30);
    expect(store.page("a", 2).items.map((n) => n.sequence)).toEqual([1, 2]);
    const unscoped = store.sessions(
      [
        {
          id: "unscoped",
          callCount: 1,
          errorCount: 0,
          firstSeen: "x",
          lastActive: "x",
        },
      ],
      { page: 1, pageSize: 18 },
    );
    expect(unscoped.items.find((s) => s.id === "unscoped")?.canMessage).toBe(
      false,
    );
  });

  it("bounds temporary storage, refuses new content rather than silently dropping pending notes and expires after 72 hours", () => {
    const { store, advance } = fixture(4096);
    store.enqueue("a", "one", "x".repeat(200));
    expect(() => store.enqueue("a", "two", "x".repeat(200))).toThrow(
      "空间已满",
    );
    expect(store.page("a").pendingCount).toBe(1);
    advance(NOTE_RETENTION_MS - 1);
    expect(store.page("a").pendingCount).toBe(1);
    advance(2);
    expect(() => store.page("a")).toThrow("已过期");
    store.observe("a");
    expect(store.page("a").items).toHaveLength(0);
    store.enqueue("a", "new", "after expiry");
  });
});

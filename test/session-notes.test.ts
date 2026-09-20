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
      expect.objectContaining({ text: expect.stringContaining("#1｜long｜") }),
      expect.objectContaining({ text: expect.stringContaining("#2｜short｜") }),
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
    expect(response.structuredContent).toBe(ordinary.structuredContent);
    expect(response.content).toHaveLength(1);
    expect(JSON.stringify(ordinary)).toBe(original);
    expect(modelTextBytes(response)).toBeLessThanOrEqual(37_000);
    store.enqueue("a", "blocked", "y".repeat(2000));
    expect(store.attach(ordinary, "a", "too-full")).toBe(ordinary);
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

import { describe, expect, it } from "vitest";
import { SessionNotes, modelTextBytes } from "../src/session-notes.js";
import { REQUEST_USER_INPUT_SCHEMA } from "../src/user-questions.js";
import {
  NOTE_RETENTION_MS,
  NOTE_MAX_BYTES,
} from "../src/session-notes-types.js";

const input = {
  questions: [
    { title: "Which storage?", options: ["SQLite", "Memory"] },
    { title: "When to migrate?", options: ["Later", "Now"] },
  ],
};
function fixture(maximum?: number) {
  let now = Date.UTC(2026, 8, 20);
  const store = new SessionNotes(maximum, () => now);
  const close = store.openWeb(() => {});
  const accepted = store.ask("a", input);
  store.observe("b");
  return {
    store,
    close,
    accepted,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
const ordinary = () => ({
  content: [],
  structuredContent: { output: "normal", exit_code: 0 },
});

describe("asynchronous questions are human-produced session notes", () => {
  it("requires a live Web listener and conversation scope, and returns acceptance without waiting", () => {
    const store = new SessionNotes();
    expect(() => store.ask("a", input)).toThrow("Web");
    const close = store.openWeb(() => {});
    expect(() => store.ask(undefined, input)).toThrow("对话标识");
    const response = store.ask("a", input);
    expect(response).toEqual({
      accepted: true,
      request_id: expect.stringMatching(/^ask_/),
    });
    expect(store.questions("a").pendingCount).toBe(2);
    expect(store.page("a").items).toEqual([]);
    close();
    expect(() => store.ask("a", input)).toThrow("Web");
    expect(store.questions("a").total).toBe(2);
  });

  it("keeps immutable, scoped request identities and optional idempotency keys", () => {
    const { store } = fixture();
    const first = store.ask("a", { ...input, request_key: "storage" });
    expect(store.ask("a", { ...input, request_key: "storage" })).toEqual(first);
    expect(() =>
      store.ask("a", {
        request_key: "storage",
        questions: [{ title: "Changed?", options: ["A", "B"] }],
      }),
    ).toThrow("已改变");
    const other = store.ask("b", { ...input, request_key: "storage" });
    expect(other.request_id).not.toBe(first.request_id);
    const copy = store.questions("a");
    copy.items[0]!.options[0] = "mutated";
    expect(store.questions("a").items[0]!.options[0]).toBe("SQLite");
    store.rename("a", "Local project");
    const groups = store.sessions([], {
      page: 1,
      pageSize: 10,
      pendingQuestionsOnly: true,
    });
    expect(groups.pendingQuestionsTotal).toBe(6);
    expect(groups.items.find((c) => c.id === "a")).toMatchObject({
      label: "Local project",
      pendingQuestions: 4,
    });
  });

  it("validates concise questions and multiple distinct options without requiring hand-authored IDs", () => {
    expect(REQUEST_USER_INPUT_SCHEMA.parse(input)).toEqual(input);
    for (const options of [
      [],
      ["one"],
      ["same", " same "],
      ["", "valid"],
      Array.from({ length: 7 }, (_, i) => String(i)),
    ])
      expect(
        REQUEST_USER_INPUT_SCHEMA.safeParse({
          questions: [{ title: "Choose", options }],
        }).success,
      ).toBe(false);
    expect(REQUEST_USER_INPUT_SCHEMA.safeParse({ questions: [] }).success).toBe(
      false,
    );
    expect(
      REQUEST_USER_INPUT_SCHEMA.safeParse({
        questions: Array(4).fill(input.questions[0]),
      }).success,
    ).toBe(false);
  });

  it("enqueues independent choice-plus-note answers atomically in human submission order", () => {
    const { store } = fixture();
    const [first, second] = store.questions("a").items;
    store.enqueue("a", "before", "先保留兼容性");
    const events: number[] = [];
    store.openWeb(() => events.push(store.questions("a").pendingCount));
    const reply = store.answer("a", second!.id, {
      id: "second",
      option_index: 0,
      note: "  先不要迁移。\n保留旧文件。  ",
    });
    expect(events).toEqual([1]);
    expect(reply.text).toBe(
      "问题：When to migrate?\n选择：Later\n补充：  先不要迁移。\n保留旧文件。  ",
    );
    store.enqueue("a", "middle", "其他工作继续");
    store.answer("a", first!.id, {
      id: "first",
      option_index: null,
      note: "选择 PostgreSQL。",
    });
    const response = store.attach(ordinary(), "a", "call");
    expect(response.content).toEqual([]);
    expect(response.structuredContent).toEqual({
      result: ordinary().structuredContent,
      user_notes: [
        "先保留兼容性",
        reply.text,
        "其他工作继续",
        "问题：Which storage?\n选择：以上都不是\n补充：选择 PostgreSQL。",
      ],
    });
    expect(store.questions("a").pendingCount).toBe(0);
    expect(
      store.questions("a").items.every((q) => q.delivery === "attached"),
    ).toBe(true);
    expect(store.attach(ordinary(), "a", "later")).toEqual(ordinary());
  });

  it("deduplicates retries, rejects stale competing replies and reopens a withdrawn answer", () => {
    const { store } = fixture();
    const question = store.questions("a").items[0]!;
    const input = { id: "submission", option_index: 0, note: "Keep files" };
    const first = store.answer("a", question.id, input);
    expect(store.answer("a", question.id, input)).toEqual(first);
    expect(() =>
      store.answer("a", question.id, { ...input, note: "Change files" }),
    ).toThrow("改变");
    expect(() =>
      store.answer("a", question.id, { ...input, id: "competitor" }),
    ).toThrow("另一处");
    expect(() => store.answer("b", question.id, input)).toThrow("不存在");
    store.withdraw("a", first.id);
    expect(store.questions("a").items[0]!.pending).toBe(true);
    expect(store.answer("a", question.id, input).status).toBe("withdrawn");
    const second = store.answer("a", question.id, {
      id: "replacement",
      option_index: 1,
      note: "",
    });
    store.answer("a", question.id, input); // An old retry cannot overwrite the newer answer.
    expect(
      store.questions("a").items.find((q) => q.id === question.id)!.answer
        ?.noteId,
    ).toBe(second.id);
    store.attach(ordinary(), "a", "sent");
    expect(() => store.withdraw("a", second.id)).toThrow("无法撤回");
  });

  it("rejects invalid/custom-empty/oversize answers without closing the question or creating a note", () => {
    const { store } = fixture();
    const q = store.questions("a").items[0]!;
    for (const answer of [
      { id: "x", option_index: null, note: "  " },
      { id: "x", option_index: 99, note: "" },
      { id: "x", option_index: 0, note: "x".repeat(NOTE_MAX_BYTES) },
      { id: "x", option_index: 0, note: "\0".repeat(6000) },
    ])
      expect(() => store.answer("a", q.id, answer)).toThrow();
    expect(store.questions("a").pendingCount).toBe(2);
    expect(store.page("a").items).toEqual([]);
    store.answer("a", q.id, { id: "valid", option_index: 0, note: "" });
    expect(store.page("a").items[0]!.text).toBe(
      "问题：Which storage?\n选择：SQLite",
    );
  });

  it("shares spare-budget FIFO and exact structured delivery with ordinary side notes", () => {
    const { store } = fixture();
    const q = store.questions("a").items[0]!;
    store.answer("a", q.id, {
      id: "long",
      option_index: 0,
      note: "L".repeat(5000),
    });
    store.enqueue("a", "short", "short");
    const full = {
      content: [],
      structuredContent: { output: "x".repeat(35_970) },
    };
    expect(store.attach(full, "a", "no-room")).toBe(full);
    expect(
      store.questions("a").items.find((item) => item.id === q.id)!.delivery,
    ).toBe("pending");
    const delivered = store.attach(ordinary(), "a", "room");
    expect(
      (delivered.structuredContent as { user_notes: string[] }).user_notes,
    ).toHaveLength(2);
    expect(modelTextBytes(delivered)).toBeLessThanOrEqual(37_000);
    expect(store.page("a").pendingCount).toBe(0);
  });

  it("accounts for question/answer memory, refuses full submissions atomically and expires both", () => {
    const { store, advance } = fixture(8500);
    const q = store.questions("a").items[0]!;
    expect(() =>
      store.answer("a", q.id, {
        id: "full",
        option_index: 0,
        note: "x".repeat(2000),
      }),
    ).toThrow("空间已满");
    expect(store.questions("a").pendingCount).toBe(2);
    expect(store.page("a").pendingCount).toBe(0);
    advance(NOTE_RETENTION_MS - 1);
    store.answer("a", q.id, { id: "short", option_index: 1, note: "later" });
    advance(2);
    expect(
      store.questions("a").items.find((item) => item.id === q.id)!.answer?.note,
    ).toBe("later");
    advance(NOTE_RETENTION_MS);
    expect(store.sessions([], { page: 1, pageSize: 10 }).items).toEqual([]);
    expect(store["bytes"]).toBe(0);
  });
});

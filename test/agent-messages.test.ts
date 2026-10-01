import { describe, expect, it } from "vitest";
import { SessionNotes } from "../src/session-notes.js";
import { SEND_MESSAGE_TO_USER_SCHEMA } from "../src/agent-messages.js";
import {
  NOTE_MAX_BYTES,
  NOTE_RETENTION_MS,
  type SessionNotesEvent,
} from "../src/session-notes-types.js";
import { buildEntries } from "../ui/src/components/conversation/entries.js";
import { callListItem, nestedPreview } from "../src/web/call-summary.js";
import { describeStep, stepKind } from "../ui/src/lib/steps.js";
import { createTranslator } from "../ui/src/lib/locale.js";

describe("agent messages in the conversation timeline", () => {
  it("accepts one message immediately, keeps its author separate and emits metadata only", () => {
    const notes = new SessionNotes();
    const events: SessionNotesEvent[] = [];
    const close = notes.openWeb((event) => events.push(event));
    expect(
      notes.sendMessage(
        "a",
        { message: "  Answer from ChatGPT\n<script>literal</script>  " },
        "call_1",
      ),
    ).toEqual({ accepted: true });
    notes.observe("b");
    const page = notes.page("a");
    expect(page.items).toEqual([]);
    expect(page.pendingCount).toBe(0);
    expect(page.pendingQuestions).toBe(0);
    expect(page.agentMessages).toEqual([
      expect.objectContaining({
        text: "Answer from ChatGPT\n<script>literal</script>",
        callId: "call_1",
      }),
    ]);
    expect(notes.page("b").agentMessages).toEqual([]);
    expect(events).toEqual([
      {
        type: "session:notes",
        sessionId: "a",
        agentMessage: { id: page.agentMessages[0]!.id },
      },
    ]);
    page.agentMessages[0]!.text = "mutated";
    expect(notes.page("a").agentMessages[0]!.text).toContain(
      "Answer from ChatGPT",
    );
    const result = { content: [], structuredContent: { output: "normal" } };
    expect(notes.attach(result, "a", "later")).toBe(result);
    notes.enqueue("a", "human", "Please keep the existing data.");
    expect(notes.attach(result, "b", "other")).toBe(result);
    expect(notes.attach(result, "a", "later").structuredContent).toEqual({
      result: { output: "normal" },
      user_notes: ["Please keep the existing data."],
    });
    close();
    expect(notes.page("a").agentMessages).toHaveLength(1);
    expect(() => notes.sendMessage("a", { message: "offline" })).toThrow("Web");
  });

  it("requires a live Web server and conversation identity and validates before storing", () => {
    const notes = new SessionNotes();
    expect(() => notes.sendMessage("a", { message: "x" })).toThrow("Web");
    notes.openWeb(() => {});
    expect(() => notes.sendMessage(undefined, { message: "x" })).toThrow(
      "conversation ID",
    );
    for (const value of [
      { message: "   " },
      { message: 1 },
      {},
      { message: "x", session_id: "b" },
    ])
      expect(SEND_MESSAGE_TO_USER_SCHEMA.safeParse(value).success).toBe(false);
    expect(() =>
      notes.sendMessage("a", { message: "汉".repeat(10001) }),
    ).toThrow("UTF-8");
    expect(() => notes.page("a")).toThrow();
    notes.sendMessage("a", { message: "汉".repeat(NOTE_MAX_BYTES / 3) });
    expect(notes.page("a").agentMessages[0]!.text).toHaveLength(10000);
  });

  it("shares the bounded retention pool and reclaims message storage", () => {
    let now = 1000;
    const notes = new SessionNotes(4500, () => now);
    notes.openWeb(() => {});
    notes.sendMessage("a", { message: "x".repeat(400) });
    expect(() => notes.sendMessage("a", { message: "x".repeat(400) })).toThrow(
      "is full",
    );
    expect(notes.page("a").agentMessages).toHaveLength(1);
    now += NOTE_RETENTION_MS + 1;
    notes.sendMessage("a", { message: "replacement" });
    expect(notes.page("a").agentMessages.map((m) => m.text)).toEqual([
      "replacement",
    ]);
    const rows = notes.sessions([], { page: 1, pageSize: 10 });
    expect(rows.items[0]!.id).toBe("a");
  });

  it("keeps messages unread until the operator dismisses them in the Web UI", () => {
    let now = 1000;
    const notes = new SessionNotes(undefined, () => now);
    const events: SessionNotesEvent[] = [];
    notes.openWeb((event) => events.push(event));
    notes.sendMessage("a", { message: "first" });
    now += 1000;
    notes.sendMessage("a", { message: "second\nwith detail" });
    const [first, second] = notes.page("a").agentMessages;
    expect(
      notes.sessions([], { page: 1, pageSize: 10 }).items[0],
    ).toMatchObject({
      id: "a",
      unreadMessages: 2,
      messagePreview: "second\nwith detail",
    });
    events.length = 0;
    now += 1000;
    notes.readMessages("a", [second!.id, "unknown"]);
    expect(events).toEqual([{ type: "session:notes", sessionId: "a" }]);
    expect(notes.page("a").agentMessages.map((m) => m.readAt)).toEqual([
      undefined,
      new Date(now).toISOString(),
    ]);
    expect(
      notes.sessions([], { page: 1, pageSize: 10 }).items[0],
    ).toMatchObject({ unreadMessages: 1, messagePreview: "first" });
    notes.readMessages("a", [second!.id]);
    expect(events).toHaveLength(1);
    notes.readMessages("a", [first!.id]);
    expect(
      notes.sessions([], { page: 1, pageSize: 10 }).items[0],
    ).toMatchObject({ unreadMessages: 0, messagePreview: "" });
    const result = { content: [], structuredContent: { output: "normal" } };
    expect(notes.attach(result, "a", "later")).toBe(result);
    expect(() => notes.readMessages("missing", [first!.id])).toThrow();
  });

  it("paginates messages independently of user replies and merges them chronologically", () => {
    let now = 1000;
    const notes = new SessionNotes(undefined, () => now++);
    notes.openWeb(() => {});
    for (let i = 0; i < 65; i++)
      notes.sendMessage("a", { message: `message ${i}` });
    notes.enqueue("a", "reply", "human reply");
    const unread = notes.page("a").agentMessages;
    expect(unread).toHaveLength(65);
    notes.readMessages(
      "a",
      unread.filter((m) => m.text !== "message 3").map((m) => m.id),
    );
    const pages = [1, 2, 3].map((p) => notes.page("a", p));
    // The first page also carries older unread messages.
    expect(pages.map((p) => p.agentMessages.length)).toEqual([31, 30, 5]);
    expect(pages[0]!.agentMessages[0]!.text).toBe("message 3");
    expect(pages[0]!.totalPages).toBe(3);
    const messages = [
      ...new Map(
        pages.flatMap((p) => p.agentMessages).map((m) => [m.id, m]),
      ).values(),
    ];
    expect(messages).toHaveLength(65);
    const entries = buildEntries([], pages[0]!.items, [], true, messages);
    expect(entries[0]).toMatchObject({
      kind: "agent",
      message: { text: "message 0" },
    });
    expect(entries.at(-1)).toMatchObject({
      kind: "note",
      note: { text: "human reply" },
    });
    expect(buildEntries([], [], [], false, messages)).toEqual([]);
    const name = "send_message_to_user_async";
    expect(stepKind(name)).toBe("message");
    expect(nestedPreview(name, { message: "Update\nlonger context" })).toBe(
      "Update",
    );
    expect(
      describeStep({ name, preview: "Update" }, createTranslator("en")),
    ).toEqual({ verb: "Sent you a message", subject: "Update" });
  });

  it("shows a message under the call that sent it, or on its own when that call is not loaded", () => {
    const sender = callListItem({
      id: "call_1",
      sessionId: "a",
      tool: "exec",
      status: "running",
      startedAt: "2026-09-28T10:00:00.000Z",
      args: {},
      subcalls: [],
    });
    const message = (id: string, callId: string, createdAt: string) => ({
      id,
      text: id,
      callId,
      createdAt,
    });
    const entries = buildEntries([sender], [], [], true, [
      message("attached", "call_1", "2026-09-28T10:00:02.000Z"),
      message("orphan", "call_0", "2026-09-28T09:59:00.000Z"),
    ]);
    expect(entries.map((entry) => entry.kind)).toEqual(["agent", "call"]);
    expect(entries[1]).toMatchObject({
      kind: "call",
      messages: [{ id: "attached" }],
    });
  });
});

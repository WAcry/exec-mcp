import { afterEach, describe, expect, it } from "vitest";
import { SessionNotes } from "../src/session-notes.js";

const dispose: (() => void)[] = [];
afterEach(() => {
  for (const close of dispose.splice(0)) close();
});
function fixture() {
  const notes = new SessionNotes();
  dispose.push(notes.openWeb(() => {}));
  notes.observe("a");
  notes.observe("b");
  const watch = (id: string | undefined = "a") => {
    const observation = notes.watchUserNotes(id);
    dispose.push(observation.dispose);
    return observation;
  };
  return { notes, watch };
}

describe("user submissions yield only in-flight conversation observations", () => {
  it("signals all current observers of the right conversation after committing the note", () => {
    const { notes, watch } = fixture();
    const first = watch(),
      second = watch(),
      other = watch("b");
    const unscoped = notes.watchUserNotes(undefined);
    dispose.push(unscoped.dispose);
    let saved: string | undefined;
    first.signal.addEventListener("abort", () => {
      saved = notes.page("a").items[0]?.text;
    });
    notes.enqueue("a", "one", "Original message");
    expect(saved).toBe("Original message");
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
    expect(other.signal.aborted).toBe(false);
    expect(unscoped.signal.aborted).toBe(false);
    const next = watch();
    first.dispose();
    second.dispose();
    notes.enqueue("a", "two", "Next message");
    expect(next.signal.aborted).toBe(true);
  });

  it("does not yield for old pending notes, retries, rejected input or disposed observations", () => {
    const { notes, watch } = fixture();
    notes.enqueue("a", "one", "Old message");
    const current = watch();
    const gone = watch();
    gone.dispose();
    notes.enqueue("a", "one", "Old message");
    expect(() => notes.enqueue("a", "one", "Different")).toThrow();
    expect(() => notes.enqueue("a", "empty", " ")).toThrow();
    expect(() => notes.enqueue("a", "huge", "x".repeat(30_001))).toThrow();
    expect(current.signal.aborted).toBe(false);
    notes.enqueue("a", "new", "New message");
    expect(current.signal.aborted).toBe(true);
    expect(gone.signal.aborted).toBe(false);
  });

  it("ignores agent messages, questions, read state, labels, withdrawals and delivery", () => {
    const { notes, watch } = fixture();
    notes.enqueue("a", "withdraw", "Withdraw me");
    notes.enqueue("a", "deliver", "Deliver me");
    const current = watch();
    notes.setTitle("a", "A title");
    notes.rename("a", "Another title");
    notes.sendMessage("a", { message: "Agent message" });
    notes.readMessages(
      "a",
      notes.page("a").agentMessages.map((m) => m.id),
    );
    notes.ask("a", { questions: [{ title: "Which?", options: ["A", "B"] }] });
    notes.withdraw("a", "withdraw");
    notes.attach({ content: [] }, "a", "call");
    expect(current.signal.aborted).toBe(false);
  });

  it("signals only a new valid answer with the choice and note already committed", () => {
    const { notes, watch } = fixture();
    notes.ask("a", { questions: [{ title: "Which?", options: ["A", "B"] }] });
    const question = notes.questions("a").items[0]!;
    const current = watch();
    expect(() =>
      notes.answer("a", question.id, {
        id: "bad",
        option_index: null,
        note: "",
      }),
    ).toThrow();
    expect(current.signal.aborted).toBe(false);
    let committed = false;
    current.signal.addEventListener("abort", () => {
      committed =
        !notes.questions("a").items[0]!.pending &&
        notes.page("a").pendingCount === 1;
    });
    const input = { id: "answer", option_index: 0, note: "Keep Node 20." };
    const saved = notes.answer("a", question.id, input);
    expect(committed).toBe(true);
    expect(current.signal.aborted).toBe(true);
    const next = watch();
    expect(notes.answer("a", question.id, input)).toEqual(saved);
    expect(next.signal.aborted).toBe(false);
  });
});

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UserInputStore } from "../src/user-input/store.js";
import {
  REQUEST_INPUT_SCHEMA,
  type AnswerEvent,
} from "../src/user-input/contracts.js";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function database() {
  const dir = await mkdtemp(path.join(tmpdir(), "exec-input-"));
  cleanup.push(() => rm(dir, { force: true, recursive: true }));
  const file = path.join(dir, "private", "questions.sqlite3");
  const store = new UserInputStore(file);
  cleanup.push(() => store.close());
  return { store, file };
}
const payload = {
  request_key: "storage-v1",
  questions: [
    { title: "选用哪种存储？", options: ["SQLite", "PostgreSQL"] },
    { title: "还有哪些约束？" },
  ],
};
const events = (store: UserInputStore, scope = "chat-a") =>
  store
    .delivery(scope)
    .content.filter((item) => item.text.startsWith("用户答复（"))
    .map(
      (item) =>
        JSON.parse(item.text.slice(item.text.indexOf("\n") + 1)) as AnswerEvent,
    );

describe("durable per-conversation asynchronous input", () => {
  it("rejects an escape-heavy question that could never fit a complete answer event", async () => {
    const { store } = await database();
    const request = {
      request_key: "encoded-question",
      questions: [
        {
          title: "Choose one",
          options: Array.from(
            { length: 7 },
            (_, index) => "\u0001".repeat(499) + index,
          ),
        },
      ],
    };
    expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThan(24000);
    expect(REQUEST_INPUT_SCHEMA.safeParse(request).success).toBe(false);
    expect(() => store.create("chat-a", request)).toThrow("问题参数无效或过长");
    expect(store.list().total).toBe(0);
  });
  it("creates immediately, assigns stable ids, deduplicates retries and rejects changed content for the same key", async () => {
    const { store } = await database();
    const created = store.create("chat-a", payload);
    expect(created).toMatchObject({
      accepted: true,
      status: "pending",
      question_ids: ["q1", "q2"],
    });
    expect(store.create("chat-a", payload)).toEqual(created);
    expect(store.list().total).toBe(1);
    expect(() =>
      store.create("chat-a", { ...payload, questions: [{ title: "changed" }] }),
    ).toThrow("不同问题");
    const other = store.create("chat-b", payload);
    expect(other.request_id).not.toBe(created.request_id);
    expect(() => store.create(undefined, payload)).toThrow("openai/session");
    expect(() => store.getForScope("chat-b", created.request_id)).toThrow(
      "当前对话",
    );
    expect(
      store.getForScope("chat-a", created.request_id).questions[0]!.options,
    ).toEqual([
      { id: "o1", label: "SQLite" },
      { id: "o2", label: "PostgreSQL" },
    ]);
    expect(store.delivery(undefined).content).toEqual([]);
  });
  it("keeps selection plus exact notes and allows independent free-text answers without auto-submitting recommendations", async () => {
    const { store } = await database();
    const request = store.create("chat-a", payload);
    expect(
      store
        .get(request.request_id)
        .questions.every((question) => question.answer === null),
    ).toBe(true);
    const notes = "选择这个，\n但请先不要迁移数据。  ";
    const partial = store.answer(request.request_id, {
      question_id: "q1",
      expected_revision: 0,
      selected_option_id: "o1",
      notes,
    });
    expect(partial.status).toBe("pending");
    expect(partial.questions[0]!.answer).toMatchObject({
      selected_option_label: "SQLite",
      notes,
      delivery: "saved",
      revision: 1,
    });
    expect(() =>
      store.answer(request.request_id, {
        question_id: "q2",
        expected_revision: 0,
        selected_option_id: null,
        notes: " ",
      }),
    ).toThrow("自定义");
    expect(() =>
      store.answer(request.request_id, {
        question_id: "q2",
        expected_revision: 0,
        selected_option_id: "o1",
        notes: "",
      }),
    ).toThrow("选项不存在");
    expect(
      store.answer(request.request_id, {
        question_id: "q2",
        expected_revision: 0,
        selected_option_id: null,
        notes: "只做接口",
      }).status,
    ).toBe("answered");
    const delivered = events(store);
    expect(delivered).toHaveLength(2);
    expect(
      delivered.find((event) => event.question_id === "q1")!.answer_from_user
        .notes,
    ).toBe(notes);
    expect(
      delivered.find((event) => event.question_id === "q2")!.answer_from_user
        .kind,
    ).toBe("text");
    expect(delivered[0]!.question_from_agent).toHaveProperty("title");
    expect(events(store, "chat-b")).toHaveLength(0);
  });
  it("retains unacknowledged events across loss, retries, restart and revision conflicts", async () => {
    const { store, file } = await database();
    const request = store.create("chat-a", payload);
    store.answer(request.request_id, {
      question_id: "q1",
      expected_revision: 0,
      selected_option_id: "o1",
      notes: "before",
    });
    const first = events(store)[0]!;
    expect(events(store)[0]!.event_id).toBe(first.event_id);
    expect(store.get(request.request_id).questions[0]!.answer?.delivery).toBe(
      "attempted",
    );
    store.close();
    const reopened = new UserInputStore(file);
    cleanup.push(() => reopened.close());
    expect(events(reopened)[0]).toEqual(first);
    expect(() =>
      reopened.answer(request.request_id, {
        question_id: "q1",
        expected_revision: 0,
        selected_option_id: null,
        notes: "stale tab",
      }),
    ).toThrow("已有更新");
    reopened.answer(request.request_id, {
      question_id: "q1",
      expected_revision: 1,
      selected_option_id: null,
      notes: "new constraint",
    });
    const revised = events(reopened)[0]!;
    expect(revised).toMatchObject({
      supersedes_event_id: first.event_id,
      answer_from_user: {
        revision: 2,
        notes: "new constraint",
        selected_option_id: null,
      },
    });
    reopened.acknowledge("chat-a", [first.event_id]);
    expect(events(reopened)[0]!.event_id).toBe(revised.event_id);
    reopened.acknowledge("chat-a", [revised.event_id, revised.event_id]);
    reopened.acknowledge("chat-a", [revised.event_id]);
    expect(events(reopened)).toHaveLength(0);
    expect(
      reopened.get(request.request_id).questions[0]!.answer?.delivery,
    ).toBe("acknowledged");
  });
  it("uses transactions for concurrent connections, answer races and all-or-nothing acknowledgments", async () => {
    const { store, file } = await database();
    const second = new UserInputStore(file);
    cleanup.push(() => second.close());
    const request = store.create("chat-a", payload);
    expect(second.create("chat-a", payload).request_id).toBe(
      request.request_id,
    );
    store.answer(request.request_id, {
      question_id: "q1",
      expected_revision: 0,
      selected_option_id: "o1",
      notes: "first",
    });
    expect(() =>
      second.answer(request.request_id, {
        question_id: "q1",
        expected_revision: 0,
        selected_option_id: "o2",
        notes: "second",
      }),
    ).toThrow("已有更新");
    const event = events(store)[0]!;
    expect(() => second.acknowledge("chat-b", [event.event_id])).toThrow(
      "当前对话",
    );
    expect(() =>
      second.acknowledge("chat-a", [event.event_id, "unknown"]),
    ).toThrow("当前对话");
    expect(events(store)[0]!.event_id).toBe(event.event_id);
    expect(second.get(request.request_id).questions[0]!.answer?.notes).toBe(
      "first",
    );
  });
  it("pages complete events within a byte budget; leaves overflow queued until an ack permits the next batch", async () => {
    const { store } = await database();
    for (let i = 0; i < 5; i++) {
      const request = store.create("chat-a", {
        request_key: `key-${i}`,
        questions: [{ title: `Question ${i}` }],
      });
      store.answer(request.request_id, {
        question_id: "q1",
        expected_revision: 0,
        selected_option_id: null,
        notes: `notes-${i}:` + "x".repeat(5500),
      });
    }
    const ids = new Set<string>();
    while (true) {
      const batch = store.delivery("chat-a");
      expect(batch.bytes).toBeLessThanOrEqual(18000);
      if (!batch.content.length) break;
      const selected = batch.content
        .filter((item) => item.text.startsWith("用户答复（"))
        .map(
          (item) =>
            JSON.parse(
              item.text.slice(item.text.indexOf("\n") + 1),
            ) as AnswerEvent,
        );
      expect(selected.length).toBeGreaterThan(0);
      for (const event of selected) {
        expect(event.answer_from_user.notes).toContain("x".repeat(5500));
        ids.add(event.event_id);
      }
      store.acknowledge(
        "chat-a",
        selected.map((event) => event.event_id),
      );
    }
    expect(ids.size).toBe(5);
  });
  it("delivers committed answers FIFO even if the wall clock moves backwards", async () => {
    const { store } = await database();
    const clock = vi.spyOn(Date, "now");
    try {
      for (let index = 0; index < 5; index++) {
        clock.mockReturnValue(1_780_000_000_000 - index * 1000);
        const request = store.create("chat-a", {
          request_key: `fifo-${index}`,
          questions: [{ title: "Decision?" }],
        });
        store.answer(request.request_id, {
          question_id: "q1",
          expected_revision: 0,
          selected_option_id: null,
          notes: `answer-${index}`,
        });
      }
      expect(
        events(store).map((event) => event.answer_from_user.notes),
      ).toEqual(["answer-0", "answer-1", "answer-2", "answer-3", "answer-4"]);
    } finally {
      clock.mockRestore();
    }
  });
  it("keeps pending decisions across cleanup and prunes only fully acknowledged old history", async () => {
    const { store } = await database();
    const pending = store.create("pending", {
      request_key: "pending",
      questions: [{ title: "pending" }],
    });
    const saved = store.create("saved", {
      request_key: "saved",
      questions: [{ title: "saved" }],
    });
    const acked = store.create("acked", {
      request_key: "acked",
      questions: [{ title: "acked" }],
    });
    for (const request of [saved, acked])
      store.answer(request.request_id, {
        question_id: "q1",
        expected_revision: 0,
        selected_option_id: null,
        notes: "answer",
      });
    store.acknowledge(
      "acked",
      events(store, "acked").map((event) => event.event_id),
    );
    store.prune(Date.now() + 31 * 86400_000);
    expect(store.get(pending.request_id).status).toBe("pending");
    expect(store.get(saved.request_id).questions[0]!.answer?.notes).toBe(
      "answer",
    );
    expect(() => store.get(acked.request_id)).toThrow();
    expect(
      store.list({ status: "pending" }).items.map((item) => item.id),
    ).toEqual([pending.request_id]);
  });
  it("retains private on-disk data, exposes no unavailable Web state and bounds input rather than truncating answers", async () => {
    const { store, file } = await database();
    expect(store.webAvailable).toBe(false);
    const detach = store.attachWeb();
    expect(store.webAvailable).toBe(true);
    detach();
    detach();
    expect(store.webAvailable).toBe(false);
    expect(
      REQUEST_INPUT_SCHEMA.safeParse({
        request_key: "k",
        questions: [{ title: "t", options: ["duplicate", "duplicate"] }],
      }).success,
    ).toBe(false);
    const request = store.create("scope", {
      request_key: "key",
      questions: [{ title: "t" }],
    });
    expect(() =>
      store.answer(request.request_id, {
        question_id: "q1",
        expected_revision: 0,
        selected_option_id: null,
        notes: "x".repeat(6001),
      }),
    ).toThrow("6000");
    expect(store.get(request.request_id).questions[0]!.answer).toBeNull();
    store.close();
    expect((await readFile(file)).subarray(0, 15).toString()).toBe(
      "SQLite format 3",
    );
  });
});

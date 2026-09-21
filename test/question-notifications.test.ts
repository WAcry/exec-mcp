import { afterEach, describe, expect, it, vi } from "vitest";
import {
  QuestionNotifications,
  QUESTION_NOTIFICATION_SETTING,
} from "../ui/src/lib/question-notifications.js";
import { SessionNotes } from "../src/session-notes.js";
import type { SessionNotesEvent } from "../src/session-notes-types.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const event = (
  id = "ask_one",
  sessionId = "hash_A_abcdefghijklmnopqrstuv1234567890",
): SessionNotesEvent => ({
  type: "session:notes",
  sessionId,
  questionRequest: { id, count: 2 },
});
function browser(permission: NotificationPermission = "granted") {
  const shown: FakeNotification[] = [];
  const values = new Map<string, string>();
  const storage = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
  };
  class FakeNotification {
    static permission = permission;
    static requestPermission = vi.fn(
      async (): Promise<NotificationPermission> => {
        FakeNotification.permission = "granted" as const;
        return FakeNotification.permission;
      },
    );
    onclick: ((event: Event) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    close = vi.fn(() => this.onclose?.());
    constructor(
      readonly title: string,
      readonly options: NotificationOptions,
    ) {
      shown.push(this);
    }
  }
  let tail = Promise.resolve();
  const locks = {
    request: vi.fn((_name: string, action: () => void) => {
      const result = tail.then(action);
      tail = result.catch(() => {});
      return result;
    }),
  };
  const fakeWindow = {
    Notification: FakeNotification,
    isSecureContext: true,
    localStorage: storage,
    navigator: { locks },
    focus: vi.fn(),
  };
  vi.stubGlobal("window", fakeWindow);
  const open = vi.fn();
  const changed = vi.fn();
  const notifier = new QuestionNotifications(open, changed);
  return {
    notifier,
    open,
    changed,
    shown,
    values,
    storage,
    fakeWindow,
    FakeNotification,
    locks,
  };
}

describe("browser question notification delivery", () => {
  it("asks permission only on explicit enable and groups a request into one private notification", async () => {
    const b = browser("default");
    await b.notifier.receive(event());
    expect(b.FakeNotification.requestPermission).not.toHaveBeenCalled();
    expect(b.shown).toEqual([]);
    await b.notifier.enable();
    expect(b.FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
    await b.notifier.receive(event());
    expect(b.shown).toHaveLength(1);
    expect(b.shown[0]!.options.body).toBe(
      "会话 hash_A_a…7890 有 2 个新问题，点击作答。",
    );
    const click = new Event("click", { cancelable: true });
    b.shown[0]!.onclick?.(click);
    expect(click.defaultPrevented).toBe(true);
    expect(b.fakeWindow.focus).toHaveBeenCalledTimes(1);
    expect(b.open).toHaveBeenCalledWith(event().sessionId);
  });

  it("deduplicates repeated events, same-origin tabs and reloads without consuming questions", async () => {
    const b = browser();
    const other = new QuestionNotifications(vi.fn(), vi.fn());
    await Promise.all([
      b.notifier.receive(event()),
      other.receive(event()),
      b.notifier.receive(event()),
    ]);
    const reload = new QuestionNotifications(vi.fn(), vi.fn());
    await reload.receive(event());
    expect(b.shown).toHaveLength(1);
    await reload.receive(event("ask_two"));
    expect(b.shown).toHaveLength(2);
  });

  it("ignores normal note changes and supports pause, cross-tab preference refresh and test notification", async () => {
    const b = browser();
    await b.notifier.receive({ type: "session:notes", sessionId: "a" });
    expect(b.shown).toHaveLength(0);
    b.notifier.pause();
    await b.notifier.receive(event());
    expect(b.shown).toHaveLength(0);
    expect(b.values.get(QUESTION_NOTIFICATION_SETTING)).toBe("off");
    await b.notifier.enable();
    b.notifier.test();
    expect(b.shown).toHaveLength(1);
    b.values.set(QUESTION_NOTIFICATION_SETTING, "off");
    b.notifier.refresh();
    expect(b.notifier.state).toBe("paused");
    expect(b.shown[0]!.close).toHaveBeenCalled();
  });

  it.each(["default", "denied"] as const)(
    "never notifies without permission (%s)",
    async (permission) => {
      const b = browser(permission);
      await b.notifier.receive(event());
      b.notifier.test();
      expect(b.shown).toHaveLength(0);
      if (permission === "denied") await b.notifier.enable();
      expect(b.FakeNotification.requestPermission).not.toHaveBeenCalled();
    },
  );

  it("degrades on insecure or unsupported browsers instead of crashing", async () => {
    const b = browser();
    b.fakeWindow.isSecureContext = false;
    expect(b.notifier.state).toBe("insecure");
    await b.notifier.enable();
    await b.notifier.receive(event());
    b.fakeWindow.isSecureContext = true;
    Object.defineProperty(b.fakeWindow, "Notification", { value: undefined });
    expect(b.notifier.state).toBe("unsupported");
    await b.notifier.enable();
    expect(b.shown).toHaveLength(0);
  });

  it("keeps local preferences and delivery usable when storage or Web Locks are unavailable", async () => {
    const b = browser();
    b.storage.setItem.mockImplementation(() => {
      throw new Error("quota");
    });
    b.locks.request.mockRejectedValue(new Error("not allowed"));
    b.notifier.pause();
    b.notifier.refresh();
    expect(b.notifier.state).toBe("paused");
    await b.notifier.enable();
    await b.notifier.receive(event());
    await b.notifier.receive(event());
    expect(b.shown).toHaveLength(1);
    b.storage.getItem.mockImplementation(() => {
      throw new Error("blocked");
    });
    await b.notifier.receive(event("ask_next"));
    expect(b.shown).toHaveLength(2);
  });

  it("contains constructor and asynchronous display failures without unhandled rejections", async () => {
    const b = browser();
    class UnsupportedNotification extends b.FakeNotification {
      constructor(title: string, options: NotificationOptions) {
        super(title, options);
        throw new TypeError("mobile");
      }
    }
    b.fakeWindow.Notification = UnsupportedNotification;
    await expect(b.notifier.receive(event())).resolves.toBeUndefined();
    expect(b.notifier.state).toBe("error");
    b.fakeWindow.Notification = b.FakeNotification;
    await b.notifier.enable();
    await b.notifier.receive(event());
    b.shown.at(-1)!.onerror?.();
    expect(b.notifier.state).toBe("error");
  });

  it("does not create notifications after logout, including a pending permission or queued lock", async () => {
    const b = browser();
    const pending = b.notifier.receive(event());
    b.notifier.dispose();
    await pending;
    expect(b.shown).toHaveLength(0);
    b.FakeNotification.permission = "default";
    let resolve!: (value: NotificationPermission) => void;
    b.FakeNotification.requestPermission.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const next = new QuestionNotifications(vi.fn(), vi.fn());
    const enabling = next.enable();
    next.dispose();
    resolve("granted");
    await enabling;
    expect(b.values.get(QUESTION_NOTIFICATION_SETTING)).toBeUndefined();
  });

  it("bounds deduplication history and survives invalid stored data", async () => {
    const b = browser();
    b.values.set("exec-mcp:question-notifications:seen", "{broken");
    for (let i = 0; i < 300; i++) await b.notifier.receive(event(`ask_${i}`));
    const saved = JSON.parse(
      b.values.get("exec-mcp:question-notifications:seen")!,
    );
    expect(saved).toHaveLength(256);
    expect(b.shown.filter((n) => !n.close.mock.calls.length)).toHaveLength(32);
    expect(JSON.stringify(saved)).not.toContain(event().sessionId);
    b.notifier.dispose();
    expect(b.shown.every((n) => n.close.mock.calls.length)).toBe(true);
  });

  it("reports a rejected permission request and allows a user-triggered retry", async () => {
    const b = browser("default");
    b.FakeNotification.requestPermission.mockRejectedValueOnce(
      new Error("denied by policy"),
    );
    await b.notifier.enable();
    expect(b.notifier.state).toBe("error");
    await b.notifier.enable();
    expect(b.notifier.state).toBe("enabled");
  });
});

it("emits request metadata only after a new question is stored, never for creation retries or answers", () => {
  const notes = new SessionNotes();
  const events: SessionNotesEvent[] = [];
  const storedCounts: number[] = [];
  notes.openWeb((event) => {
    events.push(event);
    if (event.questionRequest)
      storedCounts.push(notes.questions(event.sessionId).total);
  });
  notes.openWeb(() => {
    throw new Error("observer failed");
  });
  const args = {
    request_key: "dedupe",
    questions: [
      {
        title: "PRIVATE_QUESTION",
        options: ["PRIVATE_OPTION_A", "PRIVATE_OPTION_B"],
      },
    ],
  };
  const accepted = notes.ask("hash", args);
  expect(notes.ask("hash", args)).toEqual(accepted);
  expect(storedCounts).toEqual([1]);
  expect(events).toEqual([
    {
      type: "session:notes",
      sessionId: "hash",
      questionRequest: { id: accepted.request_id, count: 1 },
    },
  ]);
  const q = notes.questions("hash").items[0]!;
  notes.answer("hash", q.id, {
    id: "answer",
    option_index: 0,
    note: "PRIVATE_ANSWER",
  });
  notes.rename("hash", "PRIVATE_LABEL");
  notes.enqueue("hash", "supplement", "PRIVATE_NOTE");
  expect(events.filter((event) => event.questionRequest)).toHaveLength(1);
  expect(JSON.stringify(events)).not.toContain("PRIVATE_");
});

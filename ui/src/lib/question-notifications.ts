import type { SessionNotesEvent } from "../../../src/session-notes-types.js";
import { createTranslator, type Translate } from "./locale.js";

export const QUESTION_NOTIFICATION_SETTING = "exec-mcp:question-notifications";
const HISTORY_KEY = "exec-mcp:question-notifications:seen";
const HISTORY_LIMIT = 256;
const HISTORY_MS = 72 * 60 * 60 * 1000;
export type QuestionNotificationState =
  | "unsupported"
  | "insecure"
  | "default"
  | "denied"
  | "enabled"
  | "paused"
  | "error";

/** Page-bound notification delivery; never polls questions or alters their answers. */
export class QuestionNotifications {
  private paused = false;
  private failed = false;
  private closed = false;
  private storageUnavailable = false;
  private seen = new Map<string, number>();
  private active = new Set<Notification>();

  constructor(
    private readonly openSession: (id: string) => void,
    private readonly changed: () => void,
    private readonly t: Translate = createTranslator("zh-CN"),
  ) {
    this.refresh();
  }

  get state(): QuestionNotificationState {
    if (!window.isSecureContext) return "insecure";
    if (typeof window.Notification !== "function") return "unsupported";
    if (window.Notification.permission === "denied") return "denied";
    if (this.failed && !this.paused) return "error";
    if (window.Notification.permission !== "granted") return "default";
    return this.paused ? "paused" : "enabled";
  }

  refresh(): void {
    if (!this.storageUnavailable)
      try {
        this.paused =
          window.localStorage.getItem(QUESTION_NOTIFICATION_SETTING) === "off";
      } catch {
        this.storageUnavailable = true;
      }
    if (this.state !== "enabled") this.closeNotifications();
    if (!this.closed) this.changed();
  }

  async enable(): Promise<void> {
    if (
      this.closed ||
      ["insecure", "unsupported", "denied"].includes(this.state)
    )
      return;
    this.failed = false;
    try {
      // Called directly by the user's click, before any other asynchronous work.
      const permission =
        window.Notification.permission === "granted"
          ? "granted"
          : await window.Notification.requestPermission();
      if (this.closed) return;
      if (permission === "granted") this.setPaused(false);
    } catch {
      this.failed = true;
    }
    if (!this.closed) this.changed();
  }

  pause(): void {
    this.setPaused(true);
    this.closeNotifications();
    this.changed();
  }

  test(): void {
    if (this.closed || this.state !== "enabled") return;
    this.show(this.t("notification.testBody"), "exec-mcp-question-test");
  }

  async receive(event: SessionNotesEvent): Promise<void> {
    const request = event.questionRequest;
    if (
      this.closed ||
      event.type !== "session:notes" ||
      !event.sessionId ||
      !request ||
      this.state !== "enabled"
    )
      return;
    const deliver = () => {
      // Permissions/preferences may have changed while another tab held the lock.
      this.refresh();
      if (this.closed || this.state !== "enabled") return;
      this.loadHistory();
      if (this.seen.has(request.id)) return;
      const shortId = `${event.sessionId.slice(0, 8)}…${event.sessionId.slice(-4)}`;
      if (
        !this.show(
          this.t("notification.newQuestions", shortId, request.count),
          `exec-mcp-question-${request.id}`,
          event.sessionId,
        )
      )
        return;
      this.seen.set(request.id, Date.now());
      this.trimHistory();
      try {
        window.localStorage.setItem(
          HISTORY_KEY,
          JSON.stringify([...this.seen]),
        );
      } catch {
        /* The per-page set and browser notification tag remain as fallbacks. */
      }
    };
    try {
      // Locks + shared IDs prevent two same-origin tabs from notifying the same request.
      if (window.navigator.locks)
        await window.navigator.locks.request(HISTORY_KEY, deliver);
      else deliver();
    } catch {
      // Older/restricted browsers still support basic page notifications; tags coalesce duplicates.
      deliver();
    }
  }

  dispose(): void {
    this.closed = true;
    this.closeNotifications();
  }

  private setPaused(paused: boolean): void {
    this.paused = paused;
    if (!this.storageUnavailable)
      try {
        window.localStorage.setItem(
          QUESTION_NOTIFICATION_SETTING,
          paused ? "off" : "on",
        );
      } catch {
        this.storageUnavailable = true;
      }
  }

  private show(body: string, tag: string, sessionId?: string): boolean {
    try {
      const notification = new window.Notification(
        this.t("notification.title"),
        {
          body,
          tag,
        },
      );
      this.active.add(notification);
      if (this.active.size > 32) {
        const oldest = this.active.values().next().value!;
        this.active.delete(oldest);
        oldest.close();
      }
      notification.onclick = (event) => {
        event.preventDefault();
        notification.close();
        this.active.delete(notification);
        if (this.closed) return;
        try {
          window.focus();
        } catch {
          /* Some browsers disallow changing window focus. */
        }
        if (sessionId) this.openSession(sessionId);
      };
      notification.onclose = () => this.active.delete(notification);
      notification.onerror = () => {
        this.active.delete(notification);
        this.failed = true;
        if (!this.closed) this.changed();
      };
      return true;
    } catch {
      this.failed = true;
      if (!this.closed) this.changed();
      return false;
    }
  }

  private loadHistory(): void {
    try {
      const source = window.localStorage.getItem(HISTORY_KEY);
      if (source && source.length <= 65_536) {
        const entries: unknown = JSON.parse(source);
        if (Array.isArray(entries))
          for (const item of entries.slice(-HISTORY_LIMIT)) {
            if (
              Array.isArray(item) &&
              typeof item[0] === "string" &&
              item[0].length <= 100 &&
              typeof item[1] === "number" &&
              Number.isFinite(item[1])
            )
              this.seen.set(item[0], item[1]);
          }
      }
    } catch {
      /* A blocked or corrupt storage entry does not break the console. */
    }
    this.trimHistory();
  }

  private trimHistory(): void {
    this.seen = new Map(
      [...this.seen]
        .filter(([, at]) => at > Date.now() - HISTORY_MS)
        .sort((a, b) => a[1] - b[1])
        .slice(-HISTORY_LIMIT),
    );
  }

  private closeNotifications(): void {
    for (const notification of this.active) {
      try {
        notification.close();
      } catch {
        /* Browser already disposed it. */
      }
    }
    this.active.clear();
  }
}

import type { CodeModeSession } from "./session.js";

export const SESSION_IDLE_MS = 72 * 60 * 60 * 1_000;

export interface SessionLease {
  session: CodeModeSession;
  release(): void;
}
interface Entry {
  scope: string | undefined;
  opening: Promise<CodeModeSession>;
  session?: CodeModeSession;
  users: number;
  idleSince: number;
  closing?: Promise<void>;
}

/** 按对话复用原生 session；租约持续到 cell 结果取完，而非 HTTP 请求结束。 */
export class SessionPool {
  readonly #shared = new Map<string, Entry>();
  readonly #entries = new Set<Entry>();
  readonly #timer: NodeJS.Timeout;
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor(
    private readonly open: (
      scope: string | undefined,
    ) => Promise<CodeModeSession>,
    private readonly idleMs = SESSION_IDLE_MS,
  ) {
    if (!Number.isSafeInteger(idleMs) || idleMs <= 0)
      throw new Error("session 空闲保留时间必须是正整数毫秒。");
    this.#timer = setInterval(() => this.#sweep(), Math.min(idleMs, 60_000));
    this.#timer.unref();
  }

  async acquire(scope: string | undefined): Promise<SessionLease> {
    if (this.#closed) throw new Error("Code Mode session 池已关闭。");
    this.#sweep();
    let entry = scope === undefined ? undefined : this.#shared.get(scope);
    if (entry === undefined) {
      entry = {
        scope,
        opening: Promise.resolve().then(() => this.open(scope)),
        users: 0,
        idleSince: Date.now(),
      };
      this.#entries.add(entry);
      if (scope !== undefined) this.#shared.set(scope, entry);
    }
    const owner = entry;
    owner.users += 1;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      owner.users -= 1;
      if (owner.users === 0) {
        owner.idleSince = Date.now();
        if (owner.scope === undefined) void this.#retire(owner);
      }
    };
    try {
      const session = await owner.opening;
      owner.session = session;
      if (this.#closed || owner.closing !== undefined || !session.usable)
        throw new Error("Code Mode session 已失效；存储可能已丢失。");
      return { session, release };
    } catch (error) {
      release();
      void this.#retire(owner);
      throw error;
    }
  }

  has(session: CodeModeSession): boolean {
    return [...this.#entries].some(
      (entry) => entry.session === session && !entry.closing,
    );
  }

  invalidate(session: CodeModeSession): void {
    for (const entry of this.#entries)
      if (entry.session === session) void this.#retire(entry);
  }

  reset(): void {
    for (const entry of this.#entries) void this.#retire(entry);
  }

  close(): Promise<void> {
    this.#closed = true;
    clearInterval(this.#timer);
    this.#closePromise ??= Promise.all(
      [...this.#entries].map((entry) => this.#retire(entry)),
    ).then(() => undefined);
    return this.#closePromise;
  }

  #sweep(): void {
    const deadline = Date.now() - this.idleMs;
    for (const entry of this.#entries)
      if (entry.users === 0 && entry.idleSince <= deadline)
        void this.#retire(entry);
  }

  #retire(entry: Entry): Promise<void> {
    if (entry.scope !== undefined && this.#shared.get(entry.scope) === entry)
      this.#shared.delete(entry.scope);
    entry.closing ??= entry.opening
      .then((session) => session.close())
      .catch(() => {
        /* 原始打开/会话故障由调用方报告；仍完成本地清理。 */
      })
      .finally(() => this.#entries.delete(entry));
    return entry.closing;
  }
}

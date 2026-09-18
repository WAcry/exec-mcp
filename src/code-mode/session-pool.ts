import type { CodeModeSession } from "./session.js";

export const MAX_EXEC_CELLS = 16;
export interface SessionLease {
  session: CodeModeSession;
  release(): void;
}
interface Entry {
  opening: Promise<CodeModeSession>;
  session?: CodeModeSession;
  closing?: Promise<void>;
}

/** Each user cell owns one short-lived native session; conversation data lives in the bounded cache. */
export class SessionPool {
  readonly #entries = new Set<Entry>();
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor(
    private readonly open: (
      scope: string | undefined,
    ) => Promise<CodeModeSession>,
    private readonly maximum = MAX_EXEC_CELLS,
  ) {
    if (!Number.isSafeInteger(maximum) || maximum < 1)
      throw new Error("活动 cell 上限必须是正安全整数。");
  }

  get size(): number {
    return this.#entries.size;
  }

  async acquire(scope: string | undefined): Promise<SessionLease> {
    if (this.#closed) throw new Error("Code Mode session 池已关闭。");
    if (this.#entries.size >= this.maximum)
      throw new Error(
        `已有 ${this.maximum} 个运行中、待取结果或清理中的 cell；请先 wait/终止已有 cell，未执行新脚本。`,
      );
    const owner: Entry = {
      opening: Promise.resolve().then(() => this.open(scope)),
    };
    this.#entries.add(owner);
    try {
      const session = await owner.opening;
      owner.session = session;
      if (this.#closed || owner.closing || !session.usable)
        throw new Error("Code Mode session 已失效。");
      return {
        session,
        release: () => {
          void this.#retire(owner);
        },
      };
    } catch (error) {
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
    this.#closePromise ??= Promise.all(
      [...this.#entries].map((entry) => this.#retire(entry)),
    ).then(() => undefined);
    return this.#closePromise;
  }
  #retire(entry: Entry): Promise<void> {
    entry.closing ??= entry.opening
      .then((session) => session.close())
      .catch(() => {
        /* Callers already receive the original open/transport error. */
      })
      .finally(() => this.#entries.delete(entry));
    return entry.closing;
  }
}

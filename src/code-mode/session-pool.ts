import type { CodeModeSession } from "./session.js";
import { DEFAULT_IDLE_MS } from "../memory.js";

export const SESSION_IDLE_MS = DEFAULT_IDLE_MS;
export const MEMORY_RECLAIMED_TEXT =
  "旧 Code Mode session 因内存压力已回收，旧 cell 和 store 不再可用；同一 ChatGPT 对话可用新的 exec 创建干净会话。工具副作用不会回滚，勿自动重跑旧命令。";
export type RetirementReason =
  | "memory"
  | "idle"
  | "failure"
  | "shutdown"
  | "unscoped";

export interface SessionLease {
  session: CodeModeSession;
  release(): void;
  assertActive(): void;
  touch(): void;
  readonly reclaimed: boolean;
  readonly newSession: boolean;
}
interface Entry {
  scope: string | undefined;
  opening: Promise<CodeModeSession>;
  session?: CodeModeSession;
  users: number;
  idleSince: number;
  lastUsed: number;
  generation: number;
  announced: boolean;
  retired?: RetirementReason;
  closing?: Promise<void>;
}

/** 按对话复用原生 session；租约持续到 cell 结果取完，而非 HTTP 请求结束。 */
export class SessionPool {
  readonly #shared = new Map<string, Entry>();
  readonly #entries = new Set<Entry>();
  readonly #timer: NodeJS.Timeout;
  #closed = false;
  #generation = 0;
  #closePromise: Promise<void> | undefined;

  constructor(
    private readonly open: (
      scope: string | undefined,
    ) => Promise<CodeModeSession>,
    private readonly idleMs = SESSION_IDLE_MS,
    private readonly onRetire?: (
      session: CodeModeSession,
      reason: RetirementReason,
    ) => void,
  ) {
    if (!Number.isSafeInteger(idleMs) || idleMs <= 0)
      throw new Error("session 空闲保留时间必须是正整数毫秒。");
    this.#timer = setInterval(() => this.#sweep(), Math.min(idleMs, 60_000));
    this.#timer.unref();
  }

  get generation(): number {
    return this.#generation;
  }
  get size(): number {
    return [...this.#entries].filter((entry) => !entry.retired).length;
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
        lastUsed: Date.now(),
        generation: ++this.#generation,
        announced: false,
      };
      this.#entries.add(entry);
      if (scope !== undefined) this.#shared.set(scope, entry);
    }
    const owner = entry;
    owner.users += 1;
    owner.lastUsed = Date.now();
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      owner.users -= 1;
      if (owner.users === 0) {
        owner.idleSince = Date.now();
        if (owner.scope === undefined) void this.#retire(owner, "unscoped");
      }
    };
    try {
      const session = await owner.opening;
      owner.session = session;
      const assertActive = () => {
        if (owner.retired === "memory") throw new Error(MEMORY_RECLAIMED_TEXT);
        if (this.#closed || owner.retired || !session.usable)
          throw new Error(
            "Code Mode session 已失效；存储可能已丢失，同一对话可重新 exec。",
          );
      };
      assertActive();
      const newSession = !owner.announced;
      owner.announced = true;
      return {
        session,
        release,
        assertActive,
        newSession,
        touch: () => {
          assertActive();
          owner.lastUsed = Date.now();
        },
        get reclaimed() {
          return owner.retired === "memory";
        },
      };
    } catch (error) {
      release();
      void this.#retire(owner, "failure");
      throw owner.retired === "memory"
        ? new Error(MEMORY_RECLAIMED_TEXT)
        : error;
    }
  }

  has(session: CodeModeSession): boolean {
    return [...this.#entries].some(
      (entry) => entry.session === session && !entry.retired,
    );
  }

  invalidate(session: CodeModeSession): void {
    for (const entry of this.#entries)
      if (entry.session === session) void this.#retire(entry, "failure");
  }

  reset(reason: RetirementReason = "failure"): void {
    for (const entry of this.#entries) void this.#retire(entry, reason);
  }

  /** Detach synchronously, then close just this generation. New acquisitions never
   * wait on, resurrect or get removed by an old generation's asynchronous cleanup.
   */
  reclaimOldest(
    idleOnly: boolean,
    throughGeneration = this.#generation,
  ): Promise<void> | undefined {
    const candidates = [...this.#entries].filter(
      (entry) =>
        !entry.retired &&
        entry.generation <= throughGeneration &&
        (!idleOnly || entry.users === 0),
    );
    candidates.sort(
      (a, b) =>
        (idleOnly ? a.idleSince - b.idleSince : a.lastUsed - b.lastUsed) ||
        a.generation - b.generation,
    );
    const owner = candidates[0];
    return owner ? this.#retire(owner, "memory") : undefined;
  }

  close(): Promise<void> {
    this.#closed = true;
    clearInterval(this.#timer);
    this.#closePromise ??= Promise.all(
      [...this.#entries].map((entry) => this.#retire(entry, "shutdown")),
    ).then(() => undefined);
    return this.#closePromise;
  }

  #sweep(): void {
    const deadline = Date.now() - this.idleMs;
    for (const entry of this.#entries)
      if (entry.users === 0 && entry.idleSince <= deadline)
        void this.#retire(entry, "idle");
  }

  #retire(entry: Entry, reason: RetirementReason): Promise<void> {
    if (entry.retired) return entry.closing ?? Promise.resolve();
    entry.retired = reason;
    if (entry.scope !== undefined && this.#shared.get(entry.scope) === entry)
      this.#shared.delete(entry.scope);
    entry.closing = entry.opening
      .then((session) => session.close())
      .catch(() => {
        /* 原始打开/会话故障由调用方报告；仍完成本地清理。 */
      })
      .finally(() => this.#entries.delete(entry));
    // Callback identity is the native session object, never the stable metadata scope.
    if (entry.session) this.onRetire?.(entry.session, reason);
    return entry.closing;
  }
}

import type { CodeModeSession } from "./session.js";
import { DEFAULT_IDLE_MS } from "../memory.js";

export const SESSION_IDLE_MS = DEFAULT_IDLE_MS;
export const MEMORY_RECLAIMED_TEXT =
  "The previous Code Mode session was reclaimed because of memory pressure. Its cells and stored values are gone. A new exec in this conversation starts a clean session. Tool side effects are not rolled back; do not rerun old commands automatically.";
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

/** Reuses one native session per conversation. A lease lasts until the cell result is collected, not until the HTTP request ends. */
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
      throw new Error(
        "The session idle retention must be a positive integer number of milliseconds.",
      );
    this.#timer = setInterval(() => this.#sweep(), Math.min(idleMs, 60_000));
    this.#timer.unref();
  }

  get generation(): number {
    return this.#generation;
  }
  get size(): number {
    return [...this.#entries].filter((entry) => !entry.retired).length;
  }
  get retentionIdleMs(): number {
    return this.idleMs;
  }

  getNativeSessions(): Array<{
    id: string;
    scope?: string | undefined;
    users: number;
    idleSince: number;
    lastUsed: number;
    generation: number;
    activeCellCount: number;
    activeCellIds: string[];
    retired?: RetirementReason | undefined;
    isOldestIdle: boolean;
    isOldestActive: boolean;
  }> {
    const activeEntries = [...this.#entries].filter((e) => !e.retired);
    const idleEntries = activeEntries
      .filter((e) => e.users === 0)
      .sort((a, b) => a.idleSince - b.idleSince);
    const busyEntries = activeEntries
      .filter((e) => e.users > 0)
      .sort((a, b) => a.lastUsed - b.lastUsed);

    const oldestIdle = idleEntries[0];
    const oldestBusy = busyEntries[0];

    return [...this.#entries].map((entry) => ({
      id: entry.session?.id ?? `session-gen-${entry.generation}`,
      scope: entry.scope,
      users: entry.users,
      idleSince: entry.idleSince,
      lastUsed: entry.lastUsed,
      generation: entry.generation,
      activeCellCount: entry.session?.activeCellCount ?? 0,
      activeCellIds: entry.session?.activeCellIds ?? [],
      retired: entry.retired,
      isOldestIdle: entry === oldestIdle,
      isOldestActive: entry === oldestBusy,
    }));
  }

  async acquire(scope: string | undefined): Promise<SessionLease> {
    if (this.#closed) throw new Error("The Code Mode session pool is closed.");
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
            "The Code Mode session is no longer usable, and its stored values may be lost. Run exec again in this conversation to start a new session.",
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
        /* The caller reports the open or session failure; local cleanup still finishes. */
      })
      .finally(() => this.#entries.delete(entry));
    // Callback identity is the native session object, never the stable metadata scope.
    if (entry.session) this.onRetire?.(entry.session, reason);
    return entry.closing;
  }
}

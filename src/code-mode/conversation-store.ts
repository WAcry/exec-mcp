import { Buffer } from "node:buffer";
import { performance } from "node:perf_hooks";

export const STORE_IDLE_MS = 72 * 60 * 60 * 1000;
export const STORE_SESSION_BYTES = 32 * 1024 * 1024;
export const STORE_TOTAL_BYTES = 256 * 1024 * 1024;
export const STORE_MAX_KEYS = 4096;
export const STORE_MAX_CONVERSATIONS = 128;
export const STORE_ENTRY_OVERHEAD = 128;

export interface StoreLimits {
  idleMs: number;
  sessionBytes: number;
  totalBytes: number;
  maxKeys: number;
  maxConversations: number;
}
export const DEFAULT_STORE_LIMITS: StoreLimits = {
  idleMs: STORE_IDLE_MS,
  sessionBytes: STORE_SESSION_BYTES,
  totalBytes: STORE_TOTAL_BYTES,
  maxKeys: STORE_MAX_KEYS,
  maxConversations: STORE_MAX_CONVERSATIONS,
};
export type StoreWrite = [key: string, json: string | null];
interface Entry {
  values: Map<string, string>;
  bytes: number;
  pins: number;
  touched: number;
}
export interface StoreLease {
  snapshot: [string, string][];
  commit(writes: readonly StoreWrite[]): void;
  release(): void;
}

/** Account serialized strings and key overhead, not unbounded retained JS object graphs. */
export function storeEntryBytes(key: string, json: string | null): number {
  return Buffer.byteLength(JSON.stringify([key, json])) + STORE_ENTRY_OVERHEAD;
}

/** A bounded, conversation-scoped cache. Active snapshots pin their conversation. */
export class ConversationStore {
  readonly limits: StoreLimits;
  readonly #entries = new Map<string, Entry>();
  readonly #timer: NodeJS.Timeout;
  #bytes = 0;
  #evictions = 0;
  #closed = false;

  constructor(
    options: Partial<StoreLimits> = {},
    private readonly now = () => performance.now(),
  ) {
    this.limits = { ...DEFAULT_STORE_LIMITS, ...options };
    for (const [name, value] of Object.entries(this.limits)) {
      if (!Number.isSafeInteger(value) || value <= 0)
        throw new Error(`store ${name} 必须是正安全整数。`);
    }
    if (this.limits.sessionBytes > this.limits.totalBytes)
      throw new Error("单对话 store 配额不能超过总配额。");
    this.#timer = setInterval(
      () => this.sweep(),
      Math.min(this.limits.idleMs, 60_000),
    );
    this.#timer.unref();
  }

  get usage() {
    return {
      conversations: this.#entries.size,
      bytes: this.#bytes,
      keys: [...this.#entries.values()].reduce(
        (sum, entry) => sum + entry.values.size,
        0,
      ),
      pinned_conversations: [...this.#entries.values()].filter(
        (entry) => entry.pins > 0,
      ).length,
      pressure_evictions: this.#evictions,
      max_bytes: this.limits.totalBytes,
      max_session_bytes: this.limits.sessionBytes,
      idle_ms: this.limits.idleMs,
    };
  }

  begin(scope: string): StoreLease {
    if (this.#closed) throw new Error("store 缓存已关闭。");
    this.sweep();
    let entry = this.#entries.get(scope);
    if (!entry) {
      this.#makeRoom(undefined, 0, 1);
      entry = { values: new Map(), bytes: 0, pins: 0, touched: this.now() };
      this.#entries.set(scope, entry);
    }
    const owner = entry;
    owner.pins++;
    owner.touched = this.now();
    let released = false;
    return {
      snapshot: [...owner.values],
      commit: (writes) => {
        if (released || this.#closed || this.#entries.get(scope) !== owner)
          throw new Error("store 提交所属会话已失效；未改写已有缓存。");
        if (!writes.length) return;
        const next = new Map(owner.values);
        let journalBytes = 0;
        const seen = new Set<string>();
        if (writes.length > this.limits.maxKeys * 2)
          throw new Error("store 写入键数超限。");
        for (const pair of writes) {
          if (
            !Array.isArray(pair) ||
            pair.length !== 2 ||
            typeof pair[0] !== "string" ||
            (pair[1] !== null && typeof pair[1] !== "string")
          )
            throw new Error("store 写入记录无效。");
          const [key, json] = pair;
          if (seen.has(key)) throw new Error("store 写入记录含重复键。");
          seen.add(key);
          journalBytes += storeEntryBytes(key, json);
          // Tombstones can be slightly larger than a stored small scalar. Keep
          // deleting possible even when the live cache is exactly at capacity.
          if (journalBytes > this.limits.sessionBytes + this.limits.maxKeys * 4)
            throw new Error("store 本次写入记录超限。");
          if (json === null) next.delete(key);
          else {
            JSON.parse(json);
            next.set(key, json);
          }
        }
        let bytes = 0;
        for (const [key, json] of next) bytes += storeEntryBytes(key, json);
        if (next.size > this.limits.maxKeys || bytes > this.limits.sessionBytes)
          throw new Error(
            "store 单对话配额已满（含并发合并）；已有缓存保留，请删除不用的键或将大数据保存为文件。",
          );
        this.#makeRoom(owner, bytes - owner.bytes, 0);
        this.#bytes += bytes - owner.bytes;
        owner.values = next;
        owner.bytes = bytes;
        owner.touched = this.now();
      },
      release: () => {
        if (released) return;
        released = true;
        owner.pins--;
        owner.touched = this.now();
        if (
          !owner.pins &&
          !owner.values.size &&
          this.#entries.get(scope) === owner
        )
          this.#entries.delete(scope);
      },
    };
  }

  sweep(): void {
    const deadline = this.now() - this.limits.idleMs;
    for (const [scope, entry] of this.#entries)
      if (!entry.pins && entry.touched <= deadline) this.#remove(scope, entry);
  }

  close(): void {
    this.#closed = true;
    clearInterval(this.#timer);
    this.#entries.clear();
    this.#bytes = 0;
  }

  #makeRoom(
    exclude: Entry | undefined,
    extraBytes: number,
    extraEntries: number,
  ): void {
    if (
      this.#bytes + extraBytes <= this.limits.totalBytes &&
      this.#entries.size + extraEntries <= this.limits.maxConversations
    )
      return;
    const candidates = [...this.#entries]
      .filter(([, entry]) => entry !== exclude && !entry.pins)
      .sort((a, b) => a[1].touched - b[1].touched);
    let bytes = this.#bytes,
      count = this.#entries.size;
    const victims: typeof candidates = [];
    for (const candidate of candidates) {
      if (
        bytes + extraBytes <= this.limits.totalBytes &&
        count + extraEntries <= this.limits.maxConversations
      )
        break;
      victims.push(candidate);
      bytes -= candidate[1].bytes;
      count--;
    }
    if (
      bytes + extraBytes > this.limits.totalBytes ||
      count + extraEntries > this.limits.maxConversations
    )
      throw new Error(
        "store 总配额已满且可回收的空闲缓存不足；未删除活动对话，请先完成/终止已有 cell 或释放缓存。",
      );
    for (const [scope, entry] of victims) {
      this.#remove(scope, entry);
      this.#evictions = Math.min(Number.MAX_SAFE_INTEGER, this.#evictions + 1);
    }
  }

  #remove(scope: string, entry: Entry): void {
    this.#entries.delete(scope);
    this.#bytes -= entry.bytes;
  }
}

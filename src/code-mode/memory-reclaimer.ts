import type { HostIdentity } from "./host-process.js";
import type { MemoryReader } from "../host/process-memory.js";

/** What the reclaimer needs from the host process. */
export interface ReclaimableHost {
  readonly identity: HostIdentity | undefined;
  stop(): Promise<void>;
}

/** What the reclaimer needs from the session pool. */
export interface ReclaimablePool {
  readonly generation: number;
  readonly size: number;
  reclaimOldest(
    idleOnly: boolean,
    throughGeneration?: number,
  ): Promise<void> | undefined;
}

export interface MemoryStatus {
  highWaterBytes: number;
  highWaterMib: number;
  rssBytes?: number | undefined;
  sampledAt?: string | undefined;
  status: "normal" | "elevated" | "exceeded" | "unsampled";
  hostPid?: number | undefined;
}

/**
 * Samples the owned host's memory and reclaims native sessions above the
 * high-water mark: idle sessions first (FIFO), then the least recently used
 * active session, down to 75%. A pass only considers generations that existed
 * when it started. If memory stays high with nothing left to reclaim, or a
 * close does not finish, the shared host is replaced.
 */
export class MemoryReclaimer {
  readonly #closeTimeoutMs: number;
  readonly #highWaterBytes: number;
  readonly #host: ReclaimableHost;
  readonly #invalidateAll: () => void;
  readonly #onError: (error: Error) => void;
  readonly #pool: ReclaimablePool;
  readonly #reader: MemoryReader;
  readonly #timer: NodeJS.Timeout;
  #check: Promise<void> | undefined;
  #errorReported = false;
  #restarting: Promise<void> | undefined;
  #stopped = false;

  constructor(options: {
    closeTimeoutMs: number;
    highWaterBytes: number;
    host: ReclaimableHost;
    intervalMs: number;
    /** Retires every native session and its cells before the host stops. */
    invalidateAll: () => void;
    onError: (error: Error) => void;
    pool: ReclaimablePool;
    reader: MemoryReader;
    /** Runs on every timer tick before sampling. */
    onTick?: () => void;
  }) {
    this.#closeTimeoutMs = options.closeTimeoutMs;
    this.#highWaterBytes = options.highWaterBytes;
    this.#host = options.host;
    this.#invalidateAll = options.invalidateAll;
    this.#onError = options.onError;
    this.#pool = options.pool;
    this.#reader = options.reader;
    const onTick = options.onTick;
    this.#timer = setInterval(() => {
      onTick?.();
      void this.check();
    }, options.intervalMs);
    this.#timer.unref();
  }

  get highWaterBytes(): number {
    return this.#highWaterBytes;
  }

  /** A pending host replacement. New execs wait for it. */
  get restarting(): Promise<void> | undefined {
    return this.#restarting;
  }

  async status(): Promise<MemoryStatus> {
    const host = this.#host.identity;
    const highWaterBytes = this.#highWaterBytes;
    const highWaterMib = Math.round(highWaterBytes / (1024 * 1024));
    if (!host) return { highWaterBytes, highWaterMib, status: "unsampled" };
    try {
      const bytes = await this.#read(host);
      const lowWater = highWaterBytes * 0.75;
      let status: "normal" | "elevated" | "exceeded" = "normal";
      if (bytes > highWaterBytes) {
        status = "exceeded";
      } else if (bytes > lowWater) {
        status = "elevated";
      }
      return {
        highWaterBytes,
        highWaterMib,
        rssBytes: bytes,
        sampledAt: new Date().toISOString(),
        status,
        hostPid: host.pid,
      };
    } catch {
      return {
        highWaterBytes,
        highWaterMib,
        status: "unsampled",
        hostPid: host.pid,
      };
    }
  }

  /** Runs one pass, or joins the pass already running. */
  check(): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    this.#check ??= this.#run()
      .catch((error) => {
        if (!this.#errorReported) {
          this.#errorReported = true;
          this.#report(
            error instanceof Error
              ? error
              : new Error("Code Mode 内存检查失败。"),
          );
        }
      })
      .finally(() => {
        this.#check = undefined;
      });
    return this.#check;
  }

  /** Stops the timer and waits for a running pass and host replacement. */
  async stop(): Promise<void> {
    this.#stopped = true;
    clearInterval(this.#timer);
    await this.#check;
    await this.#restarting?.catch(() => undefined);
  }

  async #run(): Promise<void> {
    if (this.#restarting) return;
    const host = this.#host.identity;
    if (!host) return;
    const generations = this.#pool.generation;
    const current = () => !this.#stopped && this.#host.identity === host;
    let bytes = await this.#read(host);
    if (!current()) return;
    this.#errorReported = false;
    if (bytes <= this.#highWaterBytes) return;

    // Only this pass's old generations are candidates. A same-scope replacement
    // created while an old session closes cannot become its next victim.
    const lowWater = this.#highWaterBytes * 0.75;
    while (current() && bytes > lowWater) {
      let closing = this.#pool.reclaimOldest(true, generations);
      if (!closing) {
        // Below high water, never sacrifice an active session just to reach 75%.
        if (bytes <= this.#highWaterBytes) return;
        closing = this.#pool.reclaimOldest(false, generations);
      }
      if (!closing) {
        // Empty but resident allocator state can be released by replacing the host.
        // Live replacement generations are deliberately left to the next sample.
        if (this.#pool.size === 0 && current()) await this.#restartHost(host);
        return;
      }
      let timeout: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          closing,
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(
              () => reject(new Error("Code Mode 会话关闭超时。")),
              this.#closeTimeoutMs,
            );
            timeout.unref();
          }),
        ]);
      } catch {
        // Native memory may already be freed while a cancelled external tool is
        // still unwinding. Don't reset healthy siblings just for slow cleanup.
        if (current()) {
          const remaining = await this.#read(host);
          if (current() && remaining > this.#highWaterBytes)
            await this.#restartHost(host);
        }
        return;
      } finally {
        if (timeout) clearTimeout(timeout);
      }
      if (!current()) return;
      // Allow completed native cleanup to reach the OS before choosing another victim.
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (!current()) return;
      bytes = await this.#read(host);
    }
  }

  async #read(host: HostIdentity): Promise<number> {
    const bytes = await this.#reader(host.pid);
    if (!Number.isSafeInteger(bytes) || bytes <= 0)
      throw new Error("Code Mode 内存采样无效；不据此回收会话。");
    return bytes;
  }

  #restartHost(host: HostIdentity): Promise<void> {
    if (this.#restarting) return this.#restarting;
    if (this.#stopped || this.#host.identity !== host) return Promise.resolve();
    this.#restarting = (async () => {
      this.#invalidateAll();
      await this.#host.stop();
      // The next exec lazily opens a new host. Stable metadata scopes are untouched.
    })().finally(() => {
      this.#restarting = undefined;
    });
    return this.#restarting;
  }

  #report(error: Error): void {
    try {
      this.#onError(error);
    } catch {
      /* Observability is not execution control. */
    }
  }
}

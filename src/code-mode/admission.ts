import type { CodeModeToolName } from "./types.js";

export const NESTED_TOOL_ADMISSION_BUDGET_BYTES = 1024 * 1024 * 1024;
export const LARGE_NESTED_TOOL_RESERVATION_BYTES = 192 * 1024 * 1024;
export const DEFAULT_NESTED_TOOL_RESERVATION_BYTES = 16 * 1024 * 1024;

interface Waiter {
  onAbort: () => void;
  reject: (error: Error) => void;
  resolve: (release: () => void) => void;
  signal: AbortSignal;
  weight: number;
}

/**
 * Applies a byte-weighted global budget without rejecting temporary fan-out.
 * Reservations remain held until the nested call and its result bridge finish.
 */
export class WeightedAdmissionQueue {
  readonly #budgetBytes: number;
  #closed = false;
  #queued: Waiter[] = [];
  #usedBytes = 0;

  public constructor(budgetBytes = NESTED_TOOL_ADMISSION_BUDGET_BYTES) {
    assertPositiveSafeInteger(budgetBytes, "budgetBytes");
    this.#budgetBytes = budgetBytes;
  }

  public get queuedCount(): number {
    return this.#queued.length;
  }

  public get usedBytes(): number {
    return this.#usedBytes;
  }

  public acquire(weight: number, signal: AbortSignal): Promise<() => void> {
    assertPositiveSafeInteger(weight, "weight");
    if (weight > this.#budgetBytes) {
      throw new Error(
        "nested tool reservation exceeds the global admission budget",
      );
    }
    if (this.#closed)
      return Promise.reject(abortError("Code Mode admission queue is closed"));
    if (signal.aborted)
      return Promise.reject(abortError("Nested tool call was aborted"));

    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        onAbort: () => {
          const index = this.#queued.indexOf(waiter);
          if (index < 0) return;
          this.#queued.splice(index, 1);
          signal.removeEventListener("abort", waiter.onAbort);
          reject(abortError("Nested tool call was aborted"));
          this.#drain();
        },
        reject,
        resolve,
        signal,
        weight,
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      this.#queued.push(waiter);
      this.#drain();
    });
  }

  public close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const queued = this.#queued;
    this.#queued = [];
    for (const waiter of queued) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.reject(abortError("Code Mode admission queue is closed"));
    }
  }

  #drain(): void {
    while (!this.#closed && this.#queued.length > 0) {
      const waiter = this.#queued[0]!;
      if (this.#usedBytes + waiter.weight > this.#budgetBytes) return;
      this.#queued.shift();
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      this.#usedBytes += waiter.weight;
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        this.#usedBytes -= waiter.weight;
        this.#drain();
      });
    }
  }
}

/** Serializes result encoding while allowing cancelled waiters to leave the FIFO. */
export class CancellableMutex {
  readonly #queue = new WeightedAdmissionQueue(1);

  public async run<T>(
    signal: AbortSignal,
    operation: () => Promise<T>,
  ): Promise<T> {
    const release = await this.#queue.acquire(1, signal);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  public close(): void {
    this.#queue.close();
  }
}

export function nestedToolReservationBytes(toolName: CodeModeToolName): number {
  if (
    toolName.namespace !== undefined ||
    toolName.name.startsWith("mcp") ||
    toolName.name === "view_image" ||
    toolName.name === "list_mcp_resources" ||
    toolName.name === "list_mcp_resource_templates" ||
    toolName.name === "read_mcp_resource"
  )
    return LARGE_NESTED_TOOL_RESERVATION_BYTES;
  return DEFAULT_NESTED_TOOL_RESERVATION_BYTES;
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

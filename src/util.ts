import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";

export function randomHandle(prefix: string): string {
  return `${prefix}_${randomBytes(18).toString("base64url")}`;
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function resolveUserPath(value: string, base = homedir()): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\"))
    return path.resolve(homedir(), value.slice(2));
  return path.resolve(base, value);
}
export function abortError(
  message = "操作已取消；已发生的副作用不会回滚。",
): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}
export class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();
  async run<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
export async function waitUntil<T>(
  promise: Promise<T>,
  ms: number,
  signal?: AbortSignal,
): Promise<T | undefined> {
  throwIfAborted(signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve, reject) => {
        timer = setTimeout(() => resolve(undefined), ms);
        onAbort = () => reject(abortError());
        signal?.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

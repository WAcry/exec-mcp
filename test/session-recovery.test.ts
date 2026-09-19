import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SessionPool,
  MEMORY_RECLAIMED_TEXT,
  type RetirementReason,
} from "../src/code-mode/session-pool.js";
import type { CodeModeSession } from "../src/code-mode/session.js";

function gate<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fake(id: string, close = async () => {}) {
  return {
    id,
    usable: true,
    close: vi.fn(close),
  } as unknown as CodeModeSession;
}
const pools: SessionPool[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(pools.splice(0).map((pool) => pool.close()));
});
function pool(
  open: (scope: string | undefined) => Promise<CodeModeSession>,
  onRetire?: (session: CodeModeSession, reason: RetirementReason) => void,
) {
  const value = new SessionPool(open, 72 * 3_600_000, onRetire);
  pools.push(value);
  return value;
}

describe("metadata scope is stable; the native session generation is replaceable", () => {
  it("detaches an old native session before asynchronous close, and deduplicates concurrent replacements", async () => {
    const closeOld = gate();
    const old = fake("host-session-old", () => closeOld.promise);
    const fresh = fake("host-session-new");
    let opens = 0;
    const scopes: (string | undefined)[] = [];
    const value = pool(async (scope) => {
      scopes.push(scope);
      return opens++ === 0 ? old : fresh;
    });
    const a = await value.acquire("same-metadata-scope");
    a.release();
    const generation = value.generation;
    const retiring = value.reclaimOldest(true, generation)!;
    expect(value.has(old)).toBe(false);
    const [b, c] = await Promise.all([
      value.acquire("same-metadata-scope"),
      value.acquire("same-metadata-scope"),
    ]);
    expect(b.session).toBe(fresh);
    expect(c.session).toBe(fresh);
    expect(opens).toBe(2);
    expect(scopes).toEqual(["same-metadata-scope", "same-metadata-scope"]);
    expect(() => a.assertActive()).toThrow(MEMORY_RECLAIMED_TEXT);
    closeOld.resolve();
    await retiring;
    // Late releases/failures from generation A must never remove generation B.
    a.release();
    value.invalidate(old);
    expect(value.has(fresh)).toBe(true);
    expect(value.size).toBe(1);
    expect(value.reclaimOldest(false, generation)).toBeUndefined();
    b.release();
    c.release();
    const later = await value.acquire("same-metadata-scope");
    expect(later.session).toBe(fresh);
    later.release();
  });
  it("can replace an old generation while its OpenSession handshake is still pending", async () => {
    const opening = gate<CodeModeSession>();
    const closed = gate();
    const old = fake("late-open", () => closed.promise),
      fresh = fake("replacement");
    let count = 0;
    const value = pool(async () => (++count === 1 ? opening.promise : fresh));
    const first = value.acquire("same-scope"),
      second = value.acquire("same-scope");
    const firstError = expect(first).rejects.toThrow("内存压力"),
      secondError = expect(second).rejects.toThrow("内存压力");
    const retiring = value.reclaimOldest(false)!;
    const newLease = await value.acquire("same-scope");
    expect(newLease.session).toBe(fresh);
    opening.resolve(old);
    await Promise.all([firstError, secondError]);
    expect(value.has(fresh)).toBe(true);
    closed.resolve();
    await retiring;
    expect(value.has(fresh)).toBe(true);
    expect(value.size).toBe(1);
    newLease.release();
  });
  it("orders idle FIFO by last transition to idle, not creation order", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(100);
    const retired: string[] = [];
    let serial = 0;
    const value = pool(
      async () => fake(String(++serial)),
      (session) => retired.push(session.id),
    );
    const a = await value.acquire("a");
    a.release();
    vi.setSystemTime(200);
    const b = await value.acquire("b");
    b.release();
    vi.setSystemTime(300);
    const aAgain = await value.acquire("a");
    aAgain.release();
    await value.reclaimOldest(true);
    expect(retired).toEqual([b.session.id]);
    expect(value.has(a.session)).toBe(true);
    await value.reclaimOldest(true);
    expect(retired).toEqual([b.session.id, a.session.id]);
  });
  it("touches active sessions independently and never closes a sibling session when one is retired", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(100);
    const value = pool(async (scope) => fake(scope!));
    const a = await value.acquire("a");
    vi.setSystemTime(200);
    const b = await value.acquire("b");
    vi.setSystemTime(300);
    a.touch();
    expect(value.reclaimOldest(true)).toBeUndefined();
    await value.reclaimOldest(false);
    expect(value.has(a.session)).toBe(true);
    expect(value.has(b.session)).toBe(false);
    expect(() => b.touch()).toThrow("内存压力");
    a.release();
    b.release();
  });
  it("an old failed open cannot remove a successfully opened same-scope replacement", async () => {
    let reject!: (error: Error) => void;
    const bad = new Promise<CodeModeSession>((_, fail) => {
      reject = fail;
    });
    let opens = 0;
    const fresh = fake("new");
    const value = pool(async () => (++opens === 1 ? bad : fresh));
    const waiting = value.acquire("stable");
    const failed = expect(waiting).rejects.toThrow("内存压力");
    const retiring = value.reclaimOldest(false)!;
    const replacement = await value.acquire("stable");
    reject(new Error("old host failed"));
    await failed;
    await retiring;
    expect(value.has(fresh)).toBe(true);
    expect(replacement.newSession).toBe(true);
    replacement.release();
  });
  it("ordinary sibling cell releases retain the original shared session until actual retirement", async () => {
    const shared = fake("same-host-session");
    const value = pool(async () => shared);
    const first = await value.acquire("conversation"),
      second = await value.acquire("conversation");
    expect(first.newSession).toBe(true);
    expect(second.newSession).toBe(false);
    first.release();
    expect(value.reclaimOldest(true)).toBeUndefined();
    expect(value.has(shared)).toBe(true);
    second.release();
    await value.reclaimOldest(true);
    expect(shared.close).toHaveBeenCalledTimes(1);
  });
});

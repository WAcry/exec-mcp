import { describe, expect, it } from "vitest";
import { ActivityStore } from "../src/web/activity.js";
import { snapshotAuditValue, truncateAuditText } from "../src/web/snapshot.js";

describe("bounded Web activity audit", () => {
  it("keeps audit records useful without retaining arbitrarily large values", () => {
    const activity = new ActivityStore({ maxCalls: 4, maxSubcalls: 5 });
    const events: unknown[] = [];
    activity.subscribe((event) => events.push(event));
    const secretMiddle = "PRIVATE_MIDDLE_".repeat(20_000);
    const tracker = activity.startCall({
      tool: "exec",
      sessionId: "scope-digest",
      args: {
        source: `START\n${secretMiddle}\nEND`,
        workdir: "/project",
      },
    });
    for (let index = 0; index < 20; index++) {
      tracker.recordSubcall({
        name: "exec_command",
        durationMs: index,
        input: { index, command: "x".repeat(20_000) },
        output: { index, output: "y".repeat(100_000) },
        status: "success",
      });
    }
    const circular: Record<string, unknown> = { ok: true };
    circular.self = circular;
    tracker.finish({ status: "completed", output: circular });

    const call = activity.getCall(tracker.id)!;
    expect(call.args.source).toContain("START");
    expect(call.args.source).toContain("END");
    expect(call.args.source).toContain("审计记录省略");
    expect(call.args.source).not.toContain(secretMiddle);
    expect(call.subcalls).toHaveLength(5);
    expect(call.subcalls.slice(0, 1).map((item) => item.input)).toMatchObject([
      { index: 0 },
    ]);
    expect(call.subcalls.at(-1)?.input).toMatchObject({ index: 19 });
    expect(call.omittedSubcalls).toBe(15);
    expect(call.truncatedFields).toBeGreaterThan(0);
    expect(call.output).toEqual({ ok: true, self: "[Circular]" });
    expect(activity.getStats()).toMatchObject({
      totalCalls: 1,
      activeSessions: 1,
      truncatedFields: call.truncatedFields,
      omittedSubcalls: 15,
    });
    const serializedEvents = JSON.stringify(events);
    expect(serializedEvents.length).toBeLessThan(5000);
    expect(serializedEvents).not.toContain("PRIVATE_MIDDLE");
    expect(serializedEvents).not.toContain("x".repeat(100));
  });

  it("prunes session summaries together with evicted calls and ignores late finish data", () => {
    const activity = new ActivityStore({ maxCalls: 2, maxSubcalls: 2 });
    const evicted = activity.startCall({
      tool: "exec",
      sessionId: "old-session",
      args: { source: "old" },
    });
    const kept = activity.startCall({
      tool: "exec",
      sessionId: "kept-session",
      args: { source: "kept" },
    });
    kept.finish({ status: "completed" });
    const newest = activity.startCall({
      tool: "wait",
      sessionId: "kept-session",
      args: { cell_id: "cell_1" },
    });
    newest.finish({ status: "error", error: "failed" });

    expect(activity.getCall(evicted.id)).toBeUndefined();
    expect(activity.getSessions().items.map((session) => session.id)).toEqual([
      "kept-session",
    ]);
    expect(activity.getSessions().items[0]).toMatchObject({
      callCount: 2,
      errorCount: 1,
    });

    evicted.finish({
      status: "error",
      output: "late".repeat(100_000),
      error: "late error",
    });
    expect(activity.getStats()).toMatchObject({
      totalCalls: 2,
      activeSessions: 1,
      errorCalls: 1,
    });
    expect(JSON.stringify(activity.getSessions())).not.toContain("late");
  });

  it("keeps the retained session count exact when the same session rolls over", () => {
    const activity = new ActivityStore({ maxCalls: 2, maxSubcalls: 2 });
    for (let index = 0; index < 3; index++) {
      const tracker = activity.startCall({
        tool: "exec",
        sessionId: "same-session",
        args: { source: "text(" + index + ")" },
      });
      tracker.finish({ status: "completed" });
    }

    expect(activity.getCalls()).toMatchObject({ total: 2 });
    expect(activity.getSessions().items).toEqual([
      expect.objectContaining({
        id: "same-session",
        callCount: 2,
        errorCount: 0,
      }),
    ]);
  });

  it("retains ten thousand calls by default", () => {
    const activity = new ActivityStore();
    for (let index = 0; index < 10_001; index++) {
      const tracker = activity.startCall({
        tool: "exec",
        sessionId: "large-session",
        args: { source: "void 0;" },
      });
      tracker.finish({ status: "completed" });
    }

    expect(activity.getStats().totalCalls).toBe(10_000);
    expect(activity.getSessions().items[0]).toMatchObject({
      id: "large-session",
      callCount: 10_000,
    });
  });

  it("validates retention settings and clears all derived indexes", () => {
    expect(() => new ActivityStore({ maxCalls: 0 })).toThrow("maxCalls");
    expect(() => new ActivityStore({ maxSubcalls: 1 })).toThrow("maxSubcalls");
    const activity = new ActivityStore();
    const tracker = activity.startCall({
      tool: "exec",
      sessionId: "session",
      args: { source: "text(1)" },
    });
    tracker.finish({ status: "completed" });
    activity.clear();
    expect(activity.getCall(tracker.id)).toBeUndefined();
    expect(activity.getCalls()).toMatchObject({ total: 0, items: [] });
    expect(activity.getSessions()).toMatchObject({ total: 0, items: [] });
  });

  it("does not inspect or retain calls when the Web console is disabled", () => {
    let inspected = 0;
    const secret = {
      get value() {
        inspected++;
        throw new Error("must not inspect disabled audit input");
      },
    };
    const activity = new ActivityStore({ enabled: false });
    const tracker = activity.startCall({
      tool: "exec",
      sessionId: "private-session",
      args: { source: "PRIVATE_SOURCE", secret },
    });
    tracker.recordSubcall({
      name: "exec_command",
      durationMs: 1,
      input: secret,
      output: secret,
      status: "success",
    });
    tracker.finish({ status: "completed", output: secret });
    expect(inspected).toBe(0);
    expect(activity.getStats()).toMatchObject({
      totalCalls: 0,
      activeSessions: 0,
    });

    const enabled = new ActivityStore();
    enabled.startCall({
      tool: "exec",
      sessionId: "session",
      args: { source: "text(1)" },
    });
    enabled.disable();
    expect(enabled.getCalls()).toMatchObject({ total: 0, items: [] });
    expect(enabled.getSessions()).toMatchObject({ total: 0, items: [] });
  });

  it("clamps stale pagination after filters or retention shrink the result set", () => {
    const activity = new ActivityStore();
    for (let index = 0; index < 3; index++) {
      const tracker = activity.startCall({
        tool: "exec",
        sessionId: `session-${index}`,
        args: { source: `text(${index})` },
      });
      tracker.finish({ status: index === 2 ? "error" : "completed" });
    }
    expect(activity.getCalls({ page: 99, pageSize: 2 })).toMatchObject({
      page: 2,
      totalPages: 2,
      total: 3,
      items: [expect.objectContaining({ sessionId: "session-0" })],
    });
    expect(
      activity.getCalls({ page: 99, pageSize: 2, status: "error" }),
    ).toMatchObject({ page: 1, totalPages: 1, total: 1 });
    expect(activity.getSessions({ page: 99, pageSize: 2 })).toMatchObject({
      page: 2,
      totalPages: 2,
      total: 3,
    });
  });
});

describe("audit snapshot primitives", () => {
  it("preserves short values and retains both ends of long Unicode text", () => {
    expect(truncateAuditText("short", 10)).toEqual({
      value: "short",
      truncated: false,
    });
    const result = truncateAuditText(`开头${"😀".repeat(100)}结尾`, 40);
    expect(result.truncated).toBe(true);
    expect(result.value).toContain("开头");
    expect(result.value).toContain("结尾");
    expect(result.value).not.toContain("�");
    expect([...result.value]).toHaveLength(40);
    expect(truncateAuditText("abcdef", 0)).toEqual({
      value: "",
      truncated: true,
    });
    expect([
      ...truncateAuditText("😀".repeat(500_000), 100).value,
    ]).toHaveLength(100);
  });

  it("handles non-JSON values without throwing", () => {
    expect(snapshotAuditValue(42)).toEqual({ value: 42, truncated: false });
    expect(snapshotAuditValue(1n)).toEqual({ value: "1n", truncated: false });
    expect(snapshotAuditValue(undefined)).toEqual({
      value: "[undefined]",
      truncated: false,
    });
    expect(snapshotAuditValue(new Uint8Array(1024 * 1024))).toEqual({
      value: { type: "TypedArray", bytes: 1024 * 1024, length: 1024 * 1024 },
      truncated: false,
    });
    expect(snapshotAuditValue(new ArrayBuffer(1024))).toEqual({
      value: { type: "ArrayBuffer", bytes: 1024 },
      truncated: false,
    });
  });

  it("does not invoke getters or toJSON hooks while observing tool data", () => {
    let getterCalls = 0;
    const value = {
      safe: 7,
      get secret() {
        getterCalls++;
        throw new Error("getter must not run");
      },
      toJSON() {
        throw new Error("toJSON must not run");
      },
    };
    const snapshot = snapshotAuditValue(value);
    expect(getterCalls).toBe(0);
    expect(snapshot).toEqual({
      value: {
        safe: 7,
        secret: "[Accessor]",
        toJSON: "[function toJSON]",
      },
      truncated: false,
    });

    const typed = new Uint8Array(8);
    Object.defineProperties(typed, {
      constructor: {
        get() {
          getterCalls++;
          throw new Error("constructor getter must not run");
        },
      },
      byteLength: {
        get() {
          getterCalls++;
          throw new Error("byteLength getter must not run");
        },
      },
      length: {
        get() {
          getterCalls++;
          throw new Error("length getter must not run");
        },
      },
    });
    expect(snapshotAuditValue(typed)).toEqual({
      value: { type: "TypedArray", bytes: 8, length: 8 },
      truncated: false,
    });
    expect(getterCalls).toBe(0);

    const date = new Date("2026-01-02T03:04:05.000Z");
    Object.defineProperty(date, "toISOString", {
      get() {
        getterCalls++;
        throw new Error("method getter must not run");
      },
    });
    expect(snapshotAuditValue(date)).toEqual({
      value: "2026-01-02T03:04:05.000Z",
      truncated: false,
    });
    expect(getterCalls).toBe(0);
  });

  it("bounds deep and wide object graphs before JSON serialization", () => {
    const values = Array.from({ length: 10_000 }, (_, index) => ({ index }));
    const snapshot = snapshotAuditValue(values, 16 * 1024);
    expect(snapshot.truncated).toBe(true);
    expect(JSON.stringify(snapshot.value).length).toBeLessThan(16 * 1024);
    expect((snapshot.value as unknown[]).at(-1)).toBe("[9900 more items]");

    const wide = Object.fromEntries(
      Array.from({ length: 5000 }, (_, index) => [`key-${index}`, index]),
    );
    const wideSnapshot = snapshotAuditValue(wide, 16 * 1024);
    expect(wideSnapshot.truncated).toBe(true);
    expect(JSON.stringify(wideSnapshot.value)).toContain("[more keys]");

    const map = new Map(
      Array.from({ length: 10_000 }, (_, index) => [index, index]),
    );
    expect(snapshotAuditValue(map).value).toMatchObject({
      type: "Map",
      omitted: 9900,
    });
  });
});

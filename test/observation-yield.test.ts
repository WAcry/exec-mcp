import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { CodeModeHostProcess } from "../src/code-mode/host-process.js";
import { CodeModeSession } from "../src/code-mode/session.js";
import type { CodeModeToolDefinition } from "../src/code-mode/types.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture() {
  const failures: Error[] = [];
  const host = new CodeModeHostProcess({
    startupTimeoutMs: 10_000,
    onUnexpectedExit: (error) => failures.push(error),
  });
  cleanup.push(() => host.stop());
  const client = await host.start();
  const session = await CodeModeSession.open({
    client,
    startupTimeoutMs: 10_000,
    transportTimeoutMs: 5000,
    onFailure: (_session, error) => failures.push(error),
  });
  cleanup.push(() => session.close());
  const entered = gate(),
    release = gate();
  cleanup.push(async () => release.resolve());
  const calls = vi.fn(async () => {
    entered.resolve();
    await release.promise;
    return "slow result";
  });
  const tools: CodeModeToolDefinition[] = [
    { name: "gate", description: "Wait for release", call: calls },
  ];
  return { client, session, failures, entered, release, calls, tools };
}

describe("native observation yielding", () => {
  it("returns accumulated output from exec and wait without cancelling or replaying nested work", async () => {
    const f = await fixture();
    const rpc = vi.spyOn(f.client, "yieldObservation");
    const cancel = vi.spyOn(f.client, "cancelWait");
    const terminate = vi.spyOn(f.client, "terminate");
    const firstSignal = new AbortController();
    const started = f.session.execute({
      source: 'text("before");text(await tools.gate({}));text("after");',
      toolCallId: "yielded-exec",
      tools: f.tools,
      yieldTimeMs: 30_000,
      yieldSignal: firstSignal.signal,
    });
    await f.entered.promise;
    firstSignal.abort();
    const first = await started;
    expect(first).toMatchObject({
      state: "yielded",
      items: [{ type: "text", text: "before" }],
    });
    const secondSignal = new AbortController();
    const waiting = f.session.wait({
      cellId: first.cellId,
      yieldTimeMs: 110_000,
      yieldSignal: secondSignal.signal,
    });
    secondSignal.abort();
    expect(await waiting).toEqual({
      cellId: first.cellId,
      state: "yielded",
      items: [],
    });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[0]![0]).toMatchObject({
      sessionId: f.session.id,
      executionId: expect.any(String),
    });
    expect(rpc.mock.calls[1]![0]).toMatchObject({
      sessionId: f.session.id,
      waitId: expect.any(String),
    });
    expect(cancel).not.toHaveBeenCalled();
    expect(terminate).not.toHaveBeenCalled();
    f.release.resolve();
    const last = await f.session.wait({
      cellId: first.cellId,
      yieldTimeMs: 5000,
    });
    expect(last).toMatchObject({
      state: "completed",
      items: [
        { type: "text", text: "slow result" },
        { type: "text", text: "after" },
      ],
    });
    expect(f.calls).toHaveBeenCalledTimes(1);
    expect(f.failures).toEqual([]);
  });

  it("accepts an early signal before native admission and releases completed listeners", async () => {
    const f = await fixture();
    const signal = new AbortController();
    signal.abort();
    const first = await f.session.execute({
      source: "text(await tools.gate({}));",
      toolCallId: "early-signal",
      tools: f.tools,
      yieldTimeMs: 30_000,
      yieldSignal: signal.signal,
    });
    expect(first.state).toBe("yielded");
    await f.entered.promise;
    f.release.resolve();
    expect(
      (await f.session.wait({ cellId: first.cellId, yieldTimeMs: 5000 })).state,
    ).toBe("completed");
    const stale = new AbortController();
    const rpc = vi.spyOn(f.client, "yieldObservation");
    expect(
      (
        await f.session.execute({
          source: "text(42);",
          toolCallId: "complete-first",
          tools: [],
          yieldSignal: stale.signal,
        })
      ).state,
    ).toBe("completed");
    stale.abort();
    expect(rpc).not.toHaveBeenCalled();
    expect(f.calls).toHaveBeenCalledTimes(1);
  });

  it("falls back to the ordinary response when the yield RPC fails", async () => {
    const f = await fixture();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(f.client, "yieldObservation").mockImplementation(() => {
      throw new Error("test unavailable RPC");
    });
    const signal = new AbortController();
    let finished = false;
    const started = f.session
      .execute({
        source: "text(await tools.gate({}));",
        toolCallId: "fallback",
        tools: f.tools,
        yieldTimeMs: 30_000,
        yieldSignal: signal.signal,
      })
      .finally(() => {
        finished = true;
      });
    await f.entered.promise;
    signal.abort();
    await vi.waitFor(() => expect(log).toHaveBeenCalledTimes(1));
    expect(finished).toBe(false);
    f.release.resolve();
    expect(await started).toMatchObject({
      state: "completed",
      items: [{ type: "text", text: "slow result" }],
    });
    expect(f.calls).toHaveBeenCalledTimes(1);
    expect(f.failures).toEqual([]);
  });

  it("cancels a pending yield RPC when its observation finishes", async () => {
    const f = await fixture();
    const cancel = vi.fn();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const rpc = vi.spyOn(f.client, "yieldObservation").mockImplementation(() =>
      Object.assign(new EventEmitter(), {
        cancel,
        getPeer: () => "test",
        getAuthContext: () => null,
      }),
    );
    const signal = new AbortController();
    const started = f.session.execute({
      source: "text(await tools.gate({}));",
      toolCallId: "finish-before-ack",
      tools: f.tools,
      yieldSignal: signal.signal,
    });
    await f.entered.promise;
    signal.abort();
    expect(rpc).toHaveBeenCalledTimes(1);
    f.release.resolve();
    expect((await started).state).toBe("completed");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
  });

  it("keeps wait cancellation separate from preemption and retains final output", async () => {
    const f = await fixture();
    const first = await f.session.execute({
      source: "text(await tools.gate({}));",
      toolCallId: "cancel-yield-race",
      tools: f.tools,
      yieldTimeMs: 0,
    });
    await f.entered.promise;
    const cancel = new AbortController(),
      signal = new AbortController();
    const waiting = f.session.wait({
      cellId: first.cellId,
      yieldTimeMs: 110_000,
      signal: cancel.signal,
      yieldSignal: signal.signal,
    });
    const rejected = expect(waiting).rejects.toMatchObject({
      name: "AbortError",
    });
    cancel.abort();
    signal.abort();
    await rejected;
    f.release.resolve();
    expect(
      await f.session.wait({ cellId: first.cellId, yieldTimeMs: 5000 }),
    ).toMatchObject({
      state: "completed",
      items: [{ type: "text", text: "slow result" }],
    });
    expect(f.session.usable).toBe(true);
    expect(f.calls).toHaveBeenCalledTimes(1);
    expect(f.failures).toEqual([]);
  });
});

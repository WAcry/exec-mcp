import { afterEach, describe, expect, it } from "vitest";
import { CodeModeHostProcess } from "../src/code-mode/host-process.js";
import { CodeModeService } from "../src/code-mode/service.js";
import { CodeModeSession } from "../src/code-mode/session.js";
import { cellId, jsonOutput, texts } from "./helpers.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()));
});

describe("cancellation does not fail the native session", () => {
  it("keeps the session when a cell is terminated while a large result is being delivered", async () => {
    const errors: Error[] = [];
    const service = new CodeModeService({
      onError: (error) => errors.push(error),
    });
    cleanup.push(() => service.close());
    const scope = "terminate-during-completion";
    await service.exec({
      source: 'store("kept", 1);',
      tools: [],
      sessionScope: scope,
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const called = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const first = await service.exec({
      source: "text((await tools.large({})).length);",
      yieldTimeMs: 0,
      sessionScope: scope,
      tools: [
        {
          name: "large",
          description: "Returns a large string after the gate opens.",
          call: async () => {
            entered();
            await gate;
            // Large enough that the completion upload is still running when
            // the terminate request reaches the host.
            return "x".repeat(20_000_000);
          },
        },
      ],
    });
    await called;
    release();
    const terminated = await service.wait({
      cellId: cellId(first),
      terminate: true,
      sessionScope: scope,
    });
    expect(texts(terminated)[0]).toMatch(/^Script (terminated|completed)/);
    const after = await service.exec({
      source: 'text({kept: load("kept")});',
      tools: [],
      sessionScope: scope,
    });
    expect(after.isError, JSON.stringify(after)).not.toBe(true);
    expect(jsonOutput(after)).toEqual({ kept: 1 });
    expect(texts(after)[0]).not.toMatch(/new native session/i);
    expect(errors).toEqual([]);
  });

  it("returns AbortError before the cell starts, then stops the cell and keeps the session", async () => {
    const host = new CodeModeHostProcess({
      startupTimeoutMs: 10_000,
      onUnexpectedExit() {},
    });
    cleanup.push(() => host.stop());
    const client = await host.start();
    let failure: Error | undefined;
    const session = await CodeModeSession.open({
      client,
      startupTimeoutMs: 10_000,
      transportTimeoutMs: 10_000,
      onFailure: (_session, error) => {
        failure = error;
      },
    });
    cleanup.push(() => session.close());
    await session.execute({
      source: 'store("kept", 7);',
      toolCallId: "first",
      tools: [],
    });

    let calls = 0;
    const controller = new AbortController();
    const cancelled = session.execute({
      signal: controller.signal,
      source: "await tools.mark({}); await new Promise(() => {});",
      toolCallId: "cancelled",
      tools: [
        {
          name: "mark",
          description: "Counts calls.",
          call: async () => ++calls,
        },
      ],
    });
    // The request is already dispatched; the host has not reported the cell yet.
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });

    const deadline = Date.now() + 5_000;
    while (session.activeCellCount > 0 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    expect(session.activeCellCount).toBe(0);
    expect(failure).toBeUndefined();
    expect(session.usable).toBe(true);
    expect(calls).toBe(0);

    const after = await session.execute({
      source: 'text(JSON.stringify({kept: load("kept")}));',
      toolCallId: "after",
      tools: [],
    });
    expect(after).toMatchObject({
      state: "completed",
      items: [{ type: "text", text: '{"kept":7}' }],
    });
  });
});

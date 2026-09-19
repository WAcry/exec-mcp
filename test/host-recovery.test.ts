import { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodeModeHostProcess } from "../src/code-mode/host-process.js";

const hosts: CodeModeHostProcess[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(hosts.splice(0).map((host) => host.stop()));
});

describe("recoverable native host stop barrier", () => {
  it("does not leave a forever-pending stop promise when termination cannot be confirmed", async () => {
    const host = new CodeModeHostProcess({
      startupTimeoutMs: 5000,
      terminationGraceMs: 10,
      onUnexpectedExit() {},
    });
    hosts.push(host);
    await host.start();
    const old = host.identity!;
    const realKill = ChildProcess.prototype.kill;
    const blockedKill = vi
      .spyOn(ChildProcess.prototype, "kill")
      .mockImplementation(function (this: ChildProcess, signal) {
        return this.pid === old.pid ? true : realKill.call(this, signal);
      });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const stopping = host.stop();
      const rejection = expect(stopping).rejects.toThrow("终止尚未确认");
      await vi.advanceTimersByTimeAsync(3100);
      await rejection;
      expect(host.identity).toBe(old);
      expect(blockedKill).toHaveBeenCalledWith("SIGTERM");
      expect(blockedKill).toHaveBeenCalledWith("SIGKILL");
    } finally {
      vi.useRealTimers();
      blockedKill.mockRestore();
    }
    // Recovery first finishes stopping the old owned process, then creates a new one.
    const client = await host.start();
    expect(client).toBeDefined();
    expect(host.identity).not.toBe(old);
    expect(host.identity!.generation).toBeGreaterThan(old.generation);
    expect(host.identity!.pid).not.toBe(old.pid);
  });
});

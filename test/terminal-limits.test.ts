import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it } from "vitest";
import { TerminalManager } from "../src/host/terminal.js";
import { nodeCommand } from "./helpers.js";

const KiB = 1024;
const managers: TerminalManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
});
function manager(options: ConstructorParameters<typeof TerminalManager>[0]) {
  const value = new TerminalManager({ minEmptyPollMs: 50, ...options });
  managers.push(value);
  return value;
}
function session(terminal: TerminalManager, id: string) {
  return terminal["sessions"].get(id);
}
async function until(predicate: () => boolean, timeout = 5000) {
  const deadline = performance.now() + timeout;
  while (!predicate()) {
    if (performance.now() >= deadline)
      throw new Error("Fixture did not reach the expected state.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
/** Writes once, then keeps running so the output stays unread. */
async function writer(
  terminal: TerminalManager,
  character: string,
  bytes: number,
) {
  const started = await terminal.execCommand(
    {
      cmd: nodeCommand(
        `process.stdout.write(${JSON.stringify(character)}.repeat(${bytes}));setInterval(()=>{},1000);`,
      ),
      yield_time_ms: 0,
    },
    tmpdir(),
  );
  const id = started.session_id!;
  await until(
    () =>
      Buffer.byteLength(started.output) +
        session(terminal, id)!.buffer.bytes +
        session(terminal, id)!.buffer.omittedBytes >=
      bytes,
  );
  return id;
}
async function finished(terminal: TerminalManager, bytes: number) {
  const started = await terminal.execCommand(
    {
      cmd: nodeCommand(
        `process.stdout.write("e".repeat(${bytes}),()=>process.exit(0));`,
      ),
      yield_time_ms: 0,
    },
    tmpdir(),
  );
  const id = started.session_id!;
  await session(terminal, id)!.done;
  return id;
}

describe.runIf(process.platform !== "win32")("signal exit status", () => {
  it.each([false, true])(
    "reports 128 + N when a signal ends the shell (PTY=%s)",
    async (tty) => {
      const terminal = manager({});
      for (const [signal, code] of [
        ["KILL", 137],
        ["TERM", 143],
      ] as const) {
        const result = await terminal.execCommand(
          { cmd: `kill -${signal} $$`, tty, yield_time_ms: 10_000 },
          tmpdir(),
        );
        expect(result.exit_code).toBe(code);
      }
    },
  );
});

describe("terminal session limits", () => {
  it("releases finished unread sessions first, then rejects new commands while only running sessions fill the limit", async () => {
    const terminal = manager({ maxSessions: 2 });
    const done = await finished(terminal, 10);
    const running = await writer(terminal, "r", 10);
    const next = await writer(terminal, "n", 10);
    expect(session(terminal, done)).toBeUndefined();
    await expect(
      terminal.writeStdin({ session_id: done, yield_time_ms: 0 }),
    ).rejects.toThrow("terminal memory limits");
    await expect(
      terminal.execCommand(
        { cmd: nodeCommand("console.log(1)"), yield_time_ms: 0 },
        tmpdir(),
      ),
    ).rejects.toThrow(/memory\.terminal_max_sessions.*terminate=true/u);
    for (const id of [running, next])
      await terminal.writeStdin({
        session_id: id,
        terminate: true,
        yield_time_ms: 0,
      });
    const after = await terminal.execCommand(
      { cmd: nodeCommand('console.log("room")'), yield_time_ms: 10_000 },
      tmpdir(),
    );
    expect(after.output).toContain("room");
  });

  it("keeps unread output of all sessions within the shared budget", async () => {
    const terminal = manager({
      bufferBytes: 128 * KiB,
      totalBufferBytes: 160 * KiB,
    });
    const done = await finished(terminal, 60 * KiB);
    const first = await writer(terminal, "x", 110 * KiB);
    // A finished, unread session is released before running output is dropped.
    expect(session(terminal, done)).toBeUndefined();
    expect(session(terminal, first)!.buffer.omittedBytes).toBe(0);

    const second = await writer(terminal, "y", 100 * KiB);
    const retained = terminal
      .getActiveSessions()
      .reduce((total, item) => total + item.bufferBytes, 0);
    expect(retained).toBeLessThanOrEqual(160 * KiB);
    // The session that produced the new output drops its own oldest output first.
    expect(session(terminal, first)!.buffer.omittedBytes).toBe(0);
    expect(session(terminal, second)!.buffer.omittedBytes).toBeGreaterThan(0);
    await expect(
      terminal.execCommand(
        { cmd: nodeCommand("console.log(1)"), yield_time_ms: 0 },
        tmpdir(),
      ),
    ).rejects.toThrow("memory.terminal_total_buffer_mib");

    const read = await terminal.writeStdin({
      session_id: second,
      yield_time_ms: 0,
    });
    expect(read.truncated).toBe(true);
    expect(read.output).toContain("bytes omitted from the middle");
    expect(read.output.endsWith("y")).toBe(true);
  });

  it("validates the limits", () => {
    for (const options of [
      { maxSessions: 0 },
      { totalBufferBytes: 0 },
      { minEmptyPollMs: -1 },
    ])
      expect(() => new TerminalManager(options)).toThrow("not valid");
  });
});

describe("empty read window", () => {
  it("uses the configured minimum for an empty read of a running process", async () => {
    const terminal = manager({ minEmptyPollMs: 200 });
    const id = await writer(terminal, "w", 1);
    const began = performance.now();
    const result = await terminal.writeStdin({
      session_id: id,
      yield_time_ms: 1,
    });
    const elapsed = performance.now() - began;
    expect(result.session_id).toBe(id);
    expect(elapsed).toBeGreaterThanOrEqual(180);
    expect(elapsed).toBeLessThan(4000);
  });
});

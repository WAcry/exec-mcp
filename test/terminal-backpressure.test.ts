import { access, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { stripVTControlCharacters } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TerminalManager, type TerminalResult } from "../src/host/terminal.js";
import { nodeCommand, nodeFileCommand, observeTerminal } from "./helpers.js";

let root: string;
let sequence = 0;
const managers: TerminalManager[] = [];
beforeEach(async () => {
  root = await realpath(
    await mkdtemp(path.join(tmpdir(), "exec-backpressure-")),
  );
  sequence = 0;
});
afterEach(async () => {
  try {
    await Promise.all(managers.splice(0).map((manager) => manager.close()));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
function manager(bufferBytes = 4096) {
  const value = new TerminalManager({ bufferBytes });
  managers.push(value);
  return value;
}
async function until(
  predicate: () => boolean | Promise<boolean>,
  timeout = 5000,
) {
  const deadline = performance.now() + timeout;
  while (!(await predicate())) {
    if (performance.now() >= deadline)
      throw new Error("Fixture did not reach the expected state.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
async function exists(file: string) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}
function state(terminal: TerminalManager, id: string) {
  // Read-only synchronization: consuming output to wait for readiness would hide the bug.
  const session = terminal["sessions"].get(id);
  if (!session) throw new Error("Fixture session unexpectedly disappeared.");
  return session;
}
async function start(terminal: TerminalManager, tty: boolean, body: string) {
  const prefix = path.join(root, String(++sequence));
  const ready = prefix + ".ready",
    gate = prefix + ".go",
    emitted = prefix + ".emitted";
  const source = `
    const fs=require('node:fs');
    process.stdin.resume();
    const emitted=${JSON.stringify(emitted)};
    fs.writeFileSync(${JSON.stringify(ready)},'ready');
    const timer=setInterval(()=>{
      if(!fs.existsSync(${JSON.stringify(gate)}))return;
      clearInterval(timer);
      ${body}
      fs.writeFileSync(emitted,'emitted');
    },5);
  `;
  const script = prefix + ".cjs";
  await writeFile(script, source);
  const first = await terminal.execCommand(
    { cmd: nodeFileCommand(script), tty, yield_time_ms: 0 },
    root,
  );
  expect(first.session_id).toBeDefined();
  await until(() => exists(ready));
  return {
    first,
    id: first.session_id!,
    emitted,
    release: () => writeFile(gate, "go"),
  };
}
async function drain(terminal: TerminalManager, first: TerminalResult) {
  return observeTerminal(first, (input) => terminal.writeStdin(input));
}
const flood = "FLOOD_DATA_0123456789".repeat(3) + "\n";
const payload = flood.repeat(1100); // About 64 KiB; keep PTY lines shorter than its width.
function normalized(text: string) {
  return stripVTControlCharacters(text).replaceAll("\r", "");
}

describe("one terminal's backlog does not suppress another terminal's progress", () => {
  for (const floodTty of [false, true])
    for (const probeTty of [false, true]) {
      for (const existing of [false, true]) {
        it(`keeps ${existing ? "existing" : "new"} ${probeTty ? "PTY" : "pipe"} readable while ${floodTty ? "PTY" : "pipe"} is backlogged`, async () => {
          const terminal = manager();
          const progressGate = path.join(root, "probe-progress.go");
          const createProbe = () =>
            start(
              terminal,
              probeTty,
              `
          process.stdout.write("probe-ready\\n");
          const progress=setInterval(()=>{
            if(!fs.existsSync(${JSON.stringify(progressGate)}))return;
            clearInterval(progress);process.stderr.write("probe-progress\\n");
          },5);
        `,
            );
          const before = existing ? await createProbe() : undefined;
          const noisy = await start(
            terminal,
            floodTty,
            `process.stdout.write(${JSON.stringify(payload)});`,
          );
          await noisy.release();
          await until(() => state(terminal, noisy.id).buffer.bytes >= 4096);
          const probe = before ?? (await createProbe());
          await probe.release();
          await until(() => exists(probe.emitted)); // The child wrote its log even if the reader is paused.

          const result = await terminal.writeStdin({
            session_id: probe.id,
            yield_time_ms: 1000,
          });
          // Startup title output is separate from the actual fixture marker on Windows PTYs.
          const ready = await observeTerminal(
            result,
            (input) => terminal.writeStdin(input),
            (part) => part.output.includes("probe-ready"),
            1500,
          );
          expect(ready.output).toContain("probe-ready");
          expect(ready.session_id).toBe(probe.id); // The probe remains a live long-running process.
          expect(state(terminal, noisy.id).buffer.bytes).toBeGreaterThanOrEqual(
            4096,
          );
          await writeFile(progressGate, "go");
          const progress = await observeTerminal(
            await terminal.writeStdin({
              session_id: probe.id,
              yield_time_ms: 1000,
            }),
            (input) => terminal.writeStdin(input),
            (part) => part.output.includes("probe-progress"),
          );
          expect(progress.session_id).toBe(probe.id);
          expect(progress.output).not.toContain("probe-ready");
          expect(state(terminal, noisy.id).buffer.bytes).toBeGreaterThanOrEqual(
            4096,
          );

          const stopped = await terminal.writeStdin({
            session_id: noisy.id,
            terminate: true,
            yield_time_ms: 0,
          });
          await drain(terminal, stopped);
          const probeStop = await terminal.writeStdin({
            session_id: probe.id,
            terminate: true,
            yield_time_ms: 0,
          });
          await drain(terminal, probeStop);
        });
      }
    }

  it("does not impose a shared pause when each producer is individually below the buffer capacity", async () => {
    const terminal = manager();
    const first = await start(
      terminal,
      false,
      'process.stdout.write("a".repeat(3072));',
    );
    const second = await start(
      terminal,
      false,
      'process.stderr.write("b".repeat(3072));',
    );
    await first.release();
    await second.release();
    await until(
      () =>
        state(terminal, first.id).buffer.bytes === 3072 &&
        state(terminal, second.id).buffer.bytes === 3072,
    );
    for (const id of [first.id, second.id]) {
      const backend = state(terminal, id).backend;
      expect(backend.kind).toBe("pipe");
      if (backend.kind === "pipe") {
        expect(backend.process.stdout.isPaused()).toBe(false);
        expect(backend.process.stderr.isPaused()).toBe(false);
      }
    }
  });
});

describe("per-producer rolling output and cleanup", () => {
  it("retains complete UTF-8 output within its configured capacity while other sessions are left unread", async () => {
    const terminal = manager(4 * 1024 * 1024);
    const abandoned = await start(
      terminal,
      false,
      `process.stdout.write(${JSON.stringify(payload)});`,
    );
    await abandoned.release();
    await until(() => state(terminal, abandoned.id).buffer.bytes >= 4096);
    const stdout = "汉😀".repeat(350_000);
    const stderr = "ERROR_資料\n".repeat(500);
    const source =
      'process.stdout.write("汉😀".repeat(350000),()=>process.stderr.write("ERROR_資料\\n".repeat(500),()=>process.exit(0)));';
    const first = await terminal.execCommand(
      { cmd: nodeCommand(source), yield_time_ms: 0 },
      root,
    );
    const result = await drain(terminal, first);
    expect(result.exit_code).toBe(0);
    // stdout/stderr are separate channels; assert both complete sequences without imposing inter-stream order.
    expect(result.output.replace(/[^汉😀]/gu, "")).toBe(stdout);
    expect(result.output.replace(/[汉😀]/gu, "")).toBe(stderr);
    expect(Buffer.byteLength(result.output)).toBe(
      Buffer.byteLength(stdout + stderr),
    );
    expect(result.output).not.toContain("\ufffd");
    expect(state(terminal, abandoned.id).buffer.bytes).toBeGreaterThanOrEqual(
      4096,
    );
  });

  it("retains each producer's bounded unread output without pausing either one", async () => {
    const MiB = 1024 * 1024;
    const capacity = 3 * MiB;
    const terminal = manager(capacity);
    const a = await start(
      terminal,
      false,
      'process.stdout.write("a".repeat(4*1024*1024));',
    );
    const b = await start(
      terminal,
      false,
      'process.stdout.write("b".repeat(4*1024*1024));',
    );
    await a.release();
    await b.release();
    await until(
      () =>
        state(terminal, a.id).buffer.omittedBytes === MiB &&
        state(terminal, b.id).buffer.omittedBytes === MiB,
    );
    let output = "",
      omitted = 0;
    while (state(terminal, a.id).buffer.pending) {
      const part = await terminal.writeStdin({
        session_id: a.id,
        yield_time_ms: 0,
      });
      output += part.output;
      omitted += part.omitted_bytes ?? 0;
    }
    expect(omitted).toBe(MiB);
    expect(output.replace(/\n\[中间已省略[^\n]*\]\n/g, "")).toBe(
      "a".repeat(capacity),
    );
    expect(state(terminal, b.id).buffer.bytes).toBe(capacity);
    for (const id of [a.id, b.id]) {
      const backend = state(terminal, id).backend;
      if (backend.kind !== "pipe") throw new Error("expected pipe");
      expect(backend.process.stdout.isPaused()).toBe(false);
      expect(backend.process.stderr.isPaused()).toBe(false);
    }
  });

  it.each([false, true])(
    "terminates an overflowing streaming writer without blocking an unrelated session (PTY=%s)",
    async (tty) => {
      const terminal = manager();
      const writer = await start(
        terminal,
        tty,
        'function pump(){while(process.stdout.write("continuous-data\\n".repeat(256))){}process.stdout.once("drain",pump);}pump();',
      );
      await writer.release();
      await until(() => state(terminal, writer.id).buffer.bytes >= 4096);
      const stopping = terminal.writeStdin({
        session_id: writer.id,
        terminate: true,
        yield_time_ms: 0,
      });
      const healthy = await terminal.execCommand(
        {
          cmd: nodeCommand('console.log("alive-after-stop")'),
          yield_time_ms: 0,
        },
        root,
      );
      expect((await drain(terminal, healthy)).output).toBe(
        "alive-after-stop\n",
      );
      const stopped = await drain(terminal, await stopping);
      expect(stopped.session_id).toBeUndefined();
      expect(stopped.exit_code).toBeDefined();
      await expect(
        terminal.writeStdin({ session_id: writer.id, yield_time_ms: 0 }),
      ).rejects.toThrow("未知或已读完");
    },
  );

  it.each([false, true])(
    "preserves all output within a sufficient configured buffer (PTY=%s)",
    async (tty) => {
      const terminal = manager(128 * 1024);
      const finite = await start(
        terminal,
        tty,
        `process.stdout.write(${JSON.stringify(payload)},()=>process.exit(0));`,
      );
      await finite.release();
      await until(() => state(terminal, finite.id).buffer.bytes >= 4096);
      const result = await drain(terminal, finite.first);
      expect(result.exit_code).toBe(0);
      expect(normalized(result.output)).toContain(payload);
    },
  );
});

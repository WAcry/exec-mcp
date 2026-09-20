import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { STDIN_SCHEMA } from "../src/catalog.js";
import * as timing from "../src/util.js";
import { TerminalManager, type TerminalResult } from "../src/host/terminal.js";
import {
  cellId,
  connect,
  jsonOutput,
  nodeCommand,
  observeTerminal,
} from "./helpers.js";

const managers: TerminalManager[] = [];
const connections: Awaited<ReturnType<typeof connect>>[] = [];
const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(connections.splice(0).map((value) => value.close()));
  await Promise.all(managers.splice(0).map((value) => value.close()));
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function manager(bufferBytes = 4096) {
  const value = new TerminalManager({ bufferBytes });
  managers.push(value);
  return value;
}
function plain(value: string) {
  return stripVTControlCharacters(value).replaceAll("\r\n", "\n");
}
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "exec-terminal-wait-"));
  directories.push(root);
  const gate = path.join(root, "finish");
  return {
    root,
    release: () => writeFile(gate, "finish"),
    cmd: nodeCommand(`
      const fs = require('node:fs');
      console.log('READY');
      const timer = setInterval(() => {
        if (fs.existsSync(${JSON.stringify(gate)})) {
          clearInterval(timer);
          process.stdout.write('DONE\\n', () =>
            process.stderr.write('FINAL_STDERR\\n', () => process.exit(0)));
        } else console.log('progress😀');
      }, 20);
    `),
  };
}
async function start(value: TerminalManager, tty = false) {
  const f = await fixture();
  // ConPTY can emit title/cursor frames before PowerShell starts Node. Wait for
  // application progress, not arbitrary bytes, before measuring a short window.
  const first = await observeTerminal(
    await value.execCommand({ cmd: f.cmd, tty, yield_time_ms: 0 }, f.root),
    (input) => value.writeStdin(input),
    (result) => plain(result.output).includes("progress😀"),
  );
  const id = first.session_id!;
  expect(id).toBeDefined();
  const session = value["sessions"].get(id)!;
  await vi.waitFor(() => expect(session.buffer.pending).toBe(true), {
    timeout: 10_000,
    interval: 10,
  });
  return { ...f, first, id, session };
}

describe.each([false, true])("terminal wait mode (PTY=%s)", (tty) => {
  it("keeps the default output mode and ignores existing/new output in exit mode until actual completion", async () => {
    const value = manager();
    const t = await start(value, tty);
    const initial = await value.writeStdin({
      session_id: t.id,
      yield_time_ms: 110_000,
    });
    expect(initial.output.length).toBeGreaterThan(0);
    expect(initial.session_id).toBe(t.id);
    await vi.waitFor(() => expect(t.session.buffer.pending).toBe(true));
    const before = t.session.buffer.bytes;
    let settled = false;
    const waiting = value
      .writeStdin({ session_id: t.id, wait_for: "exit" })
      .finally(() => {
        settled = true;
      });
    await vi.waitFor(() =>
      expect(t.session.buffer.bytes).toBeGreaterThan(before),
    );
    expect(settled).toBe(false);
    await t.release();
    const final = await waiting; // Finishes early despite the default 110-second window.
    expect(final.exit_code).toBe(0);
    expect(final.session_id).toBeUndefined();
    expect(plain(final.output)).toContain("DONE\n");
    expect(plain(final.output)).toContain("FINAL_STDERR\n");
    if (!tty)
      expect(final.stderr_bytes).toBe(Buffer.byteLength("FINAL_STDERR\n"));
    expect(t.session.outputReady).toBeUndefined();
  });

  it.each([undefined, ""])(
    "returns at a fixed deadline despite continuous output (chars=%s), without killing the process",
    async (chars) => {
      const value = manager();
      const t = await start(value, tty);
      const began = performance.now();
      const result = await value.writeStdin({
        session_id: t.id,
        wait_for: "exit",
        yield_time_ms: 150,
        ...(chars === undefined ? {} : { chars }),
      });
      expect(performance.now() - began).toBeGreaterThanOrEqual(125);
      expect(result.wall_time_seconds).toBeGreaterThanOrEqual(0.125);
      expect(result.session_id).toBe(t.id);
      expect(result.exit_code).toBeUndefined();
      expect(result.output.length).toBeGreaterThan(0);
      expect(t.session.outputReady).toBeUndefined();
      await t.release();
      const final = await value.writeStdin({
        session_id: t.id,
        wait_for: "exit",
      });
      expect(final.exit_code).toBe(0);
      expect(final.output).not.toContain("READY");
    },
  );

  it("allows zero-time polling and can switch from exit waiting back to output waiting", async () => {
    const value = manager();
    const t = await start(value, tty);
    const immediate = await value.writeStdin({
      session_id: t.id,
      wait_for: "exit",
      yield_time_ms: 0,
    });
    expect(immediate.output.length).toBeGreaterThan(0);
    expect(immediate.session_id).toBe(t.id);
    const next = await value.writeStdin({
      session_id: t.id,
      wait_for: "output",
    });
    // A single output notification can carry only part of a line or a VT frame.
    expect(next.output.length).toBeGreaterThan(0);
    expect(next.session_id).toBe(t.id);
  });

  it("cancels only the observer and preserves unread output for a subsequent call", async () => {
    const value = manager();
    const t = await start(value, tty);
    const controller = new AbortController();
    const before = t.session.buffer.bytes;
    const pending = value.writeStdin(
      { session_id: t.id, wait_for: "exit" },
      controller.signal,
    );
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() =>
      expect(t.session.buffer.bytes).toBeGreaterThan(before),
    );
    controller.abort();
    await rejected;
    expect(t.session.outputReady).toBeUndefined();
    expect(t.session.observers).toBe(0);
    expect(t.session.exitCode).toBeUndefined();
    expect(t.session.buffer.bytes).toBeGreaterThanOrEqual(before);
    const unreadBytes = t.session.buffer.bytes;
    const read = await value.writeStdin({ session_id: t.id, yield_time_ms: 0 });
    expect(Buffer.byteLength(read.output)).toBeGreaterThanOrEqual(unreadBytes);
    await t.release();
    expect(
      (await value.writeStdin({ session_id: t.id, wait_for: "exit" }))
        .exit_code,
    ).toBe(0);
  });

  it("keeps other sessions usable and releases a long observer when the manager closes", async () => {
    const value = manager();
    const t = await start(value, tty);
    let settled = false;
    const pending = value
      .writeStdin({ session_id: t.id, wait_for: "exit" })
      .finally(() => {
        settled = true;
      });
    const other = await value.execCommand(
      { cmd: nodeCommand('console.log("OTHER_READY")'), tty, yield_time_ms: 0 },
      t.root,
    );
    const final = other.session_id
      ? await value.writeStdin({
          session_id: other.session_id,
          wait_for: "exit",
        })
      : other;
    expect(final.exit_code).toBe(0);
    expect(plain(other.output + final.output)).toContain("OTHER_READY");
    expect(settled).toBe(false);
    await value.close();
    await pending;
    expect(t.session.outputReady).toBeUndefined();
    expect(t.session.observers).toBe(0);
    expect(value.getActiveSessions()).toHaveLength(0);
  });
});

it("writes input and closes stdin before waiting for exit, rather than returning on the first log", async () => {
  const value = manager();
  const first = await value.execCommand(
    {
      cmd: nodeCommand(`
    console.log('READY');let input='';
    process.stdin.on('data', c => {input += c;console.log('PROGRESS');});
    process.stdin.on('end', () => setTimeout(() => {console.log('INPUT:'+input);process.exit(7);}, 350));
  `),
      yield_time_ms: 0,
    },
    tmpdir(),
  );
  const result = await value.writeStdin({
    session_id: first.session_id!,
    chars: "payload",
    close_stdin: true,
    wait_for: "exit",
  });
  expect(result.exit_code).toBe(7);
  expect(result.session_id).toBeUndefined();
  expect(result.output).toContain("PROGRESS");
  expect(result.output).toContain("INPUT:payload");
});

it("leaves the rolling buffer bounded during an exit wait and drains an already-ended process immediately", async () => {
  const value = manager(4096);
  const first = await value.execCommand(
    {
      cmd: nodeCommand(`
    process.stdout.write('BEGIN\\n'+'x'.repeat(300_000)+'\\nEND\\n',()=>process.exit(0));
  `),
      yield_time_ms: 0,
    },
    tmpdir(),
  );
  const result = await value.writeStdin({
    session_id: first.session_id!,
    wait_for: "exit",
  });
  expect(result.exit_code).toBe(0);
  expect(result.truncated).toBe(true);
  expect(result.omitted_bytes).toBeGreaterThan(250_000);
  expect(first.output + result.output).toContain("BEGIN\n");
  expect(result.output).toContain("END\n");
  expect(result.output.length).toBeLessThan(5000);
  const finished = await value.execCommand(
    { cmd: nodeCommand('console.log("ALREADY_DONE")'), yield_time_ms: 0 },
    tmpdir(),
  );
  await value["sessions"].get(finished.session_id!)!.done;
  expect(
    (
      await value.writeStdin({
        session_id: finished.session_id!,
        wait_for: "exit",
      })
    ).exit_code,
  ).toBe(0);
});

describe.each([false, true])(
  "exit waiting over actual MCP (legacy=%s)",
  (legacy) => {
    it("shares the optional enum contract and raw terminal state across direct and nested calls", async () => {
      const t = await connect({}, legacy);
      connections.push(t);
      const listed = (await t.client.listTools()).tools.find(
        (tool) => tool.name === "write_stdin",
      )!;
      expect(listed.inputSchema.properties?.wait_for).toMatchObject({
        enum: ["output", "exit"],
      });
      expect(listed.inputSchema.required).not.toContain("wait_for");
      expect(listed.description).toContain("wait_for=exit");
      for (const nested of [false, true]) {
        const f = await fixture();
        const first = jsonOutput<TerminalResult>(
          await t.client.callTool({
            name: "exec_command",
            arguments: { cmd: f.cmd, workdir: f.root, yield_time_ms: 0 },
          }),
        );
        const args = {
          session_id: first.session_id!,
          wait_for: "exit",
          yield_time_ms: 110_000,
        };
        const session = t.runtime.terminal["sessions"].get(first.session_id!)!;
        const pending = t.client.callTool(
          nested
            ? {
                name: "exec",
                arguments: {
                  source: `text(await tools.write_stdin(${JSON.stringify(args)}));`,
                  yield_time_ms: 0,
                },
              }
            : { name: "write_stdin", arguments: args },
        );
        await vi.waitFor(
          () => expect(session.outputReady).toBeTypeOf("function"),
          { timeout: 10_000, interval: 10 },
        );
        await vi.waitFor(() => expect(session.buffer.pending).toBe(true), {
          timeout: 10_000,
        });
        if (nested) {
          const yielded = await pending;
          const id = cellId(yielded);
          const stillRunning = await t.client.callTool({
            name: "wait",
            arguments: { cell_id: id, yield_time_ms: 0 },
          });
          expect(cellId(stillRunning)).toBe(id);
          await f.release();
          const completed = await t.client.callTool({
            name: "wait",
            arguments: { cell_id: id, yield_time_ms: 110_000 },
          });
          expect(jsonOutput<TerminalResult>(completed).exit_code).toBe(0);
        } else {
          await f.release();
          expect(jsonOutput<TerminalResult>(await pending).exit_code).toBe(0);
        }
      }
    });
  },
);

it("does not restart a queued read's expired wait budget after another observer releases the session", async () => {
  const value = manager();
  const t = await start(value);
  const waits = vi.spyOn(timing, "waitUntil");
  const first = value.writeStdin({
    session_id: t.id,
    wait_for: "exit",
    yield_time_ms: 150,
  });
  const second = value.writeStdin({
    session_id: t.id,
    wait_for: "exit",
    yield_time_ms: 25,
  });
  const results = await Promise.all([first, second]);
  expect(waits).toHaveBeenCalledTimes(2);
  expect(waits.mock.calls[1]![1]).toBe(0);
  expect(results.every((result) => result.session_id === t.id)).toBe(true);
  expect(t.session.outputReady).toBeUndefined();
  expect(t.session.observers).toBe(0);
});

it("continues draining an ended process with the same handle when one exit response cannot fit all output", async () => {
  const value = manager(6 * 1024 * 1024);
  const first = await value.execCommand(
    {
      cmd: nodeCommand(
        'process.stdout.write("x".repeat(5*1024*1024),()=>process.exit(0));',
      ),
      yield_time_ms: 0,
    },
    tmpdir(),
  );
  const next = await value.writeStdin({
    session_id: first.session_id!,
    wait_for: "exit",
  });
  expect(next.session_id).toBe(first.session_id);
  expect(next.truncated).toBeUndefined();
  const last = await value.writeStdin({
    session_id: next.session_id!,
    wait_for: "exit",
  });
  expect(last.exit_code).toBe(0);
  expect(last.session_id).toBeUndefined();
  expect(first.output.length + next.output.length + last.output.length).toBe(
    5 * 1024 * 1024,
  );
});

it("rejects unsupported wait modes and keeps the existing 110-second parameter bound", () => {
  for (const wait_for of ["output", "exit", undefined])
    expect(STDIN_SCHEMA.safeParse({ session_id: "id", wait_for }).success).toBe(
      true,
    );
  for (const wait_for of ["sleep", "done", true, 1, null])
    expect(STDIN_SCHEMA.safeParse({ session_id: "id", wait_for }).success).toBe(
      false,
    );
  expect(
    STDIN_SCHEMA.safeParse({
      session_id: "id",
      wait_for: "exit",
      yield_time_ms: 110_001,
    }).success,
  ).toBe(false);
});

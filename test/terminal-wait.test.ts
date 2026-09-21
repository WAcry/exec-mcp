import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { STDIN_SCHEMA } from "../src/catalog.js";
import * as timing from "../src/util.js";
import {
  TerminalManager,
  stdinYieldTime,
  type TerminalResult,
} from "../src/host/terminal.js";
import {
  cellId,
  connect,
  jsonOutput,
  nodeCommand,
  observeTerminal,
  nativeRequest,
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

describe.each([false, true])("terminal deadline waiting (PTY=%s)", (tty) => {
  it.each([undefined, ""])(
    "ignores existing/new output by default until actual completion (chars=%s)",
    async (chars) => {
      const value = manager();
      const t = await start(value, tty);
      const initial = await value.writeStdin({
        session_id: t.id,
        yield_time_ms: 0,
      });
      expect(initial.output.length).toBeGreaterThan(0);
      expect(initial.session_id).toBe(t.id);
      await vi.waitFor(() => expect(t.session.buffer.pending).toBe(true));
      const before = t.session.buffer.bytes;
      const waits = vi.spyOn(timing, "waitUntil");
      let settled = false;
      const waiting = value
        .writeStdin({
          session_id: t.id,
          ...(chars === undefined ? {} : { chars }),
        })
        .finally(() => {
          settled = true;
        });
      await vi.waitFor(() =>
        expect(t.session.buffer.bytes).toBeGreaterThan(before),
      );
      expect(settled).toBe(false);
      expect(waits).toHaveBeenCalledTimes(1);
      expect(waits.mock.calls[0]![1]).toBeGreaterThan(4500);
      expect(waits.mock.calls[0]![1]).toBeLessThanOrEqual(5000);
      await t.release();
      const final = await waiting; // Finishes early despite the default collection window.
      expect(final.exit_code).toBe(0);
      expect(final.session_id).toBeUndefined();
      expect(plain(final.output)).toContain("DONE\n");
      expect(plain(final.output)).toContain("FINAL_STDERR\n");
      if (!tty)
        expect(final.stderr_bytes).toBe(Buffer.byteLength("FINAL_STDERR\n"));
      expect(t.session.exitReady).toBeUndefined();
    },
  );

  it.each([undefined, ""])(
    "returns at a fixed deadline despite continuous output (chars=%s), without killing the process",
    async (chars) => {
      const value = manager();
      const t = await start(value, tty);
      const began = performance.now();
      const result = await value.writeStdin({
        session_id: t.id,
        yield_time_ms: 150,
        ...(chars === undefined ? {} : { chars }),
      });
      expect(performance.now() - began).toBeGreaterThanOrEqual(125);
      expect(result.wall_time_seconds).toBeGreaterThanOrEqual(0.125);
      expect(result.session_id).toBe(t.id);
      expect(result.exit_code).toBeUndefined();
      expect(result.output.length).toBeGreaterThan(0);
      expect(t.session.exitReady).toBeUndefined();
      await t.release();
      const final = await value.writeStdin({
        session_id: t.id,
      });
      expect(final.exit_code).toBe(0);
      expect(final.output).not.toContain("READY");
    },
  );

  it("uses zero or short windows for interactive progress without another wait mode", async () => {
    const value = manager();
    const t = await start(value, tty);
    const immediate = await value.writeStdin({
      session_id: t.id,
      yield_time_ms: 0,
    });
    expect(immediate.output.length).toBeGreaterThan(0);
    expect(immediate.session_id).toBe(t.id);
    await vi.waitFor(() => expect(t.session.buffer.pending).toBe(true));
    const began = performance.now();
    const next = await value.writeStdin({
      session_id: t.id,
      yield_time_ms: 100,
    });
    expect(performance.now() - began).toBeGreaterThanOrEqual(80);
    // PTY output can include a partial line or a VT frame, not just complete progress lines.
    expect(next.output.length).toBeGreaterThan(0);
    expect(next.session_id).toBe(t.id);
  });

  it("uses the short interactive default after writing input or resizing a PTY", async () => {
    const value = manager();
    const t = await start(value, tty);
    const waits = vi.spyOn(timing, "waitUntil");
    // The application exits only after release, independently of Windows
    // ConPTY/profile startup and how quickly close events reach Node.
    const result = await value.writeStdin({
      session_id: t.id,
      chars: tty ? "input\r" : "input\n",
      ...(tty ? { cols: 80, rows: 30 } : {}),
    });
    expect(waits).toHaveBeenCalledTimes(1);
    expect(waits.mock.calls[0]![1]).toBe(250);
    expect(result.session_id).toBe(t.id);
    expect(result.output.length).toBeGreaterThan(0);
    await t.release();
    const final = await observeTerminal(result, (input) =>
      value.writeStdin(input),
    );
    expect(final.exit_code).toBe(0);
    expect(plain(final.output)).toContain("FINAL_STDERR\n");
    expect(t.session.exitReady).toBeUndefined();
  });

  it("cancels only the observer and preserves unread output for a subsequent call", async () => {
    const value = manager();
    const t = await start(value, tty);
    const controller = new AbortController();
    const before = t.session.buffer.bytes;
    const pending = value.writeStdin({ session_id: t.id }, controller.signal);
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() =>
      expect(t.session.buffer.bytes).toBeGreaterThan(before),
    );
    controller.abort();
    await rejected;
    expect(t.session.exitReady).toBeUndefined();
    expect(t.session.observers).toBe(0);
    expect(t.session.exitCode).toBeUndefined();
    expect(t.session.buffer.bytes).toBeGreaterThanOrEqual(before);
    const unreadBytes = t.session.buffer.bytes;
    const read = await value.writeStdin({ session_id: t.id, yield_time_ms: 0 });
    expect(Buffer.byteLength(read.output)).toBeGreaterThanOrEqual(unreadBytes);
    await t.release();
    expect((await value.writeStdin({ session_id: t.id })).exit_code).toBe(0);
  });

  it("keeps other sessions usable and releases a long observer when the manager closes", async () => {
    const value = manager();
    const t = await start(value, tty);
    let settled = false;
    const pending = value
      .writeStdin({ session_id: t.id, yield_time_ms: 300000 })
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
        })
      : other;
    expect(final.exit_code).toBe(0);
    expect(plain(other.output + final.output)).toContain("OTHER_READY");
    expect(settled).toBe(false);
    await value.close();
    await pending;
    expect(t.session.exitReady).toBeUndefined();
    expect(t.session.observers).toBe(0);
    expect(value.getActiveSessions()).toHaveLength(0);
  });
});

it("returns after a short input window and lets a later read collect EOF-triggered completion", async () => {
  const value = manager();
  const f = await fixture();
  const first = await value.execCommand(
    {
      cmd: nodeCommand(`
    const fs=require('node:fs');
    console.log('READY');let input='';
    process.stdin.on('data', c => {input += c;console.log('PROGRESS');});
    process.stdin.on('end', () => setInterval(() => {
      if (fs.existsSync(${JSON.stringify(path.join(f.root, "finish"))})) {
        console.log('INPUT:'+input);process.exit(7);
      }
    }, 20));
  `),
      yield_time_ms: 0,
    },
    tmpdir(),
  );
  const waits = vi.spyOn(timing, "waitUntil");
  const result = await value.writeStdin({
    session_id: first.session_id!,
    chars: "payload",
    close_stdin: true,
  });
  expect(waits).toHaveBeenCalledTimes(1);
  expect(waits.mock.calls[0]![1]).toBe(250);
  expect(result.session_id).toBe(first.session_id);
  await f.release();
  const final = await observeTerminal(result, (input) =>
    value.writeStdin(input),
  );
  expect(final.exit_code).toBe(7);
  expect(final.output).toContain("PROGRESS");
  expect(final.output).toContain("INPUT:payload");
});

it("leaves the rolling buffer bounded during a default wait and drains an already-ended process immediately", async () => {
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
      })
    ).exit_code,
  ).toBe(0);
});

describe.each([false, true])(
  "default deadline waiting over actual MCP (legacy=%s)",
  (legacy) => {
    it("exposes Codex-style stdin collection inside exec and resumes long waits via the outer cell", async () => {
      const t = await connect({}, legacy);
      connections.push(t);
      const advertised = (await t.client.listTools()).tools;
      expect(advertised.map((tool) => tool.name)).toEqual(["exec", "wait"]);
      expect(JSON.stringify(advertised)).not.toContain("wait_for");
      const catalogResult = await t.client.callTool({
        name: "exec",
        arguments: {
          source: 'text(ALL_TOOLS.find(tool=>tool.name==="write_stdin"));',
        },
      });
      const catalog = jsonOutput<{ description: string }>(catalogResult);
      expect(catalog.description).not.toContain("wait_for");
      expect(catalog.description).toContain(
        "new output does not end the window",
      );
      expect(catalog.description).toContain("Non-empty writes default to 250");
      expect(catalog.description).toContain("empty reads default to 5000");
      expect(advertised[0]!.description).toContain(catalog.description);
      for (const wait_for of ["output", "exit"]) {
        const oldArguments = {
          session_id: "retired-mode",
          yield_time_ms: 0,
          wait_for,
        };
        const nested = await t.client.callTool({
          name: "exec",
          arguments: {
            source: `text(await tools.write_stdin(${JSON.stringify(oldArguments)}));`,
          },
        });
        expect(nested.isError).toBe(true);
        expect(JSON.stringify(nested)).toContain("参数无效");
      }
      {
        const f = await fixture();
        const first = jsonOutput<TerminalResult>(
          await t.client.callTool(
            nativeRequest("exec_command", {
              cmd: f.cmd,
              workdir: f.root,
              yield_time_ms: 0,
            }),
          ),
        );
        const args = {
          session_id: first.session_id!,
          yield_time_ms: 300000,
        };
        const session = t.runtime.terminal["sessions"].get(first.session_id!)!;
        const pending = t.client.callTool({
          name: "exec",
          arguments: {
            source: `text(await tools.write_stdin(${JSON.stringify(args)}));`,
            yield_time_ms: 0,
          },
        });
        await vi.waitFor(
          () => expect(session.exitReady).toBeTypeOf("function"),
          { timeout: 10_000, interval: 10 },
        );
        await vi.waitFor(() => expect(session.buffer.pending).toBe(true), {
          timeout: 10_000,
        });
        {
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
        }
      }
    });
  },
);

it("gives each queued input its collection window after acquiring the session, and keeps zero immediate", async () => {
  const value = manager();
  const t = await start(value);
  const waits = vi.spyOn(timing, "waitUntil");
  const first = value.writeStdin({
    session_id: t.id,
    chars: "first",
  });
  const second = value.writeStdin({
    session_id: t.id,
    chars: "second",
  });
  const immediate = value.writeStdin({
    session_id: t.id,
    yield_time_ms: 0,
  });
  const results = await Promise.all([first, second, immediate]);
  expect(waits.mock.calls.map((call) => call[1])).toEqual([250, 250, 0]);
  expect(results.every((result) => result.session_id === t.id)).toBe(true);
  expect(t.session.exitReady).toBeUndefined();
  expect(t.session.observers).toBe(0);
  await t.release();
  expect((await value.writeStdin({ session_id: t.id })).exit_code).toBe(0);
});

it("continues draining an ended process with the same handle when one response cannot fit all output", async () => {
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
  });
  expect(next.session_id).toBe(first.session_id);
  expect(next.truncated).toBeUndefined();
  const last = await value.writeStdin({
    session_id: next.session_id!,
  });
  expect(last.exit_code).toBe(0);
  expect(last.session_id).toBeUndefined();
  expect(first.output.length + next.output.length + last.output.length).toBe(
    5 * 1024 * 1024,
  );
});

it("removes the old wait-mode field and keeps a single bounded wait duration", () => {
  expect(STDIN_SCHEMA.safeParse({ session_id: "id" }).success).toBe(true);
  for (const yield_time_ms of [0, 1000, 110_000, 300_000])
    expect(
      STDIN_SCHEMA.safeParse({ session_id: "id", yield_time_ms }).success,
    ).toBe(true);
  for (const wait_for of ["output", "exit", undefined, null])
    expect(STDIN_SCHEMA.safeParse({ session_id: "id", wait_for }).success).toBe(
      false,
    );
  for (const yield_time_ms of [-1, 0.5, 300_001, "110000", null])
    expect(
      STDIN_SCHEMA.safeParse({ session_id: "id", yield_time_ms }).success,
    ).toBe(false);
});

it("uses Codex collection defaults and bounds, retaining explicit zero for immediate observation", () => {
  const base = { session_id: "id" };
  expect(stdinYieldTime(base)).toBe(5000);
  expect(stdinYieldTime({ ...base, chars: "" })).toBe(5000);
  expect(stdinYieldTime({ ...base, chars: "input" })).toBe(250);
  expect(stdinYieldTime({ ...base, yield_time_ms: 1 })).toBe(5000);
  expect(stdinYieldTime({ ...base, chars: "input", yield_time_ms: 1 })).toBe(
    250,
  );
  expect(stdinYieldTime({ ...base, yield_time_ms: 300000 })).toBe(300000);
  expect(
    stdinYieldTime({ ...base, chars: "input", yield_time_ms: 300000 }),
  ).toBe(30000);
  for (const chars of [undefined, "", "input"])
    expect(
      stdinYieldTime({
        ...base,
        ...(chars === undefined ? {} : { chars }),
        yield_time_ms: 0,
      }),
    ).toBe(0);
});

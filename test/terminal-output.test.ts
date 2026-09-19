import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalManager, type TerminalResult } from "../src/host/terminal.js";
import {
  nodeCommand,
  observeTerminal,
  connect,
  jsonOutput,
} from "./helpers.js";
import { MEMORY_DEFAULTS } from "../src/memory.js";
import { tmpdir } from "node:os";
import { stripVTControlCharacters } from "node:util";

const terminals: TerminalManager[] = [];
const connections: Awaited<ReturnType<typeof connect>>[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    connections.splice(0).map((connection) => connection.close()),
  );
  await Promise.all(terminals.splice(0).map((terminal) => terminal.close()));
});
function terminal(bufferBytes = 4096, idleMs?: number) {
  const value = new TerminalManager({
    bufferBytes,
    ...(idleMs === undefined ? {} : { idleMs }),
  });
  terminals.push(value);
  return value;
}
const marker =
  /\n\[中间已省略 \d+ 字节；输出已滚动截断，不能通过后续读取恢复\]\n/g;
function plain(output: string) {
  return stripVTControlCharacters(output).replaceAll("\r\n", "\n");
}

describe("real rolling terminal output, not output files", () => {
  it.each([false, true])(
    "keeps head/tail and never blocks a finite large producer awaiting consumption (PTY=%s)",
    async (tty) => {
      const value = terminal();
      const first = await value.execCommand(
        {
          cmd: nodeCommand(
            'process.stdout.write("BEGIN_LOG\\n"+"line-data\\n".repeat(25000)+"END_LOG\\n",()=>process.exit(0));',
          ),
          tty,
          yield_time_ms: 0,
        },
        tmpdir(),
      );
      expect(first.session_id).toBeDefined();
      const owned = value["sessions"].get(first.session_id!)!;
      await owned.done; // Intentionally leave the entire log unread until the writer exits.
      expect(owned.buffer.bytes).toBeLessThanOrEqual(4096);
      expect(owned.buffer.allocatedBytes).toBeLessThan(4096 + 2 * 16384);
      const result = await value.writeStdin({
        session_id: first.session_id!,
        yield_time_ms: 0,
      });
      const output = plain(first.output + result.output);
      expect(output).toContain("BEGIN_LOG");
      expect(output).toContain("END_LOG");
      expect(result.truncated).toBe(true);
      expect(result.omitted_bytes).toBeGreaterThan(200_000);
      expect(result.exit_code).toBe(0);
      expect(result.session_id).toBeUndefined();
      expect(output).not.toContain("\ufffd");
      expect(output).toContain("已滚动截断");
      await expect(
        value.writeStdin({ session_id: first.session_id! }),
      ).rejects.toThrow("未知或已读完");
    },
  );
  it("can stop a noisy process while another session continues producing readable progress", async () => {
    const value = terminal();
    const noisy = await value.execCommand(
      {
        cmd: nodeCommand(
          'setInterval(()=>process.stdout.write("x".repeat(8192)),1);',
        ),
        yield_time_ms: 0,
      },
      tmpdir(),
    );
    const deadline = Date.now() + 10_000;
    while (
      !value["sessions"].get(noisy.session_id!)!.buffer.omittedBytes &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(
      value["sessions"].get(noisy.session_id!)!.buffer.omittedBytes,
    ).toBeGreaterThan(0);
    const result = await observeTerminal(
      await value.execCommand(
        {
          cmd: nodeCommand('console.log("OTHER_PROCESS_READY")'),
          yield_time_ms: 0,
        },
        tmpdir(),
      ),
      (input) => value.writeStdin(input),
    );
    expect(result.output).toBe("OTHER_PROCESS_READY\n");
    expect(result.truncated).toBeUndefined();
    const stopped = await observeTerminal(
      await value.writeStdin({
        session_id: noisy.session_id!,
        terminate: true,
      }),
      (input) => value.writeStdin(input),
    );
    expect(stopped.exit_code).toBeDefined();
  });
  it("keeps each consumed batch incremental rather than repeating the process startup head forever", async () => {
    const value = terminal();
    const first = await value.execCommand(
      {
        cmd: nodeCommand(
          'console.log("BOOT");process.stdin.once("data",()=>{process.stdout.write("BURST_START\\n"+"x".repeat(20000));setTimeout(()=>process.stdout.write("x".repeat(30000)+"BURST_END\\n"),100);});',
        ),
        yield_time_ms: 0,
      },
      tmpdir(),
    );
    const boot = await observeTerminal(
      first,
      (input) => value.writeStdin(input),
      (result) => result.output.includes("BOOT"),
    );
    const owned = value["sessions"].get(boot.session_id!)!;
    const sent = await value.writeStdin({
      session_id: boot.session_id!,
      chars: "go",
      yield_time_ms: 0,
    });
    const sentBytes =
      Buffer.byteLength(sent.output.replace(marker, "")) +
      (sent.omitted_bytes ?? 0);
    const expectedBytes = 50000 + Buffer.byteLength("BURST_START\nBURST_END\n");
    const deadline = Date.now() + 3000;
    while (
      sentBytes + owned.buffer.bytes + owned.buffer.omittedBytes <
        expectedBytes &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
    const burst = await value.writeStdin({
      session_id: boot.session_id!,
      yield_time_ms: 0,
    });
    const output = sent.output + burst.output;
    expect(output).not.toContain("BOOT");
    expect(output).toContain("BURST_START");
    expect(output).toContain("BURST_END");
    expect(sent.truncated || burst.truncated).toBe(true);
    const empty = await value.writeStdin({
      session_id: boot.session_id!,
      yield_time_ms: 0,
    });
    expect(empty.output).toBe("");
    expect(empty.truncated).toBeUndefined();
  });
  it("expires completed unobserved records only, and does not kill running processes by age", async () => {
    const value = terminal(4096, 1000);
    const ended = await value.execCommand(
      {
        cmd: nodeCommand('process.stdout.write("old-output");'),
        yield_time_ms: 0,
      },
      tmpdir(),
    );
    const closed = value["sessions"].get(ended.session_id!)!;
    await closed.done;
    const running = await value.execCommand(
      { cmd: nodeCommand("setInterval(()=>{},1000);"), yield_time_ms: 0 },
      tmpdir(),
    );
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 2000);
    value["sweep"]();
    expect(value["sessions"].has(ended.session_id!)).toBe(false);
    expect(closed.buffer.allocatedBytes).toBe(0);
    expect(value["sessions"].has(running.session_id!)).toBe(true);
    vi.useRealTimers();
    const stopped = await value.writeStdin({
      session_id: running.session_id!,
      terminate: true,
    });
    expect(
      (await observeTerminal(stopped, (input) => value.writeStdin(input)))
        .exit_code,
    ).toBeDefined();
  });
  it("refreshes finished output retention when it is actually read", async () => {
    const value = terminal(8 * 1024 * 1024, 1000);
    const first = await value.execCommand(
      {
        cmd: nodeCommand('process.stdout.write("x".repeat(5500000));'),
        yield_time_ms: 0,
      },
      tmpdir(),
    );
    await value["sessions"].get(first.session_id!)!.done;
    vi.useFakeTimers({ toFake: ["Date"] });
    const base = Date.now();
    vi.setSystemTime(base + 900);
    const next = await value.writeStdin({
      session_id: first.session_id!,
      yield_time_ms: 0,
    });
    expect(next.session_id).toBeDefined();
    vi.setSystemTime(base + 1500);
    value["sweep"]();
    expect(value["sessions"].has(first.session_id!)).toBe(true);
    vi.setSystemTime(base + 1901);
    value["sweep"]();
    expect(value["sessions"].has(first.session_id!)).toBe(false);
    vi.useRealTimers();
  });
});

describe.each([false, true])(
  "terminal truncation metadata over MCP (legacy=%s)",
  (legacy) => {
    it("uses the configured buffer and accounts for head/tail truncation across incremental reads", async () => {
      const connection = await connect(
        { memory: { ...MEMORY_DEFAULTS, terminal_buffer_mib: 1 } },
        legacy,
      );
      connections.push(connection);
      const command = nodeCommand(
        'process.stdout.write("START_MARKER\\n"+"x".repeat(2*1024*1024)+"\\nFINAL_MARKER");',
      );
      // The initial zero-wait response may already consume one or more pipe chunks.
      // Summarize inside Code Mode so the model guard cannot truncate our test JSON.
      const summary = `text({...r,output:r.output.length>2000?r.output.slice(0,1000)+r.output.slice(-1000):r.output,retained_bytes:r.output.replace(new RegExp(${JSON.stringify(marker.source)},"g"),"").length});`;
      const first = await connection.client.callTool({
        name: "exec",
        arguments: {
          source: `const r=await tools.exec_command({cmd:${JSON.stringify(command)},yield_time_ms:0});${summary}`,
        },
      });
      expect(first.isError).not.toBe(true);
      type Observed = TerminalResult & { retained_bytes: number };
      const initial = jsonOutput<Observed>(first);
      const batches = [initial];
      if (initial.session_id) {
        await connection.runtime.terminal["sessions"].get(initial.session_id)!
          .done;
        const final = await connection.client.callTool({
          name: "exec",
          arguments: {
            source: `const r=await tools.write_stdin({session_id:${JSON.stringify(initial.session_id)},yield_time_ms:0});${summary}`,
          },
        });
        expect(final.isError).not.toBe(true);
        expect(final.structuredContent).toBeUndefined();
        batches.push(jsonOutput<Observed>(final));
      }
      expect(batches.at(-1)!.exit_code).toBe(0);
      expect(batches.some((batch) => batch.truncated)).toBe(true);
      const output = batches.map((batch) => batch.output).join("");
      expect(output).toContain("START_MARKER");
      expect(output).toContain("FINAL_MARKER");
      for (const batch of batches)
        expect(batch.retained_bytes).toBeLessThanOrEqual(1024 * 1024);
      // Verify every original byte is either retained or explicitly accounted for,
      // rather than assuming the first exec always returns an empty buffer.
      expect(
        batches.reduce(
          (sum, batch) =>
            sum + batch.retained_bytes + (batch.omitted_bytes ?? 0),
          0,
        ),
      ).toBe(
        2 * 1024 * 1024 + Buffer.byteLength("START_MARKER\n\nFINAL_MARKER"),
      );
    });
  },
);

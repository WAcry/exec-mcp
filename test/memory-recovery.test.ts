import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodeModeService } from "../src/code-mode/service.js";
import { CodeModeSession } from "../src/code-mode/session.js";
import { CodeModeHostProcess } from "../src/code-mode/host-process.js";
import { MEMORY_RECLAIMED_TEXT } from "../src/code-mode/session-pool.js";
import type { CodeModeServiceOptions } from "../src/code-mode/types.js";
import * as processMemory from "../src/host/process-memory.js";
import { MEMORY_DEFAULTS, MiB } from "../src/memory.js";
import { cellId, connect, jsonOutput, texts } from "./helpers.js";

function gate<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const pause = (ms = 10) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
const services: CodeModeService[] = [];
const connections: Awaited<ReturnType<typeof connect>>[] = [];
let opened: CodeModeSession[];
beforeEach(() => {
  opened = [];
  const original = CodeModeSession.open.bind(CodeModeSession);
  vi.spyOn(CodeModeSession, "open").mockImplementation(async (options) => {
    const session = await original(options);
    opened.push(session);
    return session;
  });
});
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    connections.splice(0).map((connection) => connection.close()),
  );
  await Promise.all(services.splice(0).map((service) => service.close()));
  vi.restoreAllMocks();
});
function service(
  samples: number[] = [500],
  options: CodeModeServiceOptions = {},
) {
  const reads: number[] = [];
  const reader = vi.fn(async (pid: number) => {
    reads.push(pid);
    return samples.length > 1 ? samples.shift()! : samples[0]!;
  });
  const value = new CodeModeService({
    memoryHighWaterBytes: 1000,
    memoryReader: reader,
    memoryCheckIntervalMs: 60_000,
    ...options,
  });
  services.push(value);
  return { value, reads, reader };
}
const run = (
  value: CodeModeService,
  source: string,
  sessionScope = "conversation",
) => value.exec({ source, sessionScope, tools: [] });

describe("native host pressure reclamation", () => {
  it("uses the actual owned-host memory sampler and recovers the same scope with a deliberately tiny test threshold", async () => {
    const { value } = service([], {
      memoryHighWaterBytes: 1,
      memoryReader: processMemory.readProcessMemory,
    });
    await run(value, 'store("before",42);');
    const old = opened[0]!;
    await value.checkMemory();
    expect(old.usable).toBe(false);
    const result = await run(value, 'text(load("before")===undefined);');
    expect(jsonOutput(result)).toBe(true);
    expect(opened[1]).not.toBe(old);
    expect(opened[1]!.usable).toBe(true);
  });
  it("excludes sessions opened while a memory sample is in flight", async () => {
    const started = gate(),
      finishSample = gate<number>();
    let calls = 0;
    const { value } = service([], {
      memoryReader: async () => {
        if (++calls === 1) {
          started.resolve();
          return finishSample.promise;
        }
        return 1200;
      },
    });
    await run(value, 'store("old",1);', "old");
    const checking = value.checkMemory();
    await started.promise;
    await run(value, 'store("new",2);', "new");
    const fresh = opened[1]!;
    finishSample.resolve(1200);
    await checking;
    expect(opened[0]!.usable).toBe(false);
    expect(fresh.usable).toBe(true);
    expect(jsonOutput(await run(value, 'text(load("new"));', "new"))).toBe(2);
  });
  it("does not start a host just for sampling and leaves sessions alone below the high-water mark", async () => {
    const { value, reader } = service([999]);
    await value.checkMemory();
    expect(reader).not.toHaveBeenCalled();
    await run(value, 'store("value",7);');
    const original = opened[0]!;
    await value.checkMemory();
    expect(original.usable).toBe(true);
    expect(jsonOutput(await run(value, 'text(load("value"));'))).toBe(7);
    expect(opened).toHaveLength(1);
  });
  it("reclaims FIFO idle state first and stops near the low-water target", async () => {
    const { value } = service([1200, 700]);
    await run(value, 'store("value","old-a");', "a");
    await pause();
    await run(value, 'store("value","old-b");', "b");
    await pause();
    await run(value, 'text(load("value"));', "a");
    const [a, b] = opened;
    await value.checkMemory();
    expect(a!.usable).toBe(true);
    expect(b!.usable).toBe(false);
    expect(
      jsonOutput(await run(value, 'text({value:load("value")});', "a")),
    ).toEqual({ value: "old-a" });
    const replacement = await run(
      value,
      'text(load("value")===undefined);',
      "b",
    );
    expect(jsonOutput(replacement)).toBe(true);
    expect(texts(replacement)[0]).toContain("新建原生执行会话");
    expect(opened[2]!.id).not.toBe(b!.id);
  });
  it("does not evict active sessions just to hit the 75% target after idle cleanup brought memory below high water", async () => {
    const { value } = service([1200, 950]);
    await run(value, 'store("idle",1);', "idle");
    const active = await run(
      value,
      'store("running",2);yield_control();await new Promise(()=>{});',
      "active",
    );
    const [idle, live] = opened;
    await value.checkMemory();
    expect(idle!.usable).toBe(false);
    expect(live!.usable).toBe(true);
    const observed = await value.wait({
      cellId: cellId(active),
      sessionScope: "active",
      yieldTimeMs: 0,
    });
    expect(texts(observed)[0]).toContain("Script running");
    await value.wait({
      cellId: cellId(active),
      sessionScope: "active",
      terminate: true,
    });
  });
  it("can retire an old active session while a recently observed one remains live", async () => {
    const { value } = service([1200, 900]);
    const a = await run(
      value,
      "yield_control();await new Promise(()=>{});",
      "a",
    );
    await pause();
    const b = await run(
      value,
      "yield_control();await new Promise(()=>{});",
      "b",
    );
    const [old, preserved] = opened;
    await value.checkMemory();
    expect(old!.usable).toBe(false);
    expect(preserved!.usable).toBe(true);
    await expect(
      value.wait({ cellId: cellId(a), sessionScope: "a" }),
    ).rejects.toThrow("内存压力");
    await expect(
      value.wait({ cellId: cellId(a), sessionScope: "b" }),
    ).rejects.toThrow("其他");
    const newA = await run(value, 'text(load("anything")===undefined);', "a");
    expect(jsonOutput(newA)).toBe(true);
    await expect(
      value.wait({ cellId: cellId(a), sessionScope: "a" }),
    ).rejects.toThrow("内存压力");
    expect(
      (
        await value.wait({
          cellId: cellId(b),
          sessionScope: "b",
          terminate: true,
        })
      ).isError,
    ).not.toBe(true);
  });
  it("opens a clean same-scope generation while old cleanup is still pending; late completion cannot overwrite it", async () => {
    const { value } = service([1200, 700]);
    const entered = gate(),
      unblockTool = gate(),
      closing = gate(),
      unblockClose = gate();
    let effects = 0;
    const oldExec = value.exec({
      sessionScope: "stable-meta",
      yieldTimeMs: 30_000,
      source:
        'await tools.block({});store("value","late-old");text("old-result");',
      tools: [
        {
          name: "block",
          description: "Controlled test",
          call: async () => {
            effects++;
            entered.resolve();
            await unblockTool.promise;
            return null;
          },
        },
      ],
    });
    const oldRejected = expect(oldExec).rejects.toThrow(MEMORY_RECLAIMED_TEXT);
    await entered.promise;
    const old = opened[0]!;
    const actualClose = old.close.bind(old);
    vi.spyOn(old, "close").mockImplementation(async () => {
      closing.resolve();
      await unblockClose.promise;
      await actualClose();
    });
    const pressure = value.checkMemory();
    await closing.promise;
    try {
      const [one, two] = await Promise.all([
        run(
          value,
          'text(load("value")===undefined);store("fresh",42);',
          "stable-meta",
        ),
        run(value, 'text(load("value")===undefined);', "stable-meta"),
      ]);
      expect(jsonOutput(one)).toBe(true);
      expect(jsonOutput(two)).toBe(true);
      expect(opened).toHaveLength(2);
      expect(opened[1]!.id).not.toBe(old.id);
      unblockTool.resolve();
      await oldRejected;
      unblockClose.resolve();
      await pressure;
      expect(
        jsonOutput(
          await run(
            value,
            'text({old:typeof load("value"),fresh:load("fresh")});',
            "stable-meta",
          ),
        ),
      ).toEqual({ old: "undefined", fresh: 42 });
      expect(effects).toBe(1);
      expect(opened[1]!.usable).toBe(true);
    } finally {
      unblockTool.resolve();
      unblockClose.resolve();
      await pressure;
    }
  });
  it("does not include new generations in a sweep that started before they existed", async () => {
    const { value } = service([1200]);
    await run(value, 'store("a",1);');
    const old = opened[0]!;
    const actualClose = old.close.bind(old);
    const closing = gate(),
      release = gate();
    vi.spyOn(old, "close").mockImplementation(async () => {
      closing.resolve();
      await release.promise;
      await actualClose();
    });
    const pressure = value.checkMemory();
    await closing.promise;
    try {
      await run(value, 'store("new",3);');
      const replacement = opened[1]!;
      release.resolve();
      await pressure;
      expect(replacement.usable).toBe(true);
      expect(jsonOutput(await run(value, 'text(load("new"));'))).toBe(3);
    } finally {
      release.resolve();
      await pressure;
    }
  });
  it("recycles an empty but resident host and can immediately serve the same metadata scope again", async () => {
    const { value, reads } = service([1200, 1200, 500]);
    await run(value, 'store("old",7);');
    await value.checkMemory();
    expect(opened[0]!.usable).toBe(false);
    expect(jsonOutput(await run(value, 'text(load("old")===undefined);'))).toBe(
      true,
    );
    await value.checkMemory();
    expect(reads.at(-1)).not.toBe(reads[0]);
    expect(opened).toHaveLength(2);
  });
  it("gates new exec only during a host-wide reset, then releases it into a fresh generation", async () => {
    const { value } = service([1200], { memoryCloseTimeoutMs: 30 });
    await run(value, 'store("old",9);');
    const session = opened[0]!;
    const close = session.close.bind(session);
    const releaseClose = gate();
    vi.spyOn(session, "close").mockImplementation(async () => {
      await releaseClose.promise;
      await close();
    });
    const stopping = gate(),
      releaseStop = gate();
    const nativeStop = CodeModeHostProcess.prototype.stop;
    const stopSpy = vi
      .spyOn(CodeModeHostProcess.prototype, "stop")
      .mockImplementation(async function (this: CodeModeHostProcess) {
        stopping.resolve();
        await releaseStop.promise;
        return nativeStop.call(this);
      });
    const pressure = value.checkMemory();
    await stopping.promise;
    let completed = false;
    const next = run(value, 'text(load("old")===undefined);').then((result) => {
      completed = true;
      return result;
    });
    try {
      await pause(20);
      expect(completed).toBe(false);
      releaseStop.resolve();
      await pressure;
      expect(jsonOutput(await next)).toBe(true);
      expect(opened[1]!.usable).toBe(true);
    } finally {
      releaseStop.resolve();
      releaseClose.resolve();
      stopSpy.mockRestore();
      await pressure;
      await next;
    }
  });
  it("measurement errors and stale snapshots never trigger blind reclamation", async () => {
    const onError = vi.fn();
    const read = vi.fn(async () => Number.NaN);
    const { value } = service([], { memoryReader: read, onError });
    await run(value, 'store("safe",7);');
    await value.checkMemory();
    await value.checkMemory();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(opened[0]!.usable).toBe(true);
    read.mockResolvedValue(500);
    await value.checkMemory();
    expect(jsonOutput(await run(value, 'text(load("safe"));'))).toBe(7);
    read.mockRejectedValue(new Error("sample failed"));
    await value.checkMemory();
    expect(onError).toHaveBeenCalledTimes(2);
    expect(opened[0]!.usable).toBe(true);
  });
  it("ignores a sample for an old host after a new host has already recovered the same scope", async () => {
    let host: CodeModeHostProcess | undefined;
    const nativeStart = CodeModeHostProcess.prototype.start;
    vi.spyOn(CodeModeHostProcess.prototype, "start").mockImplementation(
      function (this: CodeModeHostProcess) {
        host = this;
        return nativeStart.call(this);
      },
    );
    const sampled = gate(),
      finish = gate<number>();
    const { value } = service([], {
      memoryReader: async () => {
        sampled.resolve();
        return finish.promise;
      },
    });
    await run(value, 'store("old",1);');
    const firstIdentity = host!.identity;
    const pressure = value.checkMemory();
    await sampled.promise;
    try {
      await host!.stop();
      await pause(30);
      await run(value, 'store("new",2);');
      expect(host!.identity).not.toBe(firstIdentity);
      finish.resolve(1200);
      await pressure;
      expect(opened[1]!.usable).toBe(true);
      expect(jsonOutput(await run(value, 'text(load("new"));'))).toBe(2);
    } finally {
      finish.resolve(1200);
      await pressure;
    }
  });
  it("does not restart healthy siblings when old external cleanup is slow but memory has already fallen", async () => {
    const { value } = service([1200, 500], { memoryCloseTimeoutMs: 30 });
    await run(value, 'store("old",1);', "old");
    const other = await run(
      value,
      "yield_control();await new Promise(()=>{});",
      "other",
    );
    const old = opened[0]!;
    const original = old.close.bind(old);
    const release = gate();
    vi.spyOn(old, "close").mockImplementation(async () => {
      await release.promise;
      await original();
    });
    try {
      await value.checkMemory();
      expect(opened[1]!.usable).toBe(true);
      await value.wait({
        cellId: cellId(other),
        sessionScope: "other",
        terminate: true,
      });
    } finally {
      release.resolve();
      await old.close();
    }
  });
  it("does not overlap maintenance runs and stops its interval after shutdown", async () => {
    const sampled = gate<number>();
    const read = vi.fn(async () => sampled.promise);
    const { value } = service([], { memoryReader: read });
    await run(value, "text(42);");
    const first = value.checkMemory(),
      second = value.checkMemory();
    expect(first).toBe(second);
    expect(read).toHaveBeenCalledTimes(1);
    sampled.resolve(500);
    await first;
    await value.close();
    await value.checkMemory();
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe.each([false, true])(
  "stable ChatGPT metadata across native session replacement (legacy=%s)",
  (legacy) => {
    it("keeps the exact metadata scope while invalidating old cell handles and using a new native session ID", async () => {
      let bytes = 100;
      vi.spyOn(processMemory, "readProcessMemory").mockImplementation(
        async () => {
          const result = bytes;
          bytes = 100;
          return result;
        },
      );
      const connection = await connect(
        { memory: { ...MEMORY_DEFAULTS, code_mode_high_water_mib: 1 } },
        legacy,
      );
      connections.push(connection);
      const metadata = { "openai/session": "UNCHANGED_META_CONVERSATION" };
      const call = (source: string) =>
        connection.client.callTool({
          name: "exec",
          arguments: { source },
          _meta: metadata,
        });
      const old = await call(
        'store("old",42);yield_control();await new Promise(()=>{});',
      );
      const oldHandle = cellId(old),
        oldNativeId = opened[0]!.id;
      expect(oldNativeId).not.toBe(metadata["openai/session"]);
      bytes = 2 * MiB;
      await connection.runtime.codeMode.checkMemory();
      const forgotten = await connection.client.callTool({
        name: "wait",
        arguments: { cell_id: oldHandle },
        _meta: metadata,
      });
      expect(forgotten.isError).toBe(true);
      expect(texts(forgotten).join("\n")).toContain("内存压力");
      const fresh = await call('text(load("old")===undefined);store("new",7);');
      expect(fresh.isError).not.toBe(true);
      expect(jsonOutput(fresh)).toBe(true);
      expect(opened[1]!.id).not.toBe(oldNativeId);
      expect(texts(fresh)[0]).toContain("新建原生执行会话");
      expect(jsonOutput(await call('text(load("new"));'))).toBe(7);
      const stale = await connection.client.callTool({
        name: "wait",
        arguments: { cell_id: oldHandle },
        _meta: metadata,
      });
      expect(stale.isError).toBe(true);
      expect(texts(stale).join("\n")).toContain("内存压力");
      expect(jsonOutput(await call('text(load("new"));'))).toBe(7);
      expect(
        (await connection.client.listTools()).tools.map((tool) => tool.name),
      ).toEqual(["exec", "wait"]);
    });
  },
);

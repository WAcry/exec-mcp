import { afterEach, describe, expect, it } from "vitest";
import { CodeModeService } from "../src/code-mode/service.js";
import { SessionPool } from "../src/code-mode/session-pool.js";
import type { CodeModeSession } from "../src/code-mode/session.js";
import { cellId, jsonOutput, texts } from "./helpers.js";

const services: CodeModeService[] = [];
const pools: SessionPool[] = [];
function service(sessionIdleMs?: number) {
  const value = new CodeModeService(
    sessionIdleMs === undefined ? {} : { sessionIdleMs },
  );
  services.push(value);
  return value;
}
const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
const run = (
  value: CodeModeService,
  source: string,
  scope = "conversation-a",
) => value.exec({ source, tools: [], sessionScope: scope });
afterEach(async () => {
  await Promise.all(services.splice(0).map((value) => value.close()));
  await Promise.all(pools.splice(0).map((value) => value.close()));
});

describe("bounded conversation store/load", () => {
  it("shares JSON only within one conversation, across cells and model turns", async () => {
    const value = service();
    await run(value, 'globalThis.transient=7; store("rows", {items:[1,2,3]});');
    expect(
      jsonOutput(
        await run(
          value,
          'text({rows:load("rows"),missing:typeof load("absent"),transient:typeof transient});',
        ),
      ),
    ).toEqual({
      rows: { items: [1, 2, 3] },
      missing: "undefined",
      transient: "undefined",
    });
    expect(
      jsonOutput(
        await run(value, 'text({rows:typeof load("rows")});', "conversation-b"),
      ),
    ).toEqual({ rows: "undefined" });
    await run(value, 'const copy=load("rows");copy.items.push(4);');
    expect(jsonOutput(await run(value, 'text(load("rows"));'))).toEqual({
      items: [1, 2, 3],
    });
    await run(
      value,
      'const copy=load("rows");copy.items.push(4);store("rows",copy);',
    );
    expect(jsonOutput(await run(value, 'text(load("rows"));'))).toEqual({
      items: [1, 2, 3, 4],
    });
  });

  it("does not invent shared identity when the host omits conversation metadata", async () => {
    const value = service();
    const result = await value.exec({
      source: 'store("secret",42);',
      tools: [],
    });
    expect(result.isError).toBe(true);
    expect(texts(result).join("\n")).toContain("openai/session");
    expect(
      jsonOutput(await run(value, 'text(load("secret")===undefined);')),
    ).toBe(true);
    expect(
      jsonOutput(await value.exec({ source: "text(2+2);", tools: [] })),
    ).toBe(4);
  });

  it("does not publish running or terminated writes, but commits writes before a script error", async () => {
    const value = service();
    const writer = await value.exec({
      source: 'store("pending",42);yield_control();await new Promise(()=>{});',
      tools: [],
      sessionScope: "conversation-a",
    });
    expect(
      jsonOutput(await run(value, 'text(load("pending")===undefined);')),
    ).toBe(true);
    await value.wait({
      cellId: cellId(writer),
      sessionScope: "conversation-a",
      terminate: true,
    });
    expect(
      jsonOutput(await run(value, 'text(load("pending")===undefined);')),
    ).toBe(true);
    const failed = await run(
      value,
      'store("committed",5);throw new Error("expected");',
    );
    expect(failed.isError).toBe(true);
    expect(jsonOutput(await run(value, 'text(load("committed"));'))).toBe(5);
  });

  it("merges concurrent cell writes without sharing JS variables", async () => {
    const value = service();
    await Promise.all([
      run(value, 'store("first",1);globalThis.first=1;'),
      run(value, 'store("second",2);globalThis.second=2;'),
    ]);
    expect(
      jsonOutput(
        await run(
          value,
          'text([load("first"),load("second"),typeof first,typeof second]);',
        ),
      ),
    ).toEqual([1, 2, "undefined", "undefined"]);
  });

  it("keeps running cells alive when sibling cells complete and preserves their startup snapshots", async () => {
    const value = service();
    await run(value, 'store("version",1);');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reader = await value.exec({
      source: 'await tools.gate({});text(load("version"));',
      sessionScope: "conversation-a",
      yieldTimeMs: 0,
      tools: [
        {
          name: "gate",
          description: "测试同步点",
          call: async () => {
            await gate;
            return null;
          },
        },
      ],
    });
    await run(value, 'store("version",2);');
    release();
    const result = await value.wait({
      cellId: cellId(reader),
      sessionScope: "conversation-a",
    });
    expect(jsonOutput(result)).toBe(1);
    expect(jsonOutput(await run(value, 'text(load("version"));'))).toBe(2);
  });

  it("cancels one exec without closing its conversation or a sibling cell", async () => {
    const value = service();
    await run(value, 'store("keep",10);');
    const sibling = await value.exec({
      source:
        'yield_control();await new Promise(r=>setTimeout(r,200));text("alive");',
      tools: [],
      sessionScope: "conversation-a",
    });
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const controller = new AbortController();
    const execution = value.exec({
      source: "await tools.started({});await new Promise(()=>{});",
      sessionScope: "conversation-a",
      signal: controller.signal,
      tools: [
        {
          name: "started",
          description: "测试同步点",
          call: async () => {
            started();
            return null;
          },
        },
      ],
    });
    const observed = expect(execution).rejects.toThrow();
    await running;
    controller.abort();
    await observed;
    expect(jsonOutput(await run(value, 'text(load("keep"));'))).toBe(10);
    expect(
      texts(
        await value.wait({
          cellId: cellId(sibling),
          sessionScope: "conversation-a",
        }),
      ).join("\n"),
    ).toContain("alive");
  });

  it("rejects mismatched or missing wait scope without consuming the cell", async () => {
    const value = service();
    const first = await value.exec({
      source: 'yield_control();text("kept");',
      tools: [],
      sessionScope: "conversation-a",
    });
    const id = cellId(first);
    await expect(
      value.wait({ cellId: id, sessionScope: "conversation-b" }),
    ).rejects.toThrow("其他");
    await expect(value.wait({ cellId: id })).rejects.toThrow("其他");
    expect(
      texts(
        await value.wait({ cellId: id, sessionScope: "conversation-a" }),
      ).join("\n"),
    ).toContain("kept");
  });

  it("refreshes per-exec tool bindings while retaining conversation data", async () => {
    const value = service();
    await value.exec({
      source: 'store("old",await tools.old({}));',
      sessionScope: "conversation-a",
      tools: [{ name: "old", description: "旧工具", call: async () => 1 }],
    });
    const next = await value.exec({
      source:
        'text({old:typeof tools.old,names:ALL_TOOLS.map(t=>t.name),value:load("old"),fresh:await tools.fresh({})});',
      sessionScope: "conversation-a",
      tools: [{ name: "fresh", description: "新工具", call: async () => 2 }],
    });
    expect(jsonOutput(next)).toEqual({
      old: "undefined",
      names: ["fresh"],
      value: 1,
      fresh: 2,
    });
  });

  it("does not reset storage on a pre-dispatch tool catalog error", async () => {
    const value = service();
    await run(value, 'store("keep",5);');
    const tool = {
      name: "duplicate",
      description: "重复工具测试",
      call: async () => null,
    };
    await expect(
      value.exec({
        source: "text(1);",
        tools: [tool, tool],
        sessionScope: "conversation-a",
      }),
    ).rejects.toThrow("duplicate");
    expect(jsonOutput(await run(value, 'text(load("keep"));'))).toBe(5);
  });

  it("expires idle storage but never expires an unconsumed cell", async () => {
    const value = service(250);
    await run(value, 'store("cached",7);');
    const pending = await value.exec({
      source: 'yield_control();text("final");',
      tools: [],
      sessionScope: "conversation-a",
    });
    await pause(550);
    expect(jsonOutput(await run(value, 'text(load("cached"));'))).toBe(7);
    await value.wait({
      cellId: cellId(pending),
      sessionScope: "conversation-a",
    });
    await pause(550);
    expect(
      jsonOutput(await run(value, 'text(load("cached")===undefined);')),
    ).toBe(true);
  });
});

describe("session lease ownership", () => {
  it("gives cells distinct native sessions and closes late openings during shutdown", async () => {
    let finish!: (session: CodeModeSession) => void;
    let opens = 0,
      closes = 0;
    const opening = new Promise<CodeModeSession>((resolve) => {
      finish = resolve;
    });
    const pool = new SessionPool(async () => {
      opens++;
      return opening;
    });
    pools.push(pool);
    const first = pool.acquire("a"),
      second = pool.acquire("a");
    const firstCheck = expect(first).rejects.toThrow("失效");
    const secondCheck = expect(second).rejects.toThrow("失效");
    const closing = pool.close();
    finish({
      usable: true,
      close: async () => {
        closes++;
      },
    } as CodeModeSession);
    await Promise.all([firstCheck, secondCheck, closing]);
    expect(opens).toBe(2);
    expect(closes).toBe(2);
  });

  it("does not cache a session that failed during its opening handshake", async () => {
    let opens = 0,
      closes = 0;
    const pool = new SessionPool(
      async () =>
        ({
          usable: ++opens > 1,
          close: async () => {
            closes++;
          },
        }) as CodeModeSession,
    );
    pools.push(pool);
    await expect(pool.acquire("a")).rejects.toThrow("失效");
    const next = await pool.acquire("a");
    expect(next.session.usable).toBe(true);
    next.release();
    await pool.close();
    expect(opens).toBe(2);
    expect(closes).toBe(2);
  });

  it("a failed open can be retried without retaining a rejected promise", async () => {
    let opens = 0;
    const session = { usable: true, close: async () => {} } as CodeModeSession;
    const pool = new SessionPool(async () => {
      if (++opens === 1) throw new Error("open failed");
      return session;
    });
    pools.push(pool);
    await expect(pool.acquire("a")).rejects.toThrow("open failed");
    const lease = await pool.acquire("a");
    expect(lease.session).toBe(session);
    lease.release();
    expect(opens).toBe(2);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import {
  ConversationStore,
  storeEntryBytes,
  STORE_IDLE_MS,
} from "../src/code-mode/conversation-store.js";
import { CodeModeService } from "../src/code-mode/service.js";
import { cellId, jsonOutput, texts } from "./helpers.js";
import { connect } from "./helpers.js";

const caches: ConversationStore[] = [];
const services: CodeModeService[] = [];
afterEach(async () => {
  caches.splice(0).forEach((cache) => cache.close());
  await Promise.all(services.splice(0).map((service) => service.close()));
});
function cache(
  options: ConstructorParameters<typeof ConversationStore>[0] = {},
  now?: () => number,
) {
  const value = new ConversationStore(options, now);
  caches.push(value);
  return value;
}
function service(
  options: ConstructorParameters<typeof CodeModeService>[0] = {},
) {
  const value = new CodeModeService(options);
  services.push(value);
  return value;
}
const run = (value: CodeModeService, source: string, scope = "conversation") =>
  value.exec({ source, tools: [], sessionScope: scope });

describe("bounded conversation data retention", () => {
  it("keeps idle data for three days rather than half an hour, and refreshes the idle clock", () => {
    let now = 0;
    const value = cache({}, () => now);
    const first = value.begin("a");
    first.commit([["value", "7"]]);
    first.release();
    now = 2 * 24 * 60 * 60 * 1000;
    value.sweep();
    expect(value.usage.keys).toBe(1);
    const read = value.begin("a");
    expect(read.snapshot).toEqual([["value", "7"]]);
    read.release();
    now += STORE_IDLE_MS - 1;
    value.sweep();
    expect(value.usage.keys).toBe(1);
    now++;
    value.sweep();
    expect(value.usage).toMatchObject({ conversations: 0, bytes: 0, keys: 0 });
  });
  it("does not expire pinned active snapshots even after three days", () => {
    let now = 0;
    const value = cache({}, () => now);
    const pending = value.begin("a");
    pending.commit([["pending", "1"]]);
    now += STORE_IDLE_MS * 2;
    value.sweep();
    expect(value.usage.keys).toBe(1);
    pending.release();
    now += STORE_IDLE_MS;
    value.sweep();
    expect(value.usage.keys).toBe(0);
  });
  it("charges replacement rather than append history, and deletion releases bytes", () => {
    const value = cache({ sessionBytes: 1000, totalBytes: 1000 });
    for (let i = 0; i < 10_000; i++) {
      const transaction = value.begin("a");
      transaction.commit([["key", '"value"']]);
      transaction.release();
    }
    expect(value.usage).toMatchObject({
      conversations: 1,
      keys: 1,
      bytes: storeEntryBytes("key", '"value"'),
    });
    const remove = value.begin("a");
    remove.commit([["key", null]]);
    remove.release();
    expect(value.usage).toMatchObject({ conversations: 0, keys: 0, bytes: 0 });
  });
  it("reclaims whole least-recently-used idle conversations under pressure, never active ones", () => {
    let now = 0;
    const bytes = storeEntryBytes("x", '"value"');
    const value = cache(
      { sessionBytes: bytes, totalBytes: bytes * 2 },
      () => ++now,
    );
    const a = value.begin("a");
    a.commit([["x", '"value"']]);
    a.release();
    const b = value.begin("b");
    b.commit([["x", '"value"']]);
    b.release();
    const active = value.begin("a");
    const c = value.begin("c");
    c.commit([["x", '"value"']]);
    c.release();
    expect(value.usage).toMatchObject({
      keys: 2,
      bytes: bytes * 2,
      pressure_evictions: 1,
      pinned_conversations: 1,
    });
    const missed = value.begin("b");
    expect(missed.snapshot).toEqual([]);
    missed.release();
    expect(active.snapshot).toEqual([["x", '"value"']]);
    active.release();
  });
  it("refuses growth atomically when all reclaim candidates are active", () => {
    const bytes = storeEntryBytes("x", '"value"');
    const value = cache({ sessionBytes: bytes, totalBytes: bytes * 2 });
    const a = value.begin("a"),
      b = value.begin("b"),
      c = value.begin("c");
    a.commit([["x", '"value"']]);
    b.commit([["x", '"value"']]);
    const before = value.usage;
    expect(() => c.commit([["x", '"value"']])).toThrow("空闲缓存不足");
    expect(value.usage).toEqual(before);
    a.release();
    b.release();
    c.release();
  });
  it("checks the merged state of concurrent writers instead of trusting both startup snapshots", () => {
    const value = cache({ maxKeys: 1, sessionBytes: 4096, totalBytes: 4096 });
    const first = value.begin("a"),
      second = value.begin("a");
    first.commit([["first", "1"]]);
    expect(() => second.commit([["second", "2"]])).toThrow("并发合并");
    first.release();
    second.release();
    const reader = value.begin("a");
    expect(reader.snapshot).toEqual([["first", "1"]]);
    reader.release();
  });
  it("bounds conversation metadata and refuses malformed journals without modifying existing data", () => {
    const value = cache({ maxConversations: 2 });
    const a = value.begin("a"),
      b = value.begin("b");
    a.commit([["keep", "42"]]);
    expect(() => value.begin("c")).toThrow("空闲缓存不足");
    expect(() =>
      a.commit([
        ["keep", "1"],
        ["keep", "2"],
      ]),
    ).toThrow("重复键");
    expect(() => a.commit([["bad", "not JSON"]])).toThrow();
    expect(value.usage.keys).toBe(1);
    a.release();
    b.release();
  });
  it("plateaus under thousands of new conversation IDs, not just repeated keys", () => {
    const value = cache({
      sessionBytes: 1000,
      totalBytes: 3000,
      maxConversations: 4,
    });
    for (let i = 0; i < 5000; i++) {
      const tx = value.begin(String(i));
      tx.commit([["key", '"value"']]);
      tx.release();
      expect(value.usage.bytes).toBeLessThanOrEqual(3000);
      expect(value.usage.conversations).toBeLessThanOrEqual(4);
    }
    expect(value.usage.pressure_evictions).toBeGreaterThan(4000);
  });
});

describe("bounded synchronous helpers on the real pinned host", () => {
  it("can delete the last key when the cache is exactly full", async () => {
    const bytes = storeEntryBytes("key", "0");
    const value = service({
      storeLimits: { sessionBytes: bytes, totalBytes: bytes, maxKeys: 1 },
    });
    expect((await run(value, 'store("key",0);')).isError).not.toBe(true);
    const removed = await run(value, "store.clear();");
    expect(removed.isError, JSON.stringify(removed)).not.toBe(true);
    expect(value.resources.store.bytes).toBe(0);
  });
  it("retains exit/error writes while allowing explicit delete, clear and local usage inspection", async () => {
    const value = service();
    const first = await run(
      value,
      'store("data",{n:1});exit();store("never",1);',
    );
    expect(first.isError, JSON.stringify(first)).not.toBe(true);
    expect(
      jsonOutput(
        await run(
          value,
          'text([load("data"),typeof load("never"),store.stats().keys]);',
        ),
      ),
    ).toEqual([{ n: 1 }, "undefined", 1]);
    await run(value, 'store("other",2);store.delete("data");');
    expect(
      jsonOutput(
        await run(value, 'text([typeof load("data"),load("other")]);'),
      ),
    ).toEqual(["undefined", 2]);
    await run(value, "store.clear();");
    expect(value.resources.store).toMatchObject({ keys: 0, bytes: 0 });
  });
  it("rejects an oversized write synchronously without losing earlier values or leaking an internal tool", async () => {
    const value = service({
      storeLimits: { sessionBytes: 1024, totalBytes: 2048, maxKeys: 4 },
    });
    await run(value, 'store("safe",7);');
    const result = await run(
      value,
      'try {store("large","x".repeat(2000));}catch(e){text(e.message);}text([load("safe"),typeof load("large")]);',
    );
    expect(result.isError).not.toBe(true);
    expect(texts(result).join("\n")).toContain("配额");
    expect(jsonOutput(result)).toEqual([7, "undefined"]);
    const check = await run(
      value,
      "text({names:ALL_TOOLS.map(t=>t.name),keys:Object.keys(tools),stats:store.stats()});",
    );
    expect(jsonOutput(check)).toMatchObject({
      names: [],
      keys: [],
      stats: { keys: 1, max_bytes: 1024 },
    });
    expect(value.resources.store.bytes).toBeLessThanOrEqual(1024);
  });
  it("charges Unicode/escape-heavy values identically in the isolate and the server", async () => {
    const value = service();
    const content = { text: "中文😀\\\n\u0000", nested: [null, true, 42] };
    const result = await run(
      value,
      `store("键😀",${JSON.stringify(content)});text(store.stats());`,
    );
    const local = jsonOutput<{ bytes: number }>(result);
    expect(local.bytes).toBe(value.resources.store.bytes);
    expect(jsonOutput(await run(value, 'text(load("键😀"));'))).toEqual(
      content,
    );
  });
  it("does not let a value's toJSON hook corrupt quota accounting via builtin prototypes", async () => {
    const value = service({
      storeLimits: { sessionBytes: 1024, totalBytes: 2048 },
    });
    const result = await run(
      value,
      `
      const hostile = {toJSON() {
        Map.prototype.has = () => false;
        Map.prototype.get = () => undefined;
        Map.prototype.set = () => undefined;
        Array.prototype.toJSON = () => [];
        return "x".repeat(2000);
      }};
      try { store("large", hostile); } catch(e) { text("bounded"); }
      store("small", 7);
    `,
    );
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(texts(result)).toContain("bounded");
    expect(
      jsonOutput(
        await run(value, 'text([load("small"),typeof load("large")]);'),
      ),
    ).toEqual([7, "undefined"]);
    expect(value.resources.store.bytes).toBeLessThan(1024);
  });
  it("publishes a finished background cell only when its completion is collected", async () => {
    const value = service();
    const writer = await run(value, 'store("late",5);yield_control();');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(
      jsonOutput(await run(value, 'text(load("late")===undefined);')),
    ).toBe(true);
    await value.wait({ cellId: cellId(writer), sessionScope: "conversation" });
    expect(jsonOutput(await run(value, 'text(load("late"));'))).toBe(5);
  });
  it("reports a concurrent commit limit without replacing already committed data", async () => {
    const value = service({
      storeLimits: { sessionBytes: 1024, totalBytes: 2048, maxKeys: 1 },
    });
    let count = 0,
      release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tool = {
      name: "gate",
      description: "同步测试",
      call: async () => {
        if (++count === 2) release();
        await gate;
        return null;
      },
    };
    const results = await Promise.all(
      ["one", "two"].map((key) =>
        value.exec({
          source: `store(${JSON.stringify(key)},7);await tools.gate({});`,
          sessionScope: "conversation",
          tools: [tool],
        }),
      ),
    );
    expect(results.filter((result) => result.isError)).toHaveLength(1);
    expect(
      texts(results.find((result) => result.isError)!).join("\n"),
    ).toContain("工具副作用不回滚");
    expect(value.resources.store.keys).toBe(1);
  });
  it("cannot accumulate forever inside one cell, and subsequent cells remain usable", async () => {
    const value = service({
      storeLimits: { sessionBytes: 4096, totalBytes: 8192, maxKeys: 8 },
    });
    const result = await run(
      value,
      'for(let i=0;i<10000;i++)store("key"+i,"value");',
    );
    expect(result.isError).toBe(true);
    expect(texts(result).join("\n")).toContain("配额");
    expect(value.resources.store.keys).toBe(8);
    expect(value.resources.store.bytes).toBeLessThanOrEqual(4096);
    await run(value, 'store.clear();store("fresh",1);');
    expect(jsonOutput(await run(value, 'text(load("fresh"));'))).toBe(1);
  });
  it("keeps pending cell count bounded without killing old cells just because time passes", async () => {
    const value = service({ maxCells: 2 });
    const first = await value.exec({
      source: 'store("a",1);yield_control();await new Promise(()=>{});',
      tools: [],
      sessionScope: "a",
    });
    const second = await value.exec({
      source: 'store("b",2);yield_control();await new Promise(()=>{});',
      tools: [],
      sessionScope: "b",
    });
    await expect(run(value, "text(42);", "c")).rejects.toThrow("未执行新脚本");
    expect(value.resources.active_cells).toBe(2);
    expect(value.resources.store.keys).toBe(0);
    await value.wait({
      cellId: cellId(first),
      sessionScope: "a",
      terminate: true,
    });
    await value.wait({
      cellId: cellId(second),
      sessionScope: "b",
      terminate: true,
    });
    for (let i = 0; i < 100 && value.resources.active_cells; i++)
      await new Promise((r) => setTimeout(r, 10));
    expect(value.resources.active_cells).toBe(0);
    expect(jsonOutput(await run(value, "text(42);"))).toBe(42);
  });
  it("does not expose private journal data even when public output is truncated", async () => {
    const value = service();
    const result = await value.exec({
      source: 'store("private","secret payload");text("public");',
      tools: [],
      sessionScope: "a",
      maxOutputTokens: 0,
    });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result)).not.toContain("secret payload");
    expect(
      jsonOutput(await run(value, 'text({value:load("private")});', "a")),
    ).toEqual({ value: "secret payload" });
  });
  it("exposes only aggregate resource counters in readiness diagnostics", async () => {
    const c = await connect();
    try {
      await c.client.callTool({
        name: "exec",
        arguments: { source: 'store("PRIVATE_KEY", "PRIVATE_VALUE");' },
        _meta: { "openai/session": "private-conversation" },
      });
      const response = await fetch(c.url.replace("/mcp", "/readyz"));
      const raw = await response.text();
      expect(raw).not.toMatch(/PRIVATE_KEY|PRIVATE_VALUE|private-conversation/);
      expect(JSON.parse(raw)).toMatchObject({
        status: "ready",
        code_mode: {
          store: { keys: 1, conversations: 1, idle_ms: STORE_IDLE_MS },
        },
      });
    } finally {
      await c.close();
    }
  });
});

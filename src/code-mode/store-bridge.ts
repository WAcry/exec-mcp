import type { CodeModeSession } from "./session.js";
import type { CodeModeToolDefinition } from "./types.js";
import type {
  StoreLease,
  StoreLimits,
  StoreWrite,
} from "./conversation-store.js";
import { STORE_ENTRY_OVERHEAD } from "./conversation-store.js";
import { randomHandle } from "../util.js";

const KEYS = "\u0000exec-mcp/store-keys";
const VALUES = "\u0000exec-mcp/store-value/";

/** Keep the synchronous helper API; use the pinned host only for a bounded per-cell write journal. */
export function storeBridge(
  lease: StoreLease,
  limits: StoreLimits,
): { source: string; tool: CodeModeToolDefinition } {
  const name = randomHandle("__store_snapshot").replaceAll("-", "_");
  const tool: CodeModeToolDefinition = {
    name,
    description: "内部存储快照传递，不向 Agent 暴露。",
    call: async () => ({
      entries: lease.snapshot,
      bytes: limits.sessionBytes,
      keys: limits.maxKeys,
    }),
  };
  const source = `await (async () => {
    const init = tools[${JSON.stringify(name)}];
    delete tools[${JSON.stringify(name)}];
    const index = ALL_TOOLS.findIndex(t => t.name === ${JSON.stringify(name)});
    if (index >= 0) ALL_TOOLS.splice(index, 1);
    const spec = await init({});
    const stringify = JSON.stringify.bind(JSON), parse = JSON.parse.bind(JSON);
    const nativeStore = globalThis.store;
    const values = new Map(spec.entries), dirty = new Map();
    const bind = fn => Function.prototype.call.bind(fn);
    const get = bind(Map.prototype.get), has = bind(Map.prototype.has), set = bind(Map.prototype.set);
    const remove = bind(Map.prototype.delete), each = bind(Map.prototype.forEach), at = bind(String.prototype.charCodeAt);
    let keyCount = values.size, writeCount = 0;
    // Count JSON strings without invoking user-modifiable Array.prototype.toJSON.
    const encodedStringBytes = s => {
      let bytes = 2;
      for (let i = 0; i < s.length; i++) {
        const c = at(s, i);
        if (c === 34 || c === 92) bytes += 2;
        else if (c < 32) bytes += (c === 8 || c === 9 || c === 10 || c === 12 || c === 13) ? 2 : 6;
        else if (c < 128) bytes++;
        else if (c < 2048) bytes += 2;
        else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && at(s, i + 1) >= 0xdc00 && at(s, i + 1) <= 0xdfff) { bytes += 4; i++; }
        else if (c >= 0xd800 && c <= 0xdfff) bytes += 6;
        else bytes += 3;
      }
      return bytes;
    };
    const cost = (key, json) => 3 + encodedStringBytes(key) + (json === null ? 4 : encodedStringBytes(json)) + ${STORE_ENTRY_OVERHEAD};
    let bytes = 0, writeBytes = 0;
    for (const [key, json] of values) bytes += cost(key, json);
    const checkKey = key => { if (typeof key !== "string") throw new TypeError("store/load 的 key 必须是字符串。"); };
    const update = (key, json) => {
      checkKey(key);
      if (json === null && !has(values, key) && !has(dirty, key)) return;
      const old = has(values, key) ? cost(key, get(values, key)) : 0;
      const nextBytes = bytes - old + (json === null ? 0 : cost(key, json));
      const nextKeys = keyCount + (json === null ? (has(values, key) ? -1 : 0) : (has(values, key) ? 0 : 1));
      const nextWriteBytes = writeBytes - (has(dirty, key) ? cost(key, get(dirty, key)) : 0) + cost(key, json);
      if (nextBytes > spec.bytes || nextKeys > spec.keys || nextWriteBytes > spec.bytes + spec.keys * 4 || (!has(dirty, key) && writeCount >= spec.keys * 2))
        throw new Error("store 配额已满；本次写入未保存，请用 store.delete(key) 释放不用的数据，或把大数据写入文件。");
      // Only bounded strings enter native storage; no persistent native object graph.
      nativeStore(${JSON.stringify(VALUES)} + key, json);
      if (!has(dirty, key)) {
        let manifest = "[";
        each(dirty, (_value, existing) => { manifest += stringify(existing) + ","; });
        nativeStore(${JSON.stringify(KEYS)}, manifest + stringify(key) + "]");
        writeCount++;
      }
      set(dirty, key, json);
      if (json === null) remove(values, key); else set(values, key, json);
      bytes = nextBytes; writeBytes = nextWriteBytes; keyCount = nextKeys;
    };
    const store = (key, value) => {
      checkKey(key);
      const json = stringify(value);
      if (json === undefined) throw new TypeError("store 仅接收可序列化的 JSON 值；删除请用 store.delete(key)。");
      update(key, json);
    };
    store.delete = key => { const existed = has(values, key); update(key, null); return existed; };
    store.clear = () => { each(values, (_value, key) => update(key, null)); };
    store.stats = () => ({ bytes, keys: keyCount, max_bytes: spec.bytes, max_keys: spec.keys });
    Object.freeze(store);
    Object.defineProperty(globalThis, "store", { value: store, writable: false, configurable: false });
    Object.defineProperty(globalThis, "load", { value: key => { checkKey(key); return has(values, key) ? parse(get(values, key)) : undefined; }, writable: false, configurable: false });
  })();\n`;
  return { source, tool };
}

/** Read a completed cell's private journal, never mix it with model-facing output. */
export async function collectStoreWrites(
  session: CodeModeSession,
): Promise<StoreWrite[]> {
  let result = await session.execute({
    source: `const keys = JSON.parse(load(${JSON.stringify(KEYS)}) ?? "[]"); text(keys.map(key => [key, load(${JSON.stringify(VALUES)} + key)]));`,
    tools: [],
    toolCallId: randomHandle("store_commit"),
    yieldTimeMs: 10_000,
  });
  if (result.state === "yielded")
    result = await session.wait({
      cellId: result.cellId,
      yieldTimeMs: 110_000,
    });
  if (
    result.state !== "completed" ||
    result.errorText ||
    result.items.length !== 1 ||
    result.items[0]?.type !== "text"
  )
    throw new Error("无法收取 store 写入记录；已有缓存未改写。");
  const writes: unknown = JSON.parse(result.items[0].text);
  if (!Array.isArray(writes)) throw new Error("store 写入记录无效。");
  return writes as StoreWrite[];
}

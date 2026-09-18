import { afterEach, describe, expect, it } from "vitest";
import {
  CodeModeService,
  DEFAULT_WAIT_YIELD_TIME_MS,
  MAX_WAIT_YIELD_TIME_MS,
} from "../src/code-mode/service.js";
import type { CodeModeToolDefinition } from "../src/code-mode/types.js";
import { cellId, jsonOutput, texts } from "./helpers.js";
const services: CodeModeService[] = [];
function service(): CodeModeService {
  const value = new CodeModeService();
  services.push(value);
  return value;
}
afterEach(async () => {
  await Promise.all(services.splice(0).map((item) => item.close()));
});

describe("pinned real Code Mode host", () => {
  it("runs isolated JavaScript with complete discovery contracts", async () => {
    const tool: CodeModeToolDefinition = {
      name: "echo",
      description: "输入：{n:number}。返回数字。",
      call: async (args) => args,
    };
    const result = await service().exec({
      source:
        "text({catalog:ALL_TOOLS, n:await tools.echo({n:4}), hidden:[typeof notify,typeof store,typeof load]});",
      tools: [tool],
    });
    expect(jsonOutput(result)).toEqual({
      catalog: [{ name: "echo", description: tool.description }],
      n: { n: 4 },
      hidden: ["undefined", "function", "function"],
    });
  });
  it("supports freeform strings and concurrent nested calls", async () => {
    let concurrent = 0;
    let max = 0;
    const tool: CodeModeToolDefinition = {
      name: "patch",
      kind: "freeform",
      description: "接收字符串。",
      call: async (args) => {
        concurrent++;
        max = Math.max(max, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 40));
        concurrent--;
        return args;
      },
    };
    const result = await service().exec({
      source: 'text(await Promise.all([tools.patch("a"),tools.patch("b")]));',
      tools: [tool],
    });
    expect(jsonOutput(result)).toEqual(["a", "b"]);
    expect(max).toBe(2);
  });
  it("uses 110 seconds as the wait default and maximum, returning early on completion", async () => {
    expect(DEFAULT_WAIT_YIELD_TIME_MS).toBe(110_000);
    expect(MAX_WAIT_YIELD_TIME_MS).toBe(110_000);
    const value = service();
    const result = await value.exec({
      source:
        'text("progress"); await new Promise(r=>setTimeout(r,150)); text("done");',
      tools: [],
      yieldTimeMs: 0,
    });
    const start = Date.now();
    const completed = await value.wait({ cellId: cellId(result) });
    expect(Date.now() - start).toBeLessThan(3000);
    expect(texts(completed).join("\n")).toContain("done");
    await expect(
      value.wait({ cellId: "missing", yieldTimeMs: 110_001 }),
    ).rejects.toThrow();
  });
  it("reports script errors without replaying previous effects", async () => {
    let calls = 0;
    const result = await service().exec({
      source: 'await tools.effect({}); throw new Error("after effect");',
      tools: [
        { name: "effect", description: "计数", call: async () => ++calls },
      ],
    });
    expect(result.isError).toBe(true);
    expect(calls).toBe(1);
    expect(texts(result).join("\n")).toContain("after effect");
  });
  it("cancels a wait without cancelling the running cell", async () => {
    const value = service();
    const first = await value.exec({
      source: 'await new Promise(r=>setTimeout(r,350)); text("survived");',
      tools: [],
      yieldTimeMs: 0,
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 50);
    await expect(
      value.wait({ cellId: cellId(first), signal: controller.signal }),
    ).rejects.toThrow();
    clearTimeout(timer);
    const result = await value.wait({ cellId: cellId(first) });
    expect(texts(result).join("\n")).toContain("survived");
  });
  it("terminates pending work explicitly and supports later execs", async () => {
    const value = service();
    const result = await value.exec({
      source: "await new Promise(()=>{});",
      tools: [],
      yieldTimeMs: 0,
    });
    expect(
      texts(await value.wait({ cellId: cellId(result), terminate: true })).join(
        "\n",
      ),
    ).toContain("terminated");
    expect(
      jsonOutput(await value.exec({ source: "text(42)", tools: [] })),
    ).toBe(42);
  });
  it("never retains ordinary JS globals across exec calls", async () => {
    const value = service();
    await value.exec({ source: "globalThis.answer = 42;", tools: [] });
    expect(
      jsonOutput(
        await value.exec({ source: "text({type:typeof answer})", tools: [] }),
      ),
    ).toEqual({ type: "undefined" });
  });
  it("does not silently truncate more than 10,000 characters", async () => {
    const result = await service().exec({
      source: 'text("a".repeat(20000))',
      tools: [],
    });
    expect(texts(result).at(-1)).toBe("a".repeat(20_000));
  });
});

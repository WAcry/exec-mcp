import { afterEach, describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { CodeModeService } from "../src/code-mode/service.js";
import { cellId, connect, jsonOutput, texts } from "./helpers.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
function service() {
  const value = new CodeModeService();
  cleanup.push(() => value.close());
  return value;
}
function settlements(result: CallToolResult): unknown[] {
  return texts(result).flatMap((text) => {
    try {
      return [JSON.parse(text) as unknown];
    } catch {
      return [];
    }
  });
}

describe("native promise settlement helpers", () => {
  it.each(["as_settled", "stream_settled"])(
    "%s preserves partial results while a nested call is pending",
    async (helper) => {
      const value = service();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let calls = 0;
      try {
        const source = [
          'const jobs = [tools.slow({}), Promise.resolve("fast"), Promise.reject("failure")];',
          helper === "as_settled"
            ? "for await (const result of as_settled(jobs)) { text(result); yield_control(); }"
            : "await stream_settled(jobs, result => { text(result); yield_control(); });",
        ].join("\n");
        let response = await value.exec({
          source,
          tools: [
            {
              name: "slow",
              description: "Controlled pending result",
              call: async () => {
                calls++;
                await gate;
                return "slow";
              },
            },
          ],
        });
        const id = cellId(response);
        const partial = settlements(response);
        while (partial.length < 2) {
          response = await value.wait({ cellId: id, yieldTimeMs: 1000 });
          expect(response.isError).not.toBe(true);
          partial.push(...settlements(response));
        }
        expect(partial).toEqual([
          { index: 1, status: "fulfilled", value: "fast" },
          { index: 2, status: "rejected", reason: "failure" },
        ]);
        expect(calls).toBe(1);
        release();
        const remaining: unknown[] = [];
        do {
          response = await value.wait({ cellId: id, yieldTimeMs: 5000 });
          expect(response.isError).not.toBe(true);
          remaining.push(...settlements(response));
        } while (texts(response)[0]!.startsWith("Script running"));
        expect(remaining).toEqual([
          { index: 0, status: "fulfilled", value: "slow" },
        ]);
        expect(calls).toBe(1);
      } finally {
        release();
      }
    },
  );

  it("keeps Map keys and settlement order while awaiting each consumer", async () => {
    const result = await service().exec({
      tools: [],
      source: [
        "const order = []; let concurrent = 0, maximum = 0;",
        'const jobs = new Map([["slow", new Promise(r=>setTimeout(()=>r(3),30))], ["fast", Promise.resolve(1)], ["bad", Promise.reject("E")]]);',
        "await stream_settled(jobs, async item => { concurrent++; maximum=Math.max(maximum,concurrent); order.push(item); await new Promise(r=>setTimeout(r,50)); concurrent--; });",
        "let completed = false;",
        "const pending = new Promise(r=>setTimeout(()=>{completed=true;r(2);},20));",
        "for await (const item of as_settled([Promise.resolve(1),pending])) { break; }",
        "await pending;",
        "text({order,maximum,completed,notify:typeof notify});",
      ].join("\n"),
    });
    expect(result.isError).not.toBe(true);
    expect(jsonOutput(result)).toEqual({
      order: [
        { index: "fast", status: "fulfilled", value: 1 },
        { index: "bad", status: "rejected", reason: "E" },
        { index: "slow", status: "fulfilled", value: 3 },
      ],
      maximum: 1,
      completed: true,
      notify: "undefined",
    });
  });

  it("handles empty iterables, plain values and callback failures without extra tools", async () => {
    const result = await service().exec({
      tools: [],
      source: [
        "const empty=[]; for await (const item of as_settled([])) empty.push(item);",
        "const values=[]; await stream_settled(new Set([1,2]), item=>values.push(item));",
        'let failure; try {await stream_settled([1], ()=>{throw new Error("consumer failed")});} catch(e) {failure=String(e);}',
        "text({empty,values,failure,catalog:ALL_TOOLS});",
      ].join("\n"),
    });
    expect(jsonOutput(result)).toEqual({
      empty: [],
      values: [
        { index: 0, status: "fulfilled", value: 1 },
        { index: 1, status: "fulfilled", value: 2 },
      ],
      failure: "Error: consumer failed",
      catalog: [],
    });
  });
});

describe.each([false, true])("settlements over MCP (legacy=%s)", (legacy) => {
  it("delivers progressive output exactly once through the existing exec and wait tools", async () => {
    const connection = await connect({}, legacy);
    cleanup.push(() => connection.close());
    const tools = (await connection.client.listTools()).tools;
    expect(tools.map((t) => t.name)).toEqual(["exec", "wait"]);
    expect(tools[0]!.description).toContain("as_settled(promises)");
    expect(tools[0]!.description).toContain("stream_settled(promises, emit)");
    let response = await connection.client.callTool({
      name: "exec",
      arguments: {
        source: [
          'const jobs = new Map([["slow", new Promise(r=>setTimeout(()=>r("done"),100))],["fast", Promise.resolve("ready")]]);',
          "await stream_settled(jobs, item=>{text(item);yield_control();});",
        ].join("\n"),
      },
    });
    const output = settlements(response);
    while (texts(response)[0]!.startsWith("Script running")) {
      response = await connection.client.callTool({
        name: "wait",
        arguments: { cell_id: cellId(response) },
      });
      expect(response.isError).not.toBe(true);
      output.push(...settlements(response));
    }
    expect(output).toEqual([
      { index: "fast", status: "fulfilled", value: "ready" },
      { index: "slow", status: "fulfilled", value: "done" },
    ]);
  });
});

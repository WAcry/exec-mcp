import { afterEach, describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { CodeModeService } from "../src/code-mode/service.js";
import {
  boundModelOutput,
  MODEL_TEXT_BYTES,
} from "../src/code-mode/model-output.js";
import {
  cellId,
  texts,
  jsonOutput,
  connect,
  nodeCommand,
  observeTerminal,
} from "./helpers.js";
import { TerminalManager } from "../src/host/terminal.js";
import type { TerminalResult } from "../src/host/terminal.js";

const services: CodeModeService[] = [];
const terminals: TerminalManager[] = [];
const clients: Awaited<ReturnType<typeof connect>>[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(services.splice(0).map((service) => service.close()));
  await Promise.all(terminals.splice(0).map((terminal) => terminal.close()));
});
const total = (result: CallToolResult) =>
  Buffer.byteLength(texts(result).join("\n\n"));
function service() {
  const value = new CodeModeService();
  services.push(value);
  return value;
}

describe("conservative model-bound text, separate from tool data", () => {
  it("retains status, first/last text and every media/resource block under the combined byte ceiling", () => {
    const input: CallToolResult = {
      content: [
        { type: "text", text: "Script running with cell ID cell-fixture\n" },
        { type: "text", text: "BEGIN" + "中文😀".repeat(30000) },
        { type: "image", data: "fake", mimeType: "image/png" },
        { type: "text", text: "last".repeat(30000) + "END" },
        { type: "resource_link", uri: "resource://fixture", name: "fixture" },
      ],
    };
    const result = boundModelOutput(input);
    expect(total(result)).toBeLessThanOrEqual(MODEL_TEXT_BYTES);
    expect(texts(result).join("\n")).toMatch(
      /cell-fixture[\s\S]*BEGIN[\s\S]*END/,
    );
    expect(texts(result).join("")).not.toContain("\ufffd");
    expect(result.content.filter((item) => item.type !== "text")).toEqual(
      input.content.filter((item) => item.type !== "text"),
    );
    expect(
      input.content[1]!.type === "text" && input.content[1]!.text.length,
    ).toBeGreaterThan(100000);
  });
  it("also bounds thousands of small items and does not duplicate a structured result", () => {
    const result = boundModelOutput({
      content: Array.from({ length: 20000 }, () => ({
        type: "text" as const,
        text: "x",
      })),
    });
    expect(total(result)).toBeLessThanOrEqual(MODEL_TEXT_BYTES);
    expect(result.structuredContent).toBeUndefined();
    expect(result.content.length).toBeLessThan(10);
  });
  it("preserves a large raw nested result for selection and store/load without replaying the tool", async () => {
    const host = service();
    let calls = 0;
    const raw =
      "BEGIN\n" +
      "filler\n".repeat(30000) +
      "MIDDLE_ERROR\n" +
      "filler\n".repeat(30000) +
      "END";
    const tools = [
      {
        name: "large",
        description: "fixture",
        call: async () => {
          calls++;
          return { output: raw };
        },
      },
    ];
    const first = await host.exec({
      sessionScope: "large-data",
      tools,
      source:
        'const r=await tools.large({});store("raw",r);text({size:r.output.length,middle:r.output.includes("MIDDLE_ERROR")});',
    });
    expect(jsonOutput(first)).toEqual({ size: raw.length, middle: true });
    const oversized = await host.exec({
      sessionScope: "large-data",
      tools,
      maxOutputTokens: 1_000_000,
      source: 'text(load("raw").output);',
    });
    expect(total(oversized)).toBeLessThanOrEqual(MODEL_TEXT_BYTES);
    expect(texts(oversized).join("\n")).toContain("保留首尾");
    const later = await host.exec({
      sessionScope: "large-data",
      tools,
      source:
        'const r=load("raw");text(r.output.split("\\n").filter(line=>line.includes("ERROR")));',
    });
    expect(jsonOutput(later)).toEqual(["MIDDLE_ERROR"]);
    expect(calls).toBe(1);
  });
  it("bounds both yield and wait independently and keeps later incremental output", async () => {
    const host = service();
    const first = await host.exec({
      source:
        'text("FIRST"+"x".repeat(100000)+"FIRST_END");yield_control();await new Promise(r=>setTimeout(r,60));text("LAST"+"y".repeat(100000)+"LAST_END");',
      tools: [],
    });
    expect(total(first)).toBeLessThanOrEqual(MODEL_TEXT_BYTES);
    const last = await host.wait({
      cellId: cellId(first),
      maxTokens: 1_000_000,
    });
    expect(total(last)).toBeLessThanOrEqual(MODEL_TEXT_BYTES);
    expect(texts(last).join("\n")).toContain("LAST_END");
    expect(texts(last).join("\n")).not.toContain("FIRST_END");
  });
  it("keeps a multi-megabyte middle error for code-side inspection before model summarization", async () => {
    const terminal = new TerminalManager();
    terminals.push(terminal);
    const command = nodeCommand(
      'process.stdout.write("H".repeat(2*1024*1024)+"MIDDLE_ERROR"+"T".repeat(1024*1024));',
    );
    const result = await observeTerminal(
      await terminal.execCommand(
        { cmd: command, yield_time_ms: 0 },
        process.cwd(),
      ),
      (input) => terminal.writeStdin(input),
    );
    expect(result.output.length).toBe(3 * 1024 * 1024 + "MIDDLE_ERROR".length);
    expect(result.output).toContain("MIDDLE_ERROR");
    expect(result.truncated).toBeUndefined();
  });
  it("distinguishes script completion, nonzero command exit and stderr output with zero exit", async () => {
    const client = await connect();
    clients.push(client);
    const code = nodeCommand(
      'process.stderr.write("stderr fixture\\n");process.stdout.write("stdout fixture\\n");',
    );
    const result = await client.client.callTool({
      name: "exec",
      arguments: {
        source: `text(await tools.exec_command(${JSON.stringify({ cmd: code, yield_time_ms: 30000 })}));`,
      },
    });
    expect(result.isError).not.toBe(true);
    expect(jsonOutput<TerminalResult>(result)).toMatchObject({
      exit_code: 0,
      stderr_bytes: Buffer.byteLength("stderr fixture\n"),
    });
    const fail = await client.client.callTool({
      name: "exec",
      arguments: {
        source:
          'text(await tools.exec_command({cmd:"exit 1",yield_time_ms:30000}));',
      },
    });
    expect(fail.isError).not.toBe(true);
    expect(texts(fail)[0]).toContain("Script completed");
    expect(jsonOutput<TerminalResult>(fail).exit_code).toBe(1);
  });
});

describe("large command content is available before final model output filtering", () => {
  it("finds an error in the middle of a 3 MiB terminal result rather than clipping it before Code Mode sees it", async () => {
    const { connect, jsonOutput, nodeCommand } = await import("./helpers.js");
    const connection = await connect();
    try {
      const cmd = nodeCommand(
        'process.stdout.write("A".repeat(1500000)+"\\nERROR_MIDDLE_42\\n"+"B".repeat(1500000));',
      );
      const result = await connection.client.callTool({
        name: "exec",
        arguments: {
          source: `const r=await tools.exec_command({cmd:${JSON.stringify(cmd)},yield_time_ms:30000});text({found:r.output.includes("ERROR_MIDDLE_42"),length:r.output.length,truncated:r.truncated??false,exit:r.exit_code});`,
        },
      });
      expect(result.isError).not.toBe(true);
      expect(jsonOutput(result)).toEqual({
        found: true,
        length: 3000017,
        truncated: false,
        exit: 0,
      });
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(1000);
    } finally {
      await connection.close();
    }
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { CodeModeService } from "../src/code-mode/service.js";
import { cellId, connect, jsonOutput, texts } from "./helpers.js";

const services: CodeModeService[] = [];
const connections: Awaited<ReturnType<typeof connect>>[] = [];
afterEach(async () => {
  await Promise.all(
    connections.splice(0).map((connection) => connection.close()),
  );
  await Promise.all(services.splice(0).map((service) => service.close()));
});
function service() {
  const value = new CodeModeService();
  services.push(value);
  return value;
}

/** 16-bit mono PCM; optionally use a streaming header whose declared size exceeds its bytes. */
function wav(samples: number, declaredBytes = samples * 2): string {
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + declaredBytes, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16_000, 24);
  buffer.writeUInt32LE(32_000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(declaredBytes, 40);
  return buffer.toString("base64");
}

describe("pinned Codex runtime compatibility", () => {
  it("delivers omitted and explicit undefined arguments without a JSON serialization failure", async () => {
    const calls: unknown[] = [];
    const result = await service().exec({
      source:
        "text(await Promise.all([tools.echo(),tools.echo(undefined),tools.echo({}),tools.echo(null)]));",
      tools: [
        {
          name: "echo",
          description: "回显收到的参数。",
          call: async (input) => {
            calls.push(input);
            return {
              kind:
                input === undefined
                  ? "undefined"
                  : input === null
                    ? "null"
                    : "object",
            };
          },
        },
      ],
    });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(jsonOutput(result)).toEqual([
      { kind: "undefined" },
      { kind: "undefined" },
      { kind: "object" },
      { kind: "null" },
    ]);
    expect(calls).toEqual([undefined, undefined, {}, null]);
  });

  it("rejects storing undefined with a meaningful error and keeps the prior value across execs", async () => {
    const value = service();
    const result = await value.exec({
      sessionScope: "undefined-value",
      tools: [],
      source:
        'store("key",null);try{store("key",undefined)}catch(error){text(String(error));}text({value:load("key")});',
    });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(
      texts(result).some((text) =>
        text.includes("Only plain serializable objects can be stored"),
      ),
    ).toBe(true);
    expect(jsonOutput(result)).toEqual({ value: null });
    const later = await value.exec({
      sessionScope: "undefined-value",
      tools: [],
      source: 'text({value:load("key")});',
    });
    expect(jsonOutput(later)).toEqual({ value: null });
  });

  it.each(["url", "object", "block"])(
    "preserves surrounding output when the native audio helper omits a short WAV (%s)",
    async (shape) => {
      const data = wav(399); // 24.9375 ms at 16 kHz; just below the native threshold.
      const url = `data:audio/wav;base64,${data}`;
      const argument =
        shape === "url"
          ? url
          : shape === "object"
            ? { audio_url: url }
            : { type: "audio", mimeType: "audio/wav", data };
      const result = await service().exec({
        tools: [],
        source: `text("before");audio(${JSON.stringify(argument)});text("after");`,
      });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(result.content.filter((item) => item.type === "audio")).toEqual(
        [],
      );
      const output = texts(result);
      expect(output.slice(1)).toEqual([
        "before",
        "Audio output omitted because the clip is shorter than 25 ms; use a longer clip.",
        "after",
      ]);
    },
  );

  it.each([400, 800])(
    "retains WAV audio at or above 25 ms (%s samples)",
    async (samples) => {
      const data = wav(samples);
      const result = await service().exec({
        tools: [],
        source: `audio({type:"audio",mimeType:"audio/wav",data:${JSON.stringify(data)}});`,
      });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(result.content.filter((item) => item.type === "audio")).toEqual([
        { type: "audio", mimeType: "audio/wav", data },
      ]);
    },
  );

  it("measures available PCM bytes rather than an oversized streaming WAV header", async () => {
    const data = wav(160, 32_000); // 10 ms of actual data, despite a one-second header.
    const result = await service().exec({
      tools: [],
      source: `audio("data:audio/wav;base64,${data}");`,
    });
    expect(result.isError).not.toBe(true);
    expect(result.content.some((item) => item.type === "audio")).toBe(false);
    expect(texts(result).join("\n")).toContain("shorter than 25 ms");
  });

  it("leaves unrecognized audio formats to the native forwarding behavior", async () => {
    const data = Buffer.from("unknown-format-fixture").toString("base64");
    const result = await service().exec({
      tools: [],
      source: `audio({type:"audio",mimeType:"audio/mpeg",data:${JSON.stringify(data)}});`,
    });
    expect(result.isError).not.toBe(true);
    expect(result.content.filter((item) => item.type === "audio")).toEqual([
      { type: "audio", mimeType: "audio/mpeg", data },
    ]);
  });
});

describe.each([false, true])("upgraded host over MCP (legacy=%s)", (legacy) => {
  it("preserves native audio rules and incremental output after yield_control", async () => {
    const connection = await connect({}, legacy);
    connections.push(connection);
    const short = wav(160),
      full = wav(400);
    const first = await connection.client.callTool({
      name: "exec",
      arguments: {
        source: `text("progress");yield_control();await new Promise(r=>setTimeout(r,100));audio("data:audio/wav;base64,${short}");audio("data:audio/wav;base64,${full}");text("finished");`,
      },
    });
    const final = await connection.client.callTool({
      name: "wait",
      arguments: { cell_id: cellId(first) },
    });
    expect(final.isError, JSON.stringify(final)).not.toBe(true);
    expect(final.structuredContent).toBeUndefined();
    const output = [...first.content, ...final.content];
    expect(output.filter((item) => item.type === "audio")).toEqual([
      { type: "audio", mimeType: "audio/wav", data: full },
    ]);
    expect(
      output.filter((item) => item.type === "text" && item.text === "progress"),
    ).toHaveLength(1);
    expect(texts(final).join("\n")).toContain("shorter than 25 ms");
    expect(texts(final)).toContain("finished");
  });
});

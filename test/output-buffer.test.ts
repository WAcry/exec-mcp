import { describe, expect, it } from "vitest";
import { RollingOutputBuffer } from "../src/host/output-buffer.js";

const marker =
  /\n\[中间已省略 \d+ 字节；输出已滚动截断，不能通过后续读取恢复\]\n/g;
function raw(output: string): string {
  return output.replace(marker, "");
}
function drain(buffer: RollingOutputBuffer, size = 4096) {
  let output = "",
    omitted = 0,
    calls = 0;
  while (buffer.pending) {
    const part = buffer.read(size);
    output += part.output;
    omitted += part.omitted_bytes ?? 0;
    if (++calls > 10000) throw new Error("buffer failed to drain");
  }
  return { output, omitted };
}

describe("bounded oldest-prefix/newest-tail output", () => {
  it("preserves ordinary output completely and releases it after incremental reads", () => {
    const buffer = new RollingOutputBuffer(4096);
    const content = "first\n汉😀test\nlast\n";
    for (const character of content) buffer.append(character);
    expect(buffer.bytes).toBe(Buffer.byteLength(content));
    const result = drain(buffer, 5);
    expect(result).toEqual({ output: content, omitted: 0 });
    expect(buffer.bytes).toBe(0);
    expect(buffer.allocatedBytes).toBe(0);
    expect(buffer.read(10)).toEqual({ output: "" });
  });
  it("keeps a startup prefix and the newest tail rather than pausing or retaining the middle", () => {
    const buffer = new RollingOutputBuffer(1024);
    const input = "HEAD:" + "a".repeat(2000) + "TAIL";
    buffer.append(input);
    expect(buffer.bytes).toBe(1024);
    expect(buffer.omittedBytes).toBe(Buffer.byteLength(input) - 1024);
    const result = buffer.read(1024);
    expect(result).toMatchObject({
      truncated: true,
      omitted_bytes: input.length - 1024,
    });
    expect(raw(result.output)).toBe(input.slice(0, 64) + input.slice(-960));
    expect(result.output).toContain("不能通过后续读取恢复");
    expect(buffer.pending).toBe(false);
  });
  it("rolls forward for unlimited writes, preserving the first unread prefix", () => {
    const buffer = new RollingOutputBuffer(4096);
    let expected = "";
    for (let i = 0; i < 5000; i++) {
      const chunk = `${String(i).padStart(6, "0")} ${"x".repeat(57)}\n`;
      expected += chunk;
      buffer.append(chunk);
      expect(buffer.bytes).toBeLessThanOrEqual(4096);
      expect(buffer.allocatedBytes).toBeLessThanOrEqual(4096 + 2 * 16 * 1024);
    }
    const result = drain(buffer, 128);
    expect(raw(result.output)).toBe(
      expected.slice(0, 256) + expected.slice(-3840),
    );
    expect(result.omitted).toBe(expected.length - 4096);
  });
  it("coalesces many one-character writes instead of retaining a separate allocation per append", () => {
    const buffer = new RollingOutputBuffer(1024);
    for (let i = 0; i < 100_000; i++) buffer.append("x");
    expect(buffer.bytes).toBe(1024);
    expect(buffer.allocatedBytes).toBeLessThanOrEqual(2048);
    expect(buffer.omittedBytes).toBe(100_000 - 1024);
  });
  it("does not retain a large source backing buffer through a tiny slice", () => {
    const buffer = new RollingOutputBuffer(1024);
    buffer.append("b".repeat(2 * 1024 * 1024));
    expect(buffer.allocatedBytes).toBeLessThanOrEqual(2048);
    const result = drain(buffer);
    expect(raw(result.output)).toBe("b".repeat(1024));
    expect(result.omitted).toBe(2 * 1024 * 1024 - 1024);
  });
  it("never repeats a delivered header and never inserts newer bytes before old unread tail data", () => {
    const buffer = new RollingOutputBuffer(128);
    buffer.append("old-start-" + "a".repeat(80));
    const first = buffer.read(16);
    buffer.append("NEW-END");
    const rest = drain(buffer, 7);
    expect(first.output + rest.output).toBe(
      "old-start-" + "a".repeat(80) + "NEW-END",
    );
    buffer.append("second-batch");
    expect(drain(buffer).output).toBe("second-batch");
  });
  it("keeps a marker at the gap, even when a large configured buffer needs multiple reads", () => {
    const buffer = new RollingOutputBuffer(8192);
    buffer.append("H".repeat(512) + "x".repeat(40_000) + "T".repeat(7680));
    const first = buffer.read(256);
    expect(first).toEqual({ output: "H".repeat(256) });
    const second = buffer.read(256);
    expect(second).toEqual({ output: "H".repeat(256) });
    const last = drain(buffer, 4096);
    expect(last.output.startsWith("\n[中间已省略")).toBe(true);
    expect(raw(last.output)).toBe("T".repeat(7680));
    expect(last.omitted).toBe(40_000);
  });
  it("retains UTF-8 code point boundaries on both sides and counts omitted bytes rather than characters", () => {
    for (const capacity of [64, 65, 127, 1024, 4097]) {
      const buffer = new RollingOutputBuffer(capacity);
      const text = "汉😀ñ🇨🇳".repeat(3000);
      const characters = [...text];
      for (let i = 0; i < characters.length; i += 17)
        buffer.append(characters.slice(i, i + 17).join(""));
      const result = drain(buffer, 11);
      const kept = raw(result.output);
      expect(kept).not.toContain("\ufffd");
      expect(Buffer.byteLength(kept) + result.omitted).toBe(
        Buffer.byteLength(text),
      );
      const [head, tail] = result.output.split(marker);
      expect(text.startsWith(head!)).toBe(true);
      expect(text.endsWith(tail!)).toBe(true);
      expect(Buffer.byteLength(kept)).toBeLessThanOrEqual(capacity);
    }
  });
  it("does not need newlines to bound output and never rewrites incomplete structured data as valid JSON", () => {
    const buffer = new RollingOutputBuffer(128);
    buffer.append(JSON.stringify({ text: "hello".repeat(1000) }));
    const result = drain(buffer);
    expect(result.output).toContain("已滚动截断");
    expect(() => JSON.parse(result.output)).toThrow();
    expect(buffer.allocatedBytes).toBe(0);
  });
  it("matches a simple whole-string model across changing read/append schedules", () => {
    for (const capacity of [64, 80, 257, 4096]) {
      const buffer = new RollingOutputBuffer(capacity);
      for (let batch = 0; batch < 100; batch++) {
        const text = [...Array(5 + batch)]
          .map((_, i) => `b${batch}i${i}:` + "漢😀".repeat(i % 11))
          .join("");
        buffer.append(text);
        const result = drain(buffer, 4 + (batch % 64));
        expect(Buffer.byteLength(raw(result.output)) + result.omitted).toBe(
          Buffer.byteLength(text),
        );
        expect(result.output).not.toContain("\ufffd");
      }
    }
  });
});

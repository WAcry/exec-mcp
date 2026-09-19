import { describe, expect, it } from "vitest";
import { readProcessMemory } from "../src/host/process-memory.js";
import { MEMORY_SCHEMA, MEMORY_DEFAULTS } from "../src/memory.js";
import { CONFIG_TEMPLATE, parseConfig } from "../src/config.js";

describe("owned-process memory measurement", () => {
  it("reads actual resident memory on this operating system without inspecting descendants", async () => {
    const before = process.memoryUsage().rss;
    const bytes = await readProcessMemory(process.pid);
    const after = process.memoryUsage().rss;
    expect(Number.isSafeInteger(bytes)).toBe(true);
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeGreaterThan(Math.min(before, after) / 2);
    expect(bytes).toBeLessThan(Math.max(before, after) * 2 + 16 * 1024 * 1024);
  });
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid PID %s without executing a probe",
    async (pid) => {
      await expect(readProcessMemory(pid)).rejects.toThrow("进程标识无效");
    },
  );
});

describe("small memory configuration surface", () => {
  it("has a 4 GiB host threshold, 72 hour retention, and 1 MiB per-terminal buffer by default", () => {
    expect(MEMORY_SCHEMA.parse({})).toEqual(MEMORY_DEFAULTS);
    expect(
      parseConfig(CONFIG_TEMPLATE + "\n[memory]\n", "config.toml").memory,
    ).toEqual(MEMORY_DEFAULTS);
    expect(
      parseConfig(
        CONFIG_TEMPLATE +
          "\n[memory]\ncode_mode_high_water_mib=8192\nidle_retention_hours=96\nterminal_buffer_mib=4\n",
        "config.toml",
      ).memory,
    ).toEqual({
      code_mode_high_water_mib: 8192,
      idle_retention_hours: 96,
      terminal_buffer_mib: 4,
    });
    expect(parseConfig(CONFIG_TEMPLATE, "config.toml").memory).toBeUndefined();
  });
  it.each([
    "code_mode_high_water_mib=0",
    "idle_retention_hours=-1",
    "terminal_buffer_mib=0.5",
    "terminal_buffer_mib=9007199254740991",
    'idle_retention_hours="72"',
    "per_cell_limit=32",
  ])("rejects invalid or unsupported policy: %s", (entry) => {
    expect(() =>
      parseConfig(CONFIG_TEMPLATE + `\n[memory]\n${entry}\n`, "config.toml"),
    ).toThrow("memory");
  });
});

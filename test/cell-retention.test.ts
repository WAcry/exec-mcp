import { afterEach, describe, expect, it, vi } from "vitest";
import { CodeModeService } from "../src/code-mode/service.js";
import { cellId, texts } from "./helpers.js";

const services: CodeModeService[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(services.splice(0).map((service) => service.close()));
});
function service(sessionIdleMs: number) {
  const value = new CodeModeService({ sessionIdleMs });
  services.push(value);
  return value;
}
const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("yielded cells follow idle retention", () => {
  it("stops a cell that no wait call observes and releases its session", async () => {
    const value = service(200);
    const scope = "abandoned-cell";
    const first = await value.exec({
      source: "await new Promise(() => {});",
      tools: [],
      yieldTimeMs: 0,
      sessionScope: scope,
    });
    const id = cellId(first);
    const deadline = Date.now() + 5_000;
    while (
      value.getNativeSessions().some((session) => session.users > 0) &&
      Date.now() < deadline
    )
      await pause(25);
    expect(value.getNativeSessions().filter((s) => s.users > 0)).toEqual([]);
    await expect(
      value.wait({ cellId: id, sessionScope: scope }),
    ).rejects.toThrow(/no wait call observed it/);
  });

  it("keeps a cell while a wait call observes it longer than the idle period", async () => {
    const value = service(200);
    const first = await value.exec({
      source:
        'await new Promise((resolve) => setTimeout(resolve, 800)); text("done");',
      tools: [],
      yieldTimeMs: 0,
    });
    const result = await value.wait({
      cellId: cellId(first),
      yieldTimeMs: 5_000,
    });
    expect(texts(result)[0]).toContain("Script completed");
    expect(texts(result).join("\n")).toContain("done");
  });
});

describe("host failures are visible to the operator", () => {
  it("logs an unexpected host exit to stderr by default", async () => {
    const value = new CodeModeService();
    services.push(value);
    await value.exec({ source: "text(1);", tools: [] });
    const { hostPid } = await value.getMemoryStatus();
    expect(hostPid).toBeTypeOf("number");
    const lines: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    vi.spyOn(process.stderr, "write").mockImplementation(((
      chunk: string | Uint8Array,
      ...rest: unknown[]
    ) => {
      lines.push(String(chunk));
      return (write as (...args: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stderr.write);
    process.kill(hostPid!, "SIGKILL");
    const deadline = Date.now() + 5_000;
    while (
      !lines.some((line) => line.includes("stopped unexpectedly")) &&
      Date.now() < deadline
    )
      await pause(20);
    // Windows terminates the process with exit code 1 and reports no signal.
    const reason =
      process.platform === "win32" ? "exit code 1" : "signal SIGKILL";
    expect(lines.join("")).toContain(
      `codex-code-mode-host stopped unexpectedly (${reason})`,
    );
  });
});

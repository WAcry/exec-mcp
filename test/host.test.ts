import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TerminalManager } from "../src/host/terminal.js";
import { PatchRunner } from "../src/host/patch.js";
import { nodeCommand } from "./helpers.js";
const terminals: TerminalManager[] = [];
const patches: PatchRunner[] = [];
const directories: string[] = [];
async function directory(): Promise<string> {
  const value = await mkdtemp(path.join(tmpdir(), "exec mcp 测试-"));
  directories.push(value);
  return value;
}
function terminal(): TerminalManager {
  const value = new TerminalManager();
  terminals.push(value);
  return value;
}
afterEach(async () => {
  await Promise.all(terminals.splice(0).map((value) => value.close()));
  await Promise.all(patches.splice(0).map((value) => value.close()));
  await Promise.all(
    directories
      .splice(0)
      .map((value) => rm(value, { recursive: true, force: true })),
  );
});
describe("real local processes", () => {
  it("executes under the requested directory and retains exit status", async () => {
    const cwd = await directory();
    const result = await terminal().execCommand(
      {
        cmd: nodeCommand(
          'process.stdout.write(process.cwd()); process.stderr.write("\\nerr"); process.exitCode=7;',
        ),
      },
      cwd,
    );
    expect(result.output).toContain(cwd);
    expect(result.output).toContain("err");
    expect(result.exit_code).toBe(7);
  });
  it("keeps an interactive pipe across calls, including stdin EOF", async () => {
    const value = terminal();
    const cwd = await directory();
    const first = await value.execCommand(
      {
        cmd: nodeCommand(
          'let input="";process.stdin.on("data",x=>input+=x);process.stdin.on("end",()=>process.stdout.write(input));',
        ),
        yield_time_ms: 0,
      },
      cwd,
    );
    expect(first.session_id).toBeDefined();
    const result = await value.writeStdin({
      session_id: first.session_id!,
      chars: "hello😀",
      close_stdin: true,
      yield_time_ms: 3000,
    });
    expect(result.output).toBe("hello😀");
    expect(result.exit_code).toBe(0);
  });
  it("reads Unicode output in lossless increments instead of truncating", async () => {
    const value = terminal();
    const first = await value.execCommand(
      { cmd: nodeCommand('process.stdout.write("汉😀".repeat(350000))') },
      await directory(),
    );
    let output = first.output;
    let id = first.session_id;
    for (let count = 0; id && count < 30; count++) {
      const part = await value.writeStdin({
        session_id: id,
        yield_time_ms: 1000,
      });
      output += part.output;
      id = part.session_id;
    }
    expect(id).toBeUndefined();
    expect(output).toBe("汉😀".repeat(350000));
  });
  it("terminates an owned process and yields a final result", async () => {
    const value = terminal();
    const first = await value.execCommand(
      { cmd: nodeCommand("setInterval(()=>{},1000)"), yield_time_ms: 0 },
      await directory(),
    );
    const result = await value.writeStdin({
      session_id: first.session_id!,
      terminate: true,
    });
    expect(result.exit_code).toBeDefined();
    expect(result.session_id).toBeUndefined();
  });
  it("supports native PTY input and resize", async () => {
    const value = terminal();
    const first = await value.execCommand(
      {
        cmd: nodeCommand(
          'console.log("READY");process.stdin.once("data",x=>{console.log("GOT:"+x.toString().trim());process.exit(0)})',
        ),
        tty: true,
        yield_time_ms: 500,
      },
      await directory(),
    );
    expect(first.session_id).toBeDefined();
    let result = await value.writeStdin({
      session_id: first.session_id!,
      chars: "hello\r",
      cols: 80,
      rows: 24,
      yield_time_ms: 2000,
    });
    let output = result.output;
    if (result.session_id) {
      result = await value.writeStdin({
        session_id: result.session_id,
        yield_time_ms: 2000,
      });
      output += result.output;
    }
    expect(output).toContain("GOT:hello");
  });
});
describe("pinned freeform patch engine", () => {
  it("creates, updates, moves and deletes files without a UI wrapper", async () => {
    const cwd = await directory();
    const runner = new PatchRunner();
    patches.push(runner);
    expect(
      (
        await runner.apply(
          "*** Begin Patch\n*** Add File: 示例.txt\n+before\n*** End Patch\n",
          cwd,
        )
      ).success,
    ).toBe(true);
    expect(await readFile(path.join(cwd, "示例.txt"), "utf8")).toBe("before\n");
    expect(
      (
        await runner.apply(
          "*** Begin Patch\n*** Update File: 示例.txt\n*** Move to: nested/after.txt\n@@\n-before\n+after\n*** End Patch\n",
          cwd,
        )
      ).success,
    ).toBe(true);
    expect(await readFile(path.join(cwd, "nested/after.txt"), "utf8")).toBe(
      "after\n",
    );
    expect(
      (
        await runner.apply(
          "*** Begin Patch\n*** Delete File: nested/after.txt\n*** End Patch\n",
          cwd,
        )
      ).success,
    ).toBe(true);
  });
  it("rejects an invalid envelope before starting the engine", async () => {
    const runner = new PatchRunner();
    patches.push(runner);
    await expect(
      runner.apply("not a patch", await directory()),
    ).rejects.toThrow("envelope");
  });
});

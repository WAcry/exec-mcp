import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import {
  captureProcessTree,
  terminateProcessTree,
} from "../src/host/platform.js";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function until(predicate: () => boolean, timeout = 5000) {
  const deadline = performance.now() + timeout;
  while (!predicate()) {
    if (performance.now() >= deadline)
      throw new Error("The process did not reach the expected state.");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
function exited(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve) => child.once("close", () => resolve()));
}

describe.runIf(process.platform !== "win32")("owned process trees", () => {
  it("forces a process group that ignores the first request", async () => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        'process.on("SIGTERM",()=>{});console.log("ready");setInterval(()=>{},1000)',
      ],
      { detached: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    await new Promise((resolve) => child.stdout!.once("data", resolve));
    const closed = exited(child);
    const began = performance.now();
    expect(
      await terminateProcessTree(child.pid!, closed, { graceMs: 100 }),
    ).toBe(true);
    expect(performance.now() - began).toBeGreaterThanOrEqual(90);
    expect(child.signalCode).toBe("SIGKILL");
  });

  it("reaps descendants of a child that is not a process-group leader", async () => {
    const parent = spawn(
      process.execPath,
      [
        "-e",
        `const {spawn}=require("node:child_process");
const grandchild=spawn(process.execPath,["-e","process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:"ignore"});
console.log(grandchild.pid);setInterval(()=>{},1000);`,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    const grandchild = Number(
      await new Promise<string>((resolve) =>
        parent.stdout!.once("data", (chunk) => resolve(String(chunk))),
      ),
    );
    const tree = await captureProcessTree(parent.pid!);
    expect(tree.pids).toEqual([parent.pid, grandchild]);

    // The owner closes only its direct child, as the MCP SDK does.
    const closed = exited(parent);
    parent.kill("SIGKILL");
    await closed;
    expect(alive(grandchild)).toBe(true);

    await tree.reap({ graceMs: 100 });
    await until(() => !alive(grandchild));
  });

  it("returns an empty tree for a process that does not exist", async () => {
    const tree = await captureProcessTree(2 ** 30);
    expect(tree.pids).toEqual([]);
    await expect(tree.reap()).resolves.toBeUndefined();
  });
});

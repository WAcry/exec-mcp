import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { resolveCodexBinary } from "../codex-package.js";
import { MAX_PAYLOAD_BYTES } from "../limits.js";
import { AsyncMutex, throwIfAborted, waitUntil } from "../util.js";
import { terminateProcessTree } from "./platform.js";

export class PatchRunner {
  private locks = new Map<string, { mutex: AsyncMutex; users: number }>();
  private active = new Set<AbortController>();
  private pending = new Set<Promise<unknown>>();
  private closed = false;
  async apply(
    patch: string,
    workdir: string,
    signal?: AbortSignal,
  ): Promise<{ success: boolean; exit_code: number; output: string }> {
    if (this.closed) throw new Error("补丁执行器已关闭。");
    throwIfAborted(signal);
    const cwd = await realpath(workdir);
    const lock = this.locks.get(cwd) ?? { mutex: new AsyncMutex(), users: 0 };
    this.locks.set(cwd, lock);
    lock.users++;
    const operation = lock.mutex.run(async () => {
      if (this.closed) throw new Error("补丁执行器已关闭。");
      throwIfAborted(signal);
      if (
        !patch.startsWith("*** Begin Patch\n") ||
        !patch.trimEnd().endsWith("*** End Patch")
      )
        throw new Error("补丁需要完整的 Begin Patch / End Patch envelope。");
      if (Buffer.byteLength(patch) > MAX_PAYLOAD_BYTES)
        throw new Error("补丁超过传输大小限制，尚未执行。");
      const abort = new AbortController();
      this.active.add(abort);
      const combined = signal
        ? AbortSignal.any([signal, abort.signal])
        : abort.signal;
      try {
        return await this.run(patch, cwd, combined);
      } finally {
        this.active.delete(abort);
      }
    });
    this.pending.add(operation);
    try {
      return await operation;
    } finally {
      this.pending.delete(operation);
      if (--lock.users === 0) this.locks.delete(cwd);
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const controller of this.active) controller.abort();
    await Promise.allSettled(this.pending);
  }
  private async run(
    patch: string,
    cwd: string,
    signal: AbortSignal,
  ): Promise<{ success: boolean; exit_code: number; output: string }> {
    // The Codex argv0 dispatch enters its standalone patch engine, not an agent loop.
    const child = spawn(resolveCodexBinary("codex"), [], {
      argv0: "apply_patch",
      cwd,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: "pipe",
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let overflow = false;
    const collect = (chunk: Buffer): void => {
      bytes += chunk.length;
      if (bytes <= MAX_PAYLOAD_BYTES) chunks.push(chunk);
      else overflow = true;
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.stdin.on("error", () => {});
    const done = new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 1));
    });
    child.stdin.end(patch);
    let exitCode: number;
    try {
      const completed = await waitUntil(done, 110_000, signal);
      if (completed === undefined) throw new Error("补丁执行超时。");
      exitCode = completed;
    } catch (error) {
      if (child.pid !== undefined) {
        await terminateProcessTree(child.pid);
        if (
          (await waitUntil(
            done.catch(() => 1),
            750,
          )) === undefined
        )
          await terminateProcessTree(child.pid, true);
      }
      await done.catch(() => undefined);
      throw new Error(
        "补丁执行被中断，可能已经部分生效；请检查文件后再决定下一步。",
        { cause: error },
      );
    }
    if (overflow)
      throw new Error(
        "补丁结果超过传输边界，文件可能已修改；未截断交付或自动重试。",
      );
    return {
      success: exitCode === 0,
      exit_code: exitCode,
      output: Buffer.concat(chunks).toString("utf8").trim(),
    };
  }
}

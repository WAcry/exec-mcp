import { spawn } from "node:child_process";
import { terminateProcessTree } from "./platform.js";

/** Own only this foreground child, with native argv and normal inherited terminal IO. */
export async function runForeground(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  options: { signal?: AbortSignal; onStarted?: () => void } = {},
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  options.signal?.throwIfAborted();
  const child = spawn(file, args, {
    env,
    stdio: "inherit",
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  let closed = false;
  const exited = new Promise<void>((resolve) => {
    const done = () => {
      closed = true;
      resolve();
    };
    child.once("close", done);
    child.once("error", done);
  });
  let stop: Promise<void> | undefined;
  const abort = () => {
    if (!child.pid || closed || stop) return;
    const pid = child.pid;
    stop = (async () => {
      await terminateProcessTree(pid);
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          exited,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 3000);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (!closed) await terminateProcessTree(pid, true);
    })();
    void stop.catch(() => undefined);
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  try {
    return await new Promise((resolve, reject) => {
      child.once("spawn", () => {
        if (options.signal?.aborted) abort();
        else {
          try {
            options.onStarted?.();
          } catch {
            abort();
            reject(new Error("客户端启动回调失败。"));
          }
        }
      });
      child.once("error", () =>
        reject(new Error("客户端启动失败；请检查可执行文件和权限。")),
      );
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
  } finally {
    options.signal?.removeEventListener("abort", abort);
    await stop;
  }
}

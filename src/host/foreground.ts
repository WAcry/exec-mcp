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
    stop = terminateProcessTree(child.pid, exited, {
      graceMs: 3000,
      confirmMs: 0,
    }).then(() => undefined);
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
            reject(new Error("The client start callback failed."));
          }
        }
      });
      child.once("error", () =>
        reject(
          new Error(
            "The client failed to start. Check the executable path and its permissions.",
          ),
        ),
      );
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
  } finally {
    options.signal?.removeEventListener("abort", abort);
    await stop;
  }
}

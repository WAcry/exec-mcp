import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
export type MemoryReader = (pid: number) => Promise<number>;

/** Approximate resident memory of exactly one owned host, never its process tree. */
export const readProcessMemory: MemoryReader = async (pid) => {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("进程标识无效。");
  try {
    let text: string;
    let multiplier = 1;
    if (process.platform === "linux") {
      const status = await readFile(`/proc/${pid}/status`, "utf8");
      text = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status)?.[1] ?? "";
      multiplier = 1024;
    } else if (process.platform === "darwin") {
      const output = await run("/bin/ps", ["-o", "rss=", "-p", String(pid)], {
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: 16 * 1024,
      });
      text = output.stdout.trim();
      multiplier = 1024;
    } else if (process.platform === "win32") {
      const file = path.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      const output = await run(
        file,
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$p = Get-Process -Id ${pid} -ErrorAction Stop; [Console]::WriteLine($p.WorkingSet64.ToString([Globalization.CultureInfo]::InvariantCulture))`,
        ],
        {
          windowsHide: true,
          encoding: "utf8",
          timeout: 5000,
          maxBuffer: 16 * 1024,
        },
      );
      text = output.stdout.trim();
    } else throw new Error("unsupported platform");
    if (!/^\d+$/.test(text)) throw new Error("invalid reading");
    const bytes = Number(text) * multiplier;
    if (!Number.isSafeInteger(bytes) || bytes <= 0)
      throw new Error("invalid reading");
    return bytes;
  } catch {
    // A missing/blocked measurement is not evidence of excessive memory usage.
    throw new Error("无法读取 Code Mode host 内存；本次不进行压力回收。");
  }
};

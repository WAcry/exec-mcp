import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export function configDirectory(
  platform = process.platform as string,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  if (platform === "win32")
    return path.join(
      env.APPDATA ?? path.join(home, "AppData", "Roaming"),
      "exec-mcp",
    );
  if (platform === "darwin")
    return path.join(home, "Library", "Application Support", "exec-mcp");
  return path.join(
    env.XDG_CONFIG_HOME ?? path.join(home, ".config"),
    "exec-mcp",
  );
}

function validPid(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 0)
    throw new Error("The process ID of an owned process is not valid.");
}

function windowsTool(...parts: string[]): string {
  return path.join(process.env.SystemRoot ?? "C:\\Windows", ...parts);
}

/** Send one signal to an owned process group (POSIX) or process tree (Windows). */
async function signalProcessTree(pid: number, force: boolean): Promise<void> {
  if (process.platform === "win32") {
    try {
      await run(
        windowsTool("System32", "taskkill.exe"),
        ["/PID", String(pid), "/T", "/F"],
        { windowsHide: true },
      );
    } catch (error) {
      try {
        process.kill(pid, 0);
      } catch {
        return;
      }
      throw error;
    }
    return;
  }
  try {
    process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function settledWithin(
  settled: Promise<true>,
  ms: number,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      settled,
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), Math.max(0, ms));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Stop a process that this runtime started as a process-group leader
 * (POSIX `detached`) or any owned process tree on Windows. Ask first, force
 * after graceMs, then wait up to confirmMs. Resolves true when `exited` settled.
 * Only processes created by this runtime are passed here.
 */
export async function terminateProcessTree(
  pid: number,
  exited: Promise<unknown>,
  options: { graceMs?: number; confirmMs?: number } = {},
): Promise<boolean> {
  validPid(pid);
  const { graceMs = 750, confirmMs = 3000 } = options;
  const settled = exited.then(
    () => true as const,
    () => true as const,
  );
  await signalProcessTree(pid, false);
  if (await settledWithin(settled, graceMs)) return true;
  await signalProcessTree(pid, true);
  return settledWithin(settled, confirmMs);
}

interface ProcessEntry {
  ppid: number;
  /** Start time or creation date; protects against a reused process ID. */
  identity: string;
}
type ProcessTable = Map<number, ProcessEntry>;

async function linuxProcesses(): Promise<ProcessTable> {
  const table: ProcessTable = new Map();
  const names = (await readdir("/proc")).filter((name) => /^\d+$/.test(name));
  await Promise.all(
    names.map(async (name) => {
      try {
        const stat = await readFile(`/proc/${name}/stat`, "utf8");
        // The command name can contain spaces and parentheses; fields after
        // the last ")" start with field 3 (state). ppid is field 4, starttime 22.
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        // A zombie has already exited and only waits for its parent to reap it.
        if (fields[0] === "Z") return;
        const ppid = Number(fields[1]);
        const start = fields[19];
        if (Number.isSafeInteger(ppid) && start)
          table.set(Number(name), { ppid, identity: start });
      } catch {
        /* The process exited during the scan. */
      }
    }),
  );
  return table;
}

async function darwinProcesses(): Promise<ProcessTable> {
  const { stdout } = await run(
    "/bin/ps",
    ["-A", "-o", "pid=", "-o", "ppid=", "-o", "lstart="],
    { encoding: "utf8", timeout: 5000, maxBuffer: 8 * 1024 * 1024 },
  );
  const table: ProcessTable = new Map();
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S.*?)\s*$/.exec(line);
    if (match)
      table.set(Number(match[1]), {
        ppid: Number(match[2]),
        identity: match[3]!,
      });
  }
  return table;
}

async function windowsProcesses(): Promise<ProcessTable> {
  const { stdout } = await run(
    windowsTool("System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_Process | ForEach-Object { [Console]::WriteLine(('{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.ToFileTimeUtc())) }",
    ],
    {
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    },
  );
  const table: ProcessTable = new Map();
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^(\d+) (\d+) (\d+)$/.exec(line.trim());
    if (match)
      table.set(Number(match[1]), {
        ppid: Number(match[2]),
        identity: match[3]!,
      });
  }
  return table;
}

function processTable(): Promise<ProcessTable> {
  if (process.platform === "linux") return linuxProcesses();
  if (process.platform === "darwin") return darwinProcesses();
  if (process.platform === "win32") return windowsProcesses();
  return Promise.resolve(new Map());
}

export interface CapturedProcessTree {
  /** Process IDs captured with the root, root first. */
  readonly pids: readonly number[];
  /**
   * Stop captured processes that still exist with the same identity: ask
   * first, then force the remaining ones after graceMs. Never throws.
   */
  reap(options?: { graceMs?: number }): Promise<void>;
}

/**
 * Record a root process and its live descendants, for children that are not
 * process-group leaders (for example SDK-spawned stdio MCP servers). Call
 * reap() after the owner closed the root. Best effort: never throws.
 */
export async function captureProcessTree(
  rootPid: number,
): Promise<CapturedProcessTree> {
  let captured: { pid: number; identity: string }[] = [];
  try {
    validPid(rootPid);
    const table = await processTable();
    const root = table.get(rootPid);
    if (root) {
      const children = new Map<number, number[]>();
      for (const [pid, entry] of table) {
        const list = children.get(entry.ppid) ?? [];
        list.push(pid);
        children.set(entry.ppid, list);
      }
      const seen = new Set([rootPid]);
      captured = [{ pid: rootPid, identity: root.identity }];
      for (let index = 0; index < captured.length; index++)
        for (const child of children.get(captured[index]!.pid) ?? []) {
          if (seen.has(child)) continue;
          seen.add(child);
          captured.push({ pid: child, identity: table.get(child)!.identity });
        }
    }
  } catch {
    captured = [];
  }
  const alive = async () => {
    const table = await processTable();
    return captured.filter(
      ({ pid, identity }) => table.get(pid)?.identity === identity,
    );
  };
  const signal = async (pid: number, force: boolean) => {
    try {
      if (process.platform === "win32")
        await run(
          windowsTool("System32", "taskkill.exe"),
          ["/PID", String(pid), "/F"],
          { windowsHide: true },
        );
      else process.kill(pid, force ? "SIGKILL" : "SIGTERM");
    } catch {
      /* The process already exited. */
    }
  };
  return {
    pids: captured.map(({ pid }) => pid),
    async reap({ graceMs = 1000 } = {}) {
      if (!captured.length) return;
      try {
        let remaining = await alive();
        if (!remaining.length) return;
        await Promise.all(remaining.map(({ pid }) => signal(pid, false)));
        // taskkill /F already forces termination on Windows.
        if (process.platform === "win32") return;
        const deadline = Date.now() + graceMs;
        while (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          remaining = await alive();
          if (!remaining.length) return;
        }
        await Promise.all(remaining.map(({ pid }) => signal(pid, true)));
      } catch {
        /* Best effort after the owner already closed the root. */
      }
    },
  };
}

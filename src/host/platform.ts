import { execFile } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

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
export function shellInvocation(
  command: string,
  shell?: string,
  login = false,
  platform = process.platform as string,
  env: NodeJS.ProcessEnv = process.env,
): { file: string; args: string[] } {
  const file =
    shell ?? (platform === "win32" ? "powershell.exe" : env.SHELL || "/bin/sh");
  const name = path.win32
    .basename(file)
    .toLowerCase()
    .replace(/\.exe$/, "");
  if (platform === "win32" && (name === "powershell" || name === "pwsh")) {
    return {
      file,
      args: [
        "-NoLogo",
        ...(login ? [] : ["-NoProfile"]),
        "-NonInteractive",
        "-Command",
        `$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); [Console]::InputEncoding = $OutputEncoding; ${command}`,
      ],
    };
  }
  if (name === "cmd")
    throw new Error(
      "Windows 请使用 PowerShell/pwsh；不支持 cmd.exe 的二次引号规则。",
    );
  return { file, args: [login ? "-lc" : "-c", command] };
}
/** Only processes created by this runtime are passed here. */
export async function terminateProcessTree(
  pid: number,
  force = false,
): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0)
    throw new Error("无效的自有进程标识。");
  if (process.platform === "win32") {
    const taskkill = path.join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "taskkill.exe",
    );
    try {
      await promisify(execFile)(taskkill, ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
      });
    } catch (error) {
      try {
        process.kill(pid, 0);
      } catch {
        return;
      }
      throw error;
    }
  } else {
    try {
      process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}

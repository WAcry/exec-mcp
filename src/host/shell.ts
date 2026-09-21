import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface ExecutionConfig {
  shell?: string;
  login?: boolean;
}
export type ShellKind =
  | "pwsh"
  | "powershell"
  | "bash"
  | "zsh"
  | "sh"
  | "fish"
  | "other";
export interface CommandShell {
  readonly file: string;
  readonly kind: ShellKind;
  readonly login: boolean;
  readonly platform: string;
}
interface ShellEnvironment {
  platform?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** Resolver injection for deterministic cross-platform tests; not a config option. */
  lookup?: (name: string) => string | undefined;
}

function variable(
  env: NodeJS.ProcessEnv,
  key: string,
  platform: string,
): string | undefined {
  if (platform !== "win32") return env[key];
  const name = Object.keys(env).find(
    (name) => name.toLowerCase() === key.toLowerCase(),
  );
  return name === undefined ? undefined : env[name];
}

/** Resolve an executable without interpolating it into a shell command. */
export function findShellExecutable(
  name: string,
  platform = process.platform as string,
  env = process.env,
): string | undefined {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const names =
    platform === "win32" && !paths.extname(name)
      ? [name + ".exe", name]
      : [name];
  const explicit =
    paths.isAbsolute(name) ||
    name.includes("/") ||
    (platform === "win32" && name.includes("\\"));
  const directories = explicit
    ? [""]
    : (variable(env, "PATH", platform) ?? "")
        .split(paths.delimiter)
        .filter(Boolean);
  for (const directory of directories) {
    for (const file of names) {
      const candidate = paths.resolve(directory.replace(/^"|"$/g, ""), file);
      try {
        if (!statSync(candidate).isFile()) continue;
        accessSync(
          candidate,
          platform === "win32" ? constants.F_OK : constants.X_OK,
        );
        // Preserve the executable's symlink name: sh -> bash/busybox can change argv[0] semantics.
        return candidate;
      } catch {
        /* Auto selection may try the next candidate before any command runs. */
      }
    }
  }
  return undefined;
}

export function resolveShell(
  config: ExecutionConfig = {},
  options: ShellEnvironment = {},
): CommandShell {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const paths = platform === "win32" ? path.win32 : path.posix;
  const lookup =
    options.lookup ?? ((name) => findShellExecutable(name, platform, env));
  const expand = (name: string) =>
    /^~[\\/]/.test(name)
      ? paths.join(options.home ?? homedir(), name.slice(2))
      : name;
  const rejectBatch = (file: string) => {
    if (
      /^(cmd|cmd\.exe)$/i.test(paths.basename(file)) ||
      /\.(cmd|bat)$/i.test(file)
    )
      throw new Error(
        "Shell 不支持 CMD 或批处理入口；请指定 Shell 可执行文件。",
      );
  };
  const selected = config.shell;
  let file: string | undefined;
  if (selected !== undefined) {
    if (!selected.trim() || selected.includes("\0"))
      throw new Error("Shell 必须是可执行文件名或路径。");
    rejectBatch(selected);
    file = lookup(expand(selected));
    if (!file)
      throw new Error(
        "找不到或无法执行指定的 Shell；请检查路径与服务的 PATH。",
      );
  } else {
    const candidates: string[] = [];
    if (platform === "win32") {
      candidates.push("pwsh.exe");
      for (const key of ["ProgramW6432", "ProgramFiles"]) {
        const programFiles = variable(env, key, platform);
        if (programFiles)
          candidates.push(
            paths.join(programFiles, "PowerShell", "7", "pwsh.exe"),
          );
      }
      candidates.push("powershell.exe");
      const windows = variable(env, "SystemRoot", platform) ?? "C:\\Windows";
      candidates.push(
        paths.join(
          windows,
          "System32",
          "WindowsPowerShell",
          "v1.0",
          "powershell.exe",
        ),
      );
    } else {
      const preferred = env.SHELL;
      if (preferred && !preferred.includes("\0")) candidates.push(preferred);
      if (platform === "darwin") candidates.push("/bin/zsh");
      candidates.push("/bin/sh");
    }
    for (const candidate of new Set(candidates)) {
      file = lookup(candidate);
      if (file) break;
    }
    if (!file)
      throw new Error("没有可用的命令 Shell；请配置 execution.shell。");
  }
  rejectBatch(file);
  const basename = paths
    .basename(file)
    .toLowerCase()
    .replace(/\.exe$/, "");
  const kind: ShellKind = [
    "pwsh",
    "powershell",
    "bash",
    "zsh",
    "sh",
    "fish",
  ].includes(basename)
    ? (basename as ShellKind)
    : "other";
  return Object.freeze({ file, kind, login: config.login ?? false, platform });
}

/** Per-command overrides are independent; never mutate the configured default. */
export function resolveCommandShell(
  defaults: CommandShell,
  overrides: ExecutionConfig,
  workdir: string,
): CommandShell {
  const login = overrides.login ?? defaults.login;
  if (overrides.shell === undefined)
    return login === defaults.login
      ? defaults
      : Object.freeze({ ...defaults, login });

  const paths = defaults.platform === "win32" ? path.win32 : path.posix;
  let shell = overrides.shell;
  if (
    !/^~[\\/]/.test(shell) &&
    (shell.includes("/") ||
      (defaults.platform === "win32" && shell.includes("\\")))
  )
    shell = paths.resolve(workdir, shell);
  return resolveShell({ shell, login }, { platform: defaults.platform });
}

export function shellInvocation(
  command: string,
  shell: CommandShell,
): { file: string; args: string[] } {
  if (shell.kind === "pwsh" || shell.kind === "powershell") {
    return {
      file: shell.file,
      args: [
        "-NoLogo",
        ...(shell.login ? [] : ["-NoProfile"]),
        "-NonInteractive",
        "-Command",
        (shell.platform === "win32"
          ? "$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); [Console]::InputEncoding = $OutputEncoding; "
          : "") + command,
      ],
    };
  }
  return { file: shell.file, args: [shell.login ? "-lc" : "-c", command] };
}

/** Only common dialects get a label; custom shells keep a useful generic description. */
export function shellDescription(shell: CommandShell): string {
  if (shell.kind === "pwsh" || shell.kind === "powershell") {
    const name =
      shell.kind === "pwsh" ? "PowerShell (pwsh)" : "Windows PowerShell";
    return `Default shell: ${name}; profile loading ${shell.login ? "enabled" : "disabled"}.`;
  }
  const names: Partial<Record<ShellKind, string>> = {
    bash: "Bash",
    zsh: "zsh",
    sh: "sh",
    fish: "fish",
  };
  const name = names[shell.kind];
  return name
    ? `Default shell: ${name}; login mode ${shell.login ? "enabled" : "disabled"}.`
    : "Uses the instance's configured shell.";
}

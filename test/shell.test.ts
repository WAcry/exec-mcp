import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveShell,
  resolveCommandShell,
  shellDescription,
  shellInvocation,
  findShellExecutable,
  type ShellKind,
} from "../src/host/shell.js";
import {
  COMMAND_SCHEMA,
  nativeContracts,
  execDescription,
  describeContract,
} from "../src/catalog.js";
import { CONFIG_TEMPLATE, parseConfig } from "../src/config.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function directory() {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "exec-shell-")),
  );
  directories.push(root);
  return root;
}
function lookup(mapping: Record<string, string>) {
  const calls: string[] = [];
  return {
    calls,
    lookup: (name: string) => {
      calls.push(name);
      return mapping[name];
    },
  };
}

describe("one configured shell per runtime", () => {
  it("prefers pwsh on Windows regardless of the parent shell or ComSpec", () => {
    const find = lookup({
      "pwsh.exe": "C:\\PowerShell\\7\\pwsh.exe",
      "powershell.exe": "C:\\Windows\\powershell.exe",
    });
    const result = resolveShell(
      {},
      {
        platform: "win32",
        env: { SHELL: "bash.exe", ComSpec: "cmd.exe" },
        lookup: find.lookup,
      },
    );
    expect(result).toEqual({
      file: "C:\\PowerShell\\7\\pwsh.exe",
      kind: "pwsh",
      login: false,
      platform: "win32",
    });
    expect(find.calls).toEqual(["pwsh.exe"]);
    expect(Object.isFrozen(result)).toBe(true);
  });
  it("finds standard PowerShell 7 without PATH before falling back to Windows PowerShell", () => {
    const standard = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
    const find = lookup({
      [standard]: standard,
      "powershell.exe": "C:\\Windows\\powershell.exe",
    });
    const result = resolveShell(
      {},
      {
        platform: "win32",
        env: { programfiles: "C:\\Program Files" },
        lookup: find.lookup,
      },
    );
    expect(result.file).toBe(standard);
    expect(find.calls).toEqual(["pwsh.exe", standard]);
    const fallback = lookup({
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe":
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    });
    expect(
      resolveShell({}, { platform: "win32", env: {}, lookup: fallback.lookup })
        .kind,
    ).toBe("powershell");
    expect(fallback.calls).toEqual([
      "pwsh.exe",
      "powershell.exe",
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    ]);
  });
  it("uses an explicit choice even when PowerShell 7 is available and never silently falls back", () => {
    const find = lookup({
      "pwsh.exe": "C:\\pwsh.exe",
      "powershell.exe": "C:\\powershell.exe",
    });
    expect(
      resolveShell(
        { shell: "powershell.exe", login: true },
        { platform: "win32", env: {}, lookup: find.lookup },
      ),
    ).toMatchObject({ kind: "powershell", login: true });
    expect(find.calls).toEqual(["powershell.exe"]);
    expect(() =>
      resolveShell(
        { shell: "missing.exe" },
        { platform: "win32", env: {}, lookup: find.lookup },
      ),
    ).toThrow("指定的 Shell");
    expect(find.calls).toEqual(["powershell.exe", "missing.exe"]);
  });
  it("selects the inherited Unix shell, then zsh on macOS or sh on Linux", () => {
    const find = lookup({
      "/bin/zsh": "/bin/zsh",
      "/bin/sh": "/bin/sh",
      "/custom/fish": "/custom/fish",
    });
    expect(
      resolveShell(
        {},
        {
          platform: "darwin",
          env: { SHELL: "/custom/fish" },
          lookup: find.lookup,
        },
      ).kind,
    ).toBe("fish");
    expect(
      resolveShell({}, { platform: "darwin", env: {}, lookup: find.lookup })
        .file,
    ).toBe("/bin/zsh");
    expect(
      resolveShell({}, { platform: "linux", env: {}, lookup: find.lookup })
        .file,
    ).toBe("/bin/sh");
    expect(
      resolveShell(
        {},
        {
          platform: "darwin",
          env: { SHELL: "/missing" },
          lookup: (name) => (name === "/bin/sh" ? name : undefined),
        },
      ).file,
    ).toBe("/bin/sh");
    expect(() =>
      resolveShell({}, { platform: "linux", env: {}, lookup: () => undefined }),
    ).toThrow("没有可用");
  });
  it("rejects CMD, batch files and argument strings without running a command", () => {
    for (const shell of [
      "cmd",
      "CMD.EXE",
      "C:\\Windows\\System32\\cmd.exe",
      "wrapper.cmd",
      "wrapper.bat",
    ])
      expect(() =>
        resolveShell({ shell }, { platform: "win32", lookup: (name) => name }),
      ).toThrow("不支持");
    for (const shell of ["", " ", "file\0name"])
      expect(() => resolveShell({ shell }, { lookup: (name) => name })).toThrow(
        "可执行文件",
      );
    expect(() =>
      resolveShell({ shell: "pwsh -NoProfile" }, { lookup: () => undefined }),
    ).toThrow("找不到");
  });
  it("expands home paths but preserves their executable identity", () => {
    const result = resolveShell(
      { shell: "~/tools/bash" },
      { home: "/home/test", platform: "linux", lookup: (name) => name },
    );
    expect(result.file).toBe("/home/test/tools/bash");
    expect(result.kind).toBe("bash");
  });
  it("resolves actual files from PATH and refuses directories or non-executable Unix files", async () => {
    const root = await directory();
    const folder = path.join(root, "bin with spaces");
    await mkdir(folder);
    const file = path.join(
      folder,
      process.platform === "win32" ? "custom.exe" : "custom",
    );
    await writeFile(file, "fixture");
    if (process.platform !== "win32") {
      await chmod(file, 0o644);
      expect(findShellExecutable(file)).toBeUndefined();
      await chmod(file, 0o755);
    }
    const env =
      process.platform === "win32" ? { Path: `"${folder}"` } : { PATH: folder };
    expect(findShellExecutable("custom", process.platform, env)).toBe(file);
    expect(findShellExecutable(folder)).toBeUndefined();
  });
  it.skipIf(process.platform === "win32")(
    "does not dereference sh symlinks into a different argv[0] dialect",
    async () => {
      const root = await directory();
      const link = path.join(root, "sh");
      await symlink("/bin/bash", link);
      const shell = resolveShell({ shell: link });
      expect(shell.file).toBe(link);
      expect(shell.kind).toBe("sh");
    },
  );
});

describe("shell command construction and concise contracts", () => {
  it.each(["linux", "darwin", "win32"])(
    "uses native PowerShell flags on %s without CMD or a second interpreter",
    (platform) => {
      const shell = resolveShell(
        { shell: "pwsh", login: false },
        {
          platform,
          lookup: () =>
            platform === "win32"
              ? "C:\\Program Files\\PowerShell\\7\\pwsh.exe"
              : "/opt/pwsh",
        },
      );
      const command = "$x='spaces & 中文';\n[Console]::WriteLine($x);exit 7";
      const invocation = shellInvocation(command, shell);
      expect(invocation.file).toBe(shell.file);
      expect(invocation.args.slice(0, -1)).toEqual([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
      ]);
      expect(invocation.args.at(-1)!.endsWith(command)).toBe(true);
      expect(
        invocation.args.some((argument) => /cmd\.exe/.test(argument)),
      ).toBe(false);
      expect(
        shellInvocation(command, { ...shell, login: true }).args,
      ).not.toContain("-NoProfile");
      if (platform !== "win32") expect(invocation.args.at(-1)).toBe(command);
    },
  );
  it.each(["bash", "zsh", "sh", "fish", "custom"])(
    "preserves command text and login selection for %s",
    (name) => {
      const shell = resolveShell(
        { shell: name },
        { platform: "linux", lookup: () => `/bin/${name}` },
      );
      const command = "printf '%s\\n' 'a & b'\nprintf '\"quoted\"'";
      expect(shellInvocation(command, shell)).toEqual({
        file: `/bin/${name}`,
        args: ["-c", command],
      });
      expect(shellInvocation(command, { ...shell, login: true }).args).toEqual([
        "-lc",
        command,
      ]);
    },
  );
  it("exposes optional per-command selectors and generates both default descriptions from the same contract", () => {
    expect(Object.keys(COMMAND_SCHEMA.shape)).toEqual([
      "cmd",
      "workdir",
      "shell",
      "login",
      "tty",
      "yield_time_ms",
    ]);
    expect(
      COMMAND_SCHEMA.safeParse({ cmd: "echo ok", shell: "bash" }).success,
    ).toBe(true);
    expect(
      COMMAND_SCHEMA.safeParse({ cmd: "echo ok", login: true }).success,
    ).toBe(true);
    for (const shell of ["", " ", "bad\0name", 7, null])
      expect(COMMAND_SCHEMA.safeParse({ cmd: "echo ok", shell }).success).toBe(
        false,
      );
    for (const login of ["true", "false", 0, null])
      expect(COMMAND_SCHEMA.safeParse({ cmd: "echo ok", login }).success).toBe(
        false,
      );
    for (const kind of [
      "pwsh",
      "powershell",
      "zsh",
      "bash",
      "sh",
      "fish",
      "other",
    ] as ShellKind[]) {
      const shell = {
        file: `/private/path/${kind}`,
        kind,
        login: false,
        platform: "linux",
      };
      const contracts = nativeContracts(shell);
      const command = contracts.find(
        (contract) => contract.name === "exec_command",
      )!;
      expect(execDescription(contracts)).toContain(describeContract(command));
      expect(command.description).toContain(shellDescription(shell));
      if (kind !== "other") expect(command.description).toContain("默认");
      expect(command.description).not.toMatch(
        /探索|你可以|如果你|未知|Git Bash|\/private\/path/,
      );
      expect(command.description.length).toBeLessThan(150);
    }
    expect(
      shellDescription({
        file: "/custom/tool",
        kind: "other",
        login: false,
        platform: "linux",
      }),
    ).toBe("运行 Shell 命令。");
  });
});

describe("TOML execution configuration", () => {
  it("keeps executable names on PATH and resolves relative paths against the config directory", () => {
    const file = path.join(tmpdir(), "config dir", "config.toml");
    expect(
      parseConfig(CONFIG_TEMPLATE + '\n[execution]\nshell="pwsh"\n', file)
        .execution,
    ).toEqual({ shell: "pwsh", login: false });
    expect(
      parseConfig(
        CONFIG_TEMPLATE + '\n[execution]\nshell="./tools/bash"\nlogin=true\n',
        file,
      ).execution,
    ).toEqual({
      shell: path.resolve(path.dirname(file), "tools/bash"),
      login: true,
    });
    expect(
      parseConfig(CONFIG_TEMPLATE + '\n[execution]\nshell="~/bin/zsh"\n', file)
        .execution!.shell,
    ).toBe(path.join(homedir(), "bin/zsh"));
    expect(parseConfig(CONFIG_TEMPLATE, file).execution).toBeUndefined();
  });
  it("does not accept extra command wrappers or ambiguous login values", () => {
    for (const fields of [
      'shell=""',
      'shell=" "',
      "shell=7",
      'login="false"',
      'shell="sh"\nargs=["-c"]',
    ])
      expect(() =>
        parseConfig(
          CONFIG_TEMPLATE + `\n[execution]\n${fields}\n`,
          "config.toml",
        ),
      ).toThrow("execution");
  });
});

describe("independent per-command overrides", () => {
  it("inherits both defaults, and an explicit false can override a configured true without re-resolving the executable", () => {
    for (const login of [false, true]) {
      const defaults = Object.freeze({
        file: "/already/selected/pwsh",
        kind: "pwsh" as const,
        login,
        platform: "linux",
      });
      expect(resolveCommandShell(defaults, {}, "/unused")).toBe(defaults);
      for (const override of [false, true]) {
        const selected = resolveCommandShell(
          defaults,
          { login: override },
          "/unused",
        );
        expect(selected).toEqual({ ...defaults, login: override });
        expect(Object.isFrozen(selected)).toBe(true);
        expect(
          shellInvocation("echo test", selected).args.includes("-NoProfile"),
        ).toBe(!override);
      }
      expect(defaults.login).toBe(login);
    }
  });
  it("resolves a relative executable against the command directory and inherits login even when shell changes", async () => {
    const root = await directory();
    const name = process.platform === "win32" ? "bash.exe" : "bash";
    const file = path.join(root, name);
    await writeFile(file, "resolver fixture");
    if (process.platform !== "win32") await chmod(file, 0o755);
    for (const login of [false, true]) {
      const defaults = Object.freeze({
        file: "/configured/pwsh",
        kind: "pwsh" as const,
        login,
        platform: process.platform,
      });
      const selected = resolveCommandShell(
        defaults,
        { shell: `./${name}` },
        root,
      );
      expect(selected).toMatchObject({ file, kind: "bash", login });
      expect(
        resolveCommandShell(
          defaults,
          { shell: `./${name}`, login: !login },
          root,
        ),
      ).toMatchObject({ file, kind: "bash", login: !login });
      expect(resolveCommandShell(defaults, {}, root)).toBe(defaults);
      expect(defaults.file).toBe("/configured/pwsh");
    }
  });
  it("does not interpret a bare name as a command-directory executable", async () => {
    const root = await directory();
    const name = "exec-mcp-test-not-on-path-143989";
    const file = path.join(
      root,
      process.platform === "win32" ? name + ".exe" : name,
    );
    await writeFile(file, "fixture");
    if (process.platform !== "win32") await chmod(file, 0o755);
    const defaults = resolveShell();
    expect(() => resolveCommandShell(defaults, { shell: name }, root)).toThrow(
      "指定的 Shell",
    );
    expect(
      resolveCommandShell(defaults, { shell: `./${path.basename(file)}` }, root)
        .file,
    ).toBe(file);
    expect(() =>
      resolveCommandShell(defaults, { shell: "cmd.exe" }, root),
    ).toThrow("不支持");
    expect(() =>
      resolveCommandShell(defaults, { shell: "pwsh -Command" }, root),
    ).toThrow("指定的 Shell");
  });
});

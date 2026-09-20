import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TerminalManager } from "../src/host/terminal.js";
import {
  findShellExecutable,
  resolveShell,
  shellDescription,
  type CommandShell,
} from "../src/host/shell.js";
import { connect, jsonOutput, observeTerminal, texts } from "./helpers.js";
import { CONFIG_TEMPLATE, parseConfig } from "../src/config.js";

const directories: string[] = [];
const terminals: TerminalManager[] = [];
const connections: Awaited<ReturnType<typeof connect>>[] = [];
afterEach(async () => {
  await Promise.all(
    connections.splice(0).map((connection) => connection.close()),
  );
  await Promise.all(terminals.splice(0).map((terminal) => terminal.close()));
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function directory() {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "exec shell ' 中文-")),
  );
  directories.push(root);
  return root;
}
function manager(shell: CommandShell) {
  const terminal = new TerminalManager({ shell });
  terminals.push(terminal);
  return terminal;
}
function ps(shell: CommandShell) {
  return shell.kind === "pwsh" || shell.kind === "powershell";
}
function quote(value: string, shell: CommandShell) {
  return `'${value.replaceAll("'", ps(shell) ? "''" : "'\\''")}'`;
}
function command(file: string, shell: CommandShell, args: string[] = []) {
  const executable =
    process.platform === "win32" && !ps(shell)
      ? process.execPath.replaceAll("\\", "/")
      : process.execPath;
  const script =
    process.platform === "win32" && !ps(shell)
      ? file.replaceAll("\\", "/")
      : file;
  return `${ps(shell) ? "& " : ""}${[executable, script, ...args].map((value) => quote(value, shell)).join(" ")}`;
}
function variants() {
  if (process.platform === "win32")
    return [
      {
        name: "PowerShell 7",
        candidate: () => findShellExecutable("pwsh.exe"),
        kind: "pwsh",
      },
      {
        name: "Windows PowerShell 5",
        candidate: () => findShellExecutable("powershell.exe"),
        kind: "powershell",
      },
      {
        name: "Git Bash",
        candidate: () =>
          findShellExecutable(
            path.join(
              process.env.ProgramFiles ?? "C:\\Program Files",
              "Git",
              "bin",
              "bash.exe",
            ),
          ),
        kind: "bash",
      },
    ];
  return (
    process.platform === "darwin" ? ["zsh", "bash", "sh"] : ["bash", "sh"]
  ).map((name) => ({
    name,
    kind: name,
    candidate: () => findShellExecutable(`/bin/${name}`),
  }));
}

describe.each(variants())(
  "configured $name execution on this OS",
  (variant) => {
    function shell() {
      const file = variant.candidate();
      expect(
        file,
        `${variant.name} is required on this platform's CI image`,
      ).toBeTruthy();
      const resolved = resolveShell({ shell: file! });
      expect(resolved.kind).toBe(variant.kind);
      return resolved;
    }
    it("keeps complex command literals and multiline code intact without a CMD wrapper", async () => {
      const selected = shell();
      const cwd = await directory();
      const terminal = manager(selected);
      const values = [
        "",
        "two words",
        "quote'and\"double",
        "$dollar`backtick",
        "&|;<>()%PATH%",
        "中文😀",
        "line\nnext",
        "C:\\temp\\tail\\",
      ];
      let source: string;
      if (ps(selected)) {
        source = `$values = @(${values.map((value) => quote(value, selected)).join(",")})\n[Console]::WriteLine((ConvertTo-Json -Compress -InputObject $values))\nexit 7`;
      } else {
        const script = path.join(cwd, "literal args ' & 中文.cjs");
        await writeFile(
          script,
          "process.stdout.write(JSON.stringify(process.argv.slice(2))+'\\n');",
        );
        source = `${command(script, selected, values)}\nexit 7`;
      }
      const first = await terminal.execCommand(
        { cmd: source, yield_time_ms: 0 },
        cwd,
      );
      const result = await observeTerminal(first, (input) =>
        terminal.writeStdin(input),
      );
      expect(result.exit_code).toBe(7);
      expect(JSON.parse(result.output.trim())).toEqual(values);
    });
    it("runs actual executables from paths containing spaces, apostrophes and Unicode", async () => {
      const selected = shell();
      const cwd = await directory();
      const terminal = manager(selected);
      const script = path.join(cwd, "helper ' & 中文.cjs");
      await writeFile(
        script,
        "console.log(JSON.stringify({cwd:process.cwd(),arg:process.argv[2]}));process.exitCode=9;",
      );
      const source =
        command(script, selected, ["plain-value"]) +
        (ps(selected) ? "; exit $LASTEXITCODE" : "");
      const result = await observeTerminal(
        await terminal.execCommand({ cmd: source, yield_time_ms: 0 }, cwd),
        (input) => terminal.writeStdin(input),
      );
      expect(result.exit_code).toBe(9);
      expect(JSON.parse(result.output)).toEqual({ cwd, arg: "plain-value" });
    });
    it("supports independent overrides alongside simultaneous default commands", async () => {
      const selected = shell();
      const cwd = await directory();
      const defaults = resolveShell({
        shell: process.platform === "win32" ? "pwsh.exe" : "/bin/sh",
        login: false,
      });
      const terminal = manager(defaults);
      const code = ps(selected)
        ? "[Console]::WriteLine($PSVersionTable.PSVersion.Major);exit 3"
        : 'printf "%s\\n" "$0";exit 3';
      const [changed, regular] = await Promise.all([
        terminal.execCommand(
          { cmd: code, shell: selected.file, login: false, yield_time_ms: 0 },
          cwd,
        ),
        terminal.execCommand(
          { cmd: "echo CONFIGURED_DEFAULT", yield_time_ms: 0 },
          cwd,
        ),
      ]);
      const [result, normal] = await Promise.all([
        observeTerminal(changed, (input) => terminal.writeStdin(input)),
        observeTerminal(regular, (input) => terminal.writeStdin(input)),
      ]);
      expect(result.exit_code).toBe(3);
      if (selected.kind === "pwsh")
        expect(Number(result.output.trim())).toBeGreaterThanOrEqual(7);
      else if (selected.kind === "powershell")
        expect(Number(result.output.trim())).toBe(5);
      else
        expect(
          result.output
            .trim()
            .replaceAll("\\", "/")
            .split("/")
            .at(-1)!
            .replace(/\.exe$/i, ""),
        ).toBe(selected.kind);
      expect(normal).toMatchObject({ exit_code: 0 });
      expect(normal.output.trim()).toBe("CONFIGURED_DEFAULT");
      expect(terminal.shell).toBe(defaults);
      const later = await observeTerminal(
        await terminal.execCommand(
          { cmd: "echo STILL_DEFAULT", yield_time_ms: 0 },
          cwd,
        ),
        (input) => terminal.writeStdin(input),
      );
      expect(later.output.trim()).toBe("STILL_DEFAULT");
      expect(terminal.shell.login).toBe(false);
    });
    it("keeps an overridden PTY attached to its original process after another default command", async () => {
      const selected = shell();
      const cwd = await directory();
      const defaults = resolveShell({
        shell: process.platform === "win32" ? "pwsh.exe" : "/bin/sh",
        login: false,
      });
      const terminal = manager(defaults);
      const script = path.join(cwd, "pty fixture.cjs");
      await writeFile(
        script,
        'console.log("SHELL_PTY_READY");let line="";process.stdin.on("data",chunk=>{line+=chunk;if(/[\\r\\n]/.test(line)){process.stdin.pause();process.stdout.write("SHELL_PTY_REPLY:"+line.trim()+"\\n",()=>process.exit(6));}});',
      );
      const source =
        command(script, selected) +
        (ps(selected) ? "; exit $LASTEXITCODE" : "");
      const first = await terminal.execCommand(
        {
          cmd: source,
          shell: selected.file,
          login: false,
          tty: true,
          yield_time_ms: 0,
        },
        cwd,
      );
      const ready = await observeTerminal(
        first,
        (input) => terminal.writeStdin(input),
        (result) => result.output.includes("SHELL_PTY_READY"),
      );
      const intervening = await observeTerminal(
        await terminal.execCommand(
          { cmd: "echo BETWEEN_COMMANDS", yield_time_ms: 0 },
          cwd,
        ),
        (input) => terminal.writeStdin(input),
      );
      expect(intervening.output.trim()).toBe("BETWEEN_COMMANDS");
      const part = await terminal.writeStdin({
        session_id: ready.session_id!,
        chars: "hello 中文\r",
        cols: 100,
        rows: 30,
        yield_time_ms: 1000,
      });
      const result = await observeTerminal(part, (input) =>
        terminal.writeStdin(input),
      );
      expect(result.output).toContain("SHELL_PTY_REPLY:hello 中文");
      expect(result.exit_code).toBe(6);
      expect(terminal.shell).toBe(defaults);
    });
    it("uses the configured dialect in both the top-level description and ALL_TOOLS", async () => {
      const selected = shell();
      const config = parseConfig(
        CONFIG_TEMPLATE +
          `\n[execution]\nshell=${JSON.stringify(selected.file)}\n`,
        path.join(await directory(), "config.toml"),
      );
      const connection = await connect({ execution: config.execution! });
      connections.push(connection);
      const tools = (await connection.client.listTools()).tools;
      expect(tools.map((tool) => tool.name)).toEqual(TOP_LEVEL_TOOL_NAMES);
      const output = await connection.client.callTool({
        name: "exec",
        arguments: {
          source:
            'text({description:ALL_TOOLS.find(t=>t.name==="exec_command").description});',
        },
      });
      const entry = jsonOutput<{ description: string }>(output);
      expect(entry.description).toContain(shellDescription(selected));
      expect(tools[0]!.description).not.toContain(entry.description);
      expect(
        tools.find((tool) => tool.name === "exec_command")!.description,
      ).toContain(shellDescription(selected));
      expect(entry.description).toContain('"shell"');
      expect(entry.description).toContain('"login"');
      if (ps(selected)) {
        const version = await connection.client.callTool({
          name: "exec",
          arguments: {
            source:
              'text(await tools.exec_command({cmd:"[Console]::WriteLine($PSVersionTable.PSVersion.Major)",yield_time_ms:30000}));',
          },
        });
        const result = jsonOutput<{ output: string; exit_code?: number }>(
          version,
        );
        expect(result.exit_code).toBe(0);
        if (selected.kind === "pwsh")
          expect(Number(result.output.trim())).toBeGreaterThanOrEqual(7);
        else expect(Number(result.output.trim())).toBe(5);
      }
    });
  },
);

describe.each([false, true])(
  "per-command Shell through MCP (legacy=%s)",
  (legacy) => {
    it("accepts an override without changing the default advertised to the next call", async () => {
      const windows = process.platform === "win32";
      const defaults = windows ? "pwsh.exe" : "/bin/sh";
      const alternate = windows ? "powershell.exe" : "/bin/bash";
      const probe = windows
        ? "[Console]::WriteLine($PSVersionTable.PSVersion.Major)"
        : 'printf "%s\\n" "$0"';
      const connection = await connect(
        { execution: { shell: defaults, login: false } },
        legacy,
      );
      connections.push(connection);
      const before = (await connection.client.listTools()).tools;
      const result = await connection.client.callTool({
        name: "exec",
        arguments: {
          source: `text(await tools.exec_command(${JSON.stringify({ cmd: probe, shell: alternate, login: false, yield_time_ms: 30000 })}));`,
        },
      });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      const changed = jsonOutput<{ output: string; exit_code: number }>(result);
      expect(changed.exit_code).toBe(0);
      expect(changed.output.trim()).toBe(windows ? "5" : "/bin/bash");
      const next = await connection.client.callTool({
        name: "exec",
        arguments: {
          source: `text(await tools.exec_command(${JSON.stringify({ cmd: probe, yield_time_ms: 30000 })}));`,
        },
      });
      expect(next.isError, JSON.stringify(next)).not.toBe(true);
      const unchanged = jsonOutput<{ output: string; exit_code: number }>(next);
      expect(unchanged.exit_code).toBe(0);
      if (windows)
        expect(Number(unchanged.output.trim())).toBeGreaterThanOrEqual(7);
      else expect(unchanged.output.trim()).toBe("/bin/sh");
      expect((await connection.client.listTools()).tools).toEqual(before);
    });
    it("resolves an override from the nested command workdir, not the server or outer exec directory", async () => {
      const root = await directory();
      const cwd = path.join(root, "command directory");
      await mkdir(cwd);
      const executable = findShellExecutable(
        process.platform === "win32" ? "powershell.exe" : "/bin/bash",
      )!;
      expect(executable).toBeTruthy();
      const engine = path.join(cwd, "engine");
      await symlink(
        path.dirname(executable),
        engine,
        process.platform === "win32" ? "junction" : "dir",
      );
      const connection = await connect({}, legacy);
      connections.push(connection);
      const cmd =
        process.platform === "win32"
          ? "[Console]::WriteLine((Get-Location).Path)"
          : "pwd";
      const result = await connection.client.callTool({
        name: "exec",
        arguments: {
          workdir: root,
          source: `text(await tools.exec_command(${JSON.stringify({ cmd, workdir: "command directory", shell: `./engine/${path.basename(executable)}`, login: false, yield_time_ms: 30000 })}));`,
        },
      });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(
        jsonOutput<{ output: string; exit_code: number }>(result),
      ).toMatchObject({ exit_code: 0 });
      expect(jsonOutput<{ output: string }>(result).output.trim()).toBe(cwd);
    });
    it("rejects invalid override types before invoking the command", async () => {
      const connection = await connect({}, legacy);
      connections.push(connection);
      const root = await directory();
      for (const extra of [
        { shell: " " },
        { shell: "bad\0name" },
        { login: "true" },
      ]) {
        const result = await connection.client.callTool({
          name: "exec",
          arguments: {
            workdir: root,
            source: `text(await tools.exec_command(${JSON.stringify({ cmd: "echo wrote > marker", ...extra })}));`,
          },
        });
        expect(result.isError).toBe(true);
        expect(texts(result).join("\n")).toContain("尚未执行");
      }
      await expect(readFile(path.join(root, "marker"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
    it("rejects unavailable or unsupported overrides instead of executing with the default", async () => {
      const connection = await connect({}, legacy);
      connections.push(connection);
      const root = await directory();
      for (const shell of [path.join(root, "missing-shell"), "cmd.exe"]) {
        const result = await connection.client.callTool({
          name: "exec",
          arguments: {
            workdir: root,
            source: `text(await tools.exec_command(${JSON.stringify({ cmd: "echo wrote > marker", shell })}));`,
          },
        });
        expect(result.isError).toBe(true);
        expect(texts(result).join("\n")).toMatch(/指定的 Shell|不支持 CMD/);
      }
      await expect(readFile(path.join(root, "marker"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      const later = await connection.client.callTool({
        name: "exec",
        arguments: {
          source:
            'text(await tools.exec_command({cmd:"echo DEFAULT_STILL_WORKS",yield_time_ms:30000}));',
        },
      });
      expect(later.isError).not.toBe(true);
      expect(jsonOutput<{ output: string }>(later).output).toContain(
        "DEFAULT_STILL_WORKS",
      );
    });
  },
);

describe("fixed executable identity and native startup rules", () => {
  it.skipIf(process.platform === "win32" || !findShellExecutable("/bin/zsh"))(
    "applies per-command login overrides without changing zsh defaults or interactive startup rules",
    async () => {
      const root = await directory();
      const previous = process.env.ZDOTDIR;
      await writeFile(
        path.join(root, ".zshenv"),
        "export SHELL_TEST_ENV=env\n",
      );
      await writeFile(
        path.join(root, ".zprofile"),
        "export SHELL_TEST_PROFILE=profile\n",
      );
      await writeFile(path.join(root, ".zshrc"), "export SHELL_TEST_RC=rc\n");
      process.env.ZDOTDIR = root;
      try {
        const terminal = manager(
          resolveShell({ shell: "/bin/zsh", login: true }),
        );
        for (const login of [undefined, false, true])
          for (const tty of [false, true]) {
            const first = await terminal.execCommand(
              {
                cmd: 'print -r -- "$SHELL_TEST_ENV|${SHELL_TEST_PROFILE-unset}|${SHELL_TEST_RC-unset}|$options[interactive]|$options[login]"',
                tty,
                ...(login === undefined ? {} : { login }),
              },
              root,
            );
            const result = await observeTerminal(first, (input) =>
              terminal.writeStdin(input),
            );
            expect(result.exit_code).toBe(0);
            expect(result.output.trim()).toBe(
              (login ?? true)
                ? "env|profile|unset|off|on"
                : "env|unset|unset|off|off",
            );
            expect(terminal.shell.login).toBe(true);
          }
      } finally {
        if (previous === undefined) delete process.env.ZDOTDIR;
        else process.env.ZDOTDIR = previous;
      }
    },
  );
  it("fails bad configuration without starting a server with another language", async () => {
    await expect(
      connect({
        execution: { shell: path.join(await directory(), "missing-shell") },
      }),
    ).rejects.toThrow("指定的 Shell");
  });
  it.skipIf(process.platform === "win32")(
    "keeps the selected executable after PATH changes and does not fall back when it disappears",
    async () => {
      const root = await directory();
      const firstBin = path.join(root, "first");
      const nextBin = path.join(root, "second");
      await mkdir(firstBin);
      await mkdir(nextBin);
      for (const [directory, text] of [
        [firstBin, "first"],
        [nextBin, "second"],
      ]) {
        const file = path.join(directory!, "custom-shell");
        await writeFile(file, `#!/bin/sh\nprintf '${text}\\n'\n`);
        await chmod(file, 0o755);
      }
      const selected = resolveShell(
        { shell: "custom-shell" },
        { env: { PATH: firstBin } },
      );
      const terminal = manager(selected);
      expect(shellDescription(selected)).toBe("运行 Shell 命令。");
      const result = await observeTerminal(
        await terminal.execCommand({ cmd: "ignored" }, root),
        (input) => terminal.writeStdin(input),
      );
      expect(result.output).toBe("first\n");
      expect(
        resolveShell({ shell: "custom-shell" }, { env: { PATH: nextBin } })
          .file,
      ).not.toBe(selected.file);
      await rm(selected.file);
      const failed = await observeTerminal(
        await terminal.execCommand({ cmd: "ignored" }, root),
        (input) => terminal.writeStdin(input),
      );
      expect(failed.exit_code).not.toBe(0);
      expect(failed.output).toContain("进程启动失败");
      expect(failed.output).not.toContain("second\n");
    },
  );
  it.skipIf(process.platform === "win32")(
    "preserves sh mode when the selected executable is a symlink to bash",
    async () => {
      const root = await directory();
      const link = path.join(root, "sh");
      await symlink("/bin/bash", link);
      const terminal = manager(resolveShell({ shell: link }));
      const result = await observeTerminal(
        await terminal.execCommand(
          { cmd: 'case "$0" in */sh|sh) printf sh-mode;; *) exit 12;; esac' },
          root,
        ),
        (input) => terminal.writeStdin(input),
      );
      expect(result).toMatchObject({ output: "sh-mode", exit_code: 0 });
    },
  );
});
import { TOP_LEVEL_TOOL_NAMES } from "../src/tool-names.js";

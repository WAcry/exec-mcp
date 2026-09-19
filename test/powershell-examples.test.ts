import { afterEach, describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { resolveShell, findShellExecutable } from "../src/host/shell.js";
import { TerminalManager } from "../src/host/terminal.js";
import { observeTerminal } from "./helpers.js";
const values: TerminalManager[] = [];
afterEach(async () => {
  await Promise.all(values.splice(0).map((value) => value.close()));
});
const file = findShellExecutable(
  process.platform === "win32" ? "pwsh.exe" : "pwsh",
);
describe.skipIf(!file)("documented PowerShell invocation examples", () => {
  async function run(cmd: string) {
    const terminal = new TerminalManager({
      shell: resolveShell({ shell: file! }),
    });
    values.push(terminal);
    return observeTerminal(
      await terminal.execCommand({ cmd, yield_time_ms: 0 }, tmpdir()),
      (input) => terminal.writeStdin(input),
    );
  }
  it("preserves regex backslashes, paths and multiline JSON using String.raw", async () => {
    const command = String.raw`
$literalPath = 'C:\Windows\System32'
$pattern = 'Sig\['
$matched = 'Sig[42]' | Select-String -Pattern $pattern
[pscustomobject]@{ path = $literalPath; pattern = $pattern; matched = [bool]$matched } | ConvertTo-Json -Compress
`;
    const result = await run(command);
    expect(result.exit_code).toBe(0);
    expect(JSON.parse(result.output)).toEqual({
      path: String.raw`C:\Windows\System32`,
      pattern: String.raw`Sig\[`,
      matched: true,
    });
  });
  it("serializes unrelated object shapes independently rather than relying on host table formatting", async () => {
    const result = await run(String.raw`
[pscustomobject]@{ Id = 42 } | ConvertTo-Json -Compress
[pscustomobject]@{ OS = 'Windows'; Arch = 'x64' } | ConvertTo-Json -Compress
`);
    expect(result.exit_code).toBe(0);
    expect(
      result.output
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line)),
    ).toEqual([{ Id: 42 }, { OS: "Windows", Arch: "x64" }]);
  });
  it("reports non-terminating stderr independently of final Shell exit status", async () => {
    const result = await run(
      "Write-Error 'expected diagnostic'; Write-Output 'later success'",
    );
    expect(result.exit_code).toBe(0);
    expect(result.stderr_bytes).toBeGreaterThan(0);
    expect(result.output).toContain("expected diagnostic");
    expect(result.output).toContain("later success");
  });
  it("allows the caller to request terminating PowerShell errors explicitly", async () => {
    const result = await run(
      "$ErrorActionPreference='Stop';Write-Error 'stop here';Write-Output 'should-not-run'",
    );
    expect(result.exit_code).not.toBe(0);
    expect(result.stderr_bytes).toBeGreaterThan(0);
    expect(result.output).not.toMatch(/^should-not-run$/m);
  });
});

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { CONFIG_TEMPLATE } from "../src/config.js";

const directories: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0))
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "exec-mcp-startup-")),
  );
  directories.push(root);
  const pidFile = path.join(root, "downstream.pid");
  const source = `import {writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(pidFile)},String(process.pid));
console.error('FIXTURE_LOGIN_HINT: complete supplier login in your terminal');
import {Server} from '@modelcontextprotocol/server';import {serveStdio} from '@modelcontextprotocol/server/stdio';
serveStdio(()=>{const s=new Server({name:'ready-fixture',version:'1'},{capabilities:{tools:{}}});
s.setRequestHandler('tools/list',async()=>({tools:[{name:'echo',inputSchema:{type:'object'}}]}));return s;});`;
  const config = path.join(root, "config.toml");
  await writeFile(
    config,
    CONFIG_TEMPLATE.replace("port = 8891", "port = 0") +
      `
[web]
enabled=false

[mcp_servers.good]
command=${JSON.stringify(process.execPath)}
args=${JSON.stringify(["--input-type=module", "--eval", source])}
cwd=${JSON.stringify(process.cwd())}
startup_timeout_sec=5

[mcp_servers.needs_login]
command=${JSON.stringify(process.execPath)}
args=${JSON.stringify(["-e", "setInterval(()=>{},1000)"])}
startup_timeout_sec=1
`,
  );
  return { root, config, pidFile };
}
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("terminal-side startup failure and cancellation", () => {
  it("exits nonzero before readiness, displays supplier stderr, and closes successful sibling processes", async () => {
    const { config, pidFile } = await fixture();
    const result = await promisify(execFile)(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "serve", "--config", config],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 20_000,
      },
    ).then(
      (value) => ({ ...value, code: 0 }),
      (error: { stdout: string; stderr: string; code: number }) => error,
    );
    expect(result.code).not.toBe(0);
    expect(result.stdout).not.toContain("已就绪");
    expect(result.stderr).toContain("FIXTURE_LOGIN_HINT");
    expect(result.stderr).toContain("needs_login");
    expect(result.stderr).toContain("startup_timeout_sec");
    expect(result.stderr).toContain("enabled=false");
    const pid = Number(await readFile(pidFile, "utf8"));
    expect(alive(pid)).toBe(false);
  });
  it.skipIf(process.platform === "win32")(
    "cleans up initialized children when Ctrl+C cancels a pending startup",
    async () => {
      // Windows process.kill(SIGINT) forcibly terminates rather than emulating a terminal Ctrl+C.
      const { config, pidFile } = await fixture();
      await writeFile(
        config,
        (await readFile(config, "utf8")).replace(
          "startup_timeout_sec=1",
          "startup_timeout_sec=60",
        ),
      );
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "src/cli.ts", "serve", "--config", config],
        { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
      );
      children.push(child);
      const exited = once(child, "exit");
      let stdout = "",
        stderr = "";
      child.stdout!.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr!.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      const deadline = Date.now() + 10_000;
      while (!stderr.includes('"good"：已加载')) {
        if (child.exitCode !== null || Date.now() >= deadline)
          throw new Error("CLI never initialized sibling");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      child.kill("SIGINT");
      await exited;
      expect(stdout).not.toContain("已就绪");
      expect(alive(Number(await readFile(pidFile, "utf8")))).toBe(false);
    },
  );
});

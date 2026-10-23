import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { TerminalManager } from "../src/host/terminal.js";
import { nodeCommand, observeTerminal } from "./helpers.js";

const managers: TerminalManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.close()));
});
function manager() {
  const value = new TerminalManager({ bufferBytes: 6 * 1024 * 1024 });
  managers.push(value);
  return value;
}

it("defaults command output to 10000 tokens and allows a larger explicit budget", async () => {
  const value = manager();
  const cmd = nodeCommand(
    'process.stdout.write("START"+"x".repeat(50000)+"END");',
  );
  const clipped = await value.execCommand({ cmd }, tmpdir());
  expect(clipped.exit_code).toBe(0);
  expect(clipped.output).toMatch(/^START/);
  expect(clipped.output).toMatch(/END$/);
  expect(clipped.output).toContain("max_output_tokens");
  expect(clipped.original_token_count).toBe(12502);
  expect(clipped.omitted_bytes).toBe(10008);
  const complete = await value.execCommand(
    { cmd, max_output_tokens: 20000 },
    tmpdir(),
  );
  expect(complete.output).toBe("START" + "x".repeat(50000) + "END");
  expect(complete.truncated).toBeUndefined();
});

it("uses each stdin call's budget and consumes omitted output without replaying it", async () => {
  const value = manager();
  const started = await value.execCommand(
    {
      cmd: nodeCommand(
        'process.stdin.once("data",()=>{process.stdout.write("START"+"x".repeat(5000)+"END");});',
      ),
      yield_time_ms: 0,
      max_output_tokens: 0,
    },
    tmpdir(),
  );
  const ready = await observeTerminal(
    await value.writeStdin({
      session_id: started.session_id!,
      chars: "go",
      max_output_tokens: 20,
    }),
    (input) => value.writeStdin({ ...input, max_output_tokens: 20 }),
    (result) => result.output.includes("END"),
  );
  expect(ready.output).toContain("START");
  expect(ready.output).toContain("max_output_tokens");
  expect(ready.output).toContain("END");
  const empty = await value.writeStdin({
    session_id: ready.session_id!,
    yield_time_ms: 0,
  });
  expect(empty.output).toBe("");
  await value.writeStdin({ session_id: ready.session_id!, close_stdin: true });
});

it("returns the foreground exit while a descendant retains pipes and lets that descendant finish", async () => {
  const value = manager();
  const directory = await mkdtemp(path.join(tmpdir(), "exec-exit-drain-"));
  const release = path.join(directory, "release");
  const finished = path.join(directory, "finished");
  const background = `const fs=require('node:fs');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);fs.writeFileSync(${JSON.stringify(finished)},'survived');}},10);`;
  // Inherited output pipes are the fixture; a Windows working-directory lock
  // must not race cleanup after the descendant writes its completion marker.
  try {
    const first = await value.execCommand(
      {
        cmd: nodeCommand(
          `const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(background)}],{cwd:${JSON.stringify(tmpdir())},detached:true,windowsHide:true,stdio:['ignore',1,2]});child.unref();process.stdout.write('FOREGROUND_OUT\\n');process.stderr.write('FOREGROUND_ERR\\n');process.exitCode=7;`,
        ),
        yield_time_ms: 0,
      },
      directory,
    );
    const final = await observeTerminal(
      first,
      (input) => value.writeStdin(input),
      undefined,
      5000,
    );
    expect(final.exit_code).toBe(7);
    expect(final.output).toContain("FOREGROUND_OUT");
    expect(final.output).toContain("FOREGROUND_ERR");
    expect(final.session_id).toBeUndefined();
  } finally {
    await writeFile(release, "go");
    await expect
      .poll(async () => readFile(finished, "utf8"), { timeout: 5000 })
      .toBe("survived");
    await rm(directory, { recursive: true, force: true });
  }
});

import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodeModeService } from "../src/code-mode/service.js";
import { TerminalManager } from "../src/host/terminal.js";
import { PatchRunner } from "../src/host/patch.js";
import { viewImage } from "../src/host/image.js";
import { cellId, nodeCommand, observeTerminal, texts } from "./helpers.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()));
});
async function directory() {
  const dir = await mkdtemp(path.join(tmpdir(), "exec-lifecycle-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
describe("real execution lifecycle boundaries", () => {
  it("does not dispatch tools from a pre-aborted exec", async () => {
    const service = new CodeModeService();
    cleanup.push(() => service.close());
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    await expect(
      service.exec({
        source: "await tools.count({});",
        signal: controller.signal,
        tools: [
          { name: "count", description: "计数", call: async () => ++calls },
        ],
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(0);
  });
  it("terminating a cell cancels a pending tool but not an already returned terminal", async () => {
    const service = new CodeModeService();
    const terminal = new TerminalManager();
    cleanup.push(() => service.close());
    cleanup.push(() => terminal.close());
    let started!: () => void;
    const start = new Promise<void>((resolve) => {
      started = resolve;
    });
    let aborted = false;
    let sessionId = "";
    const source = "text(await tools.command({})); await tools.pending({});";
    const first = await service.exec({
      source,
      yieldTimeMs: 0,
      tools: [
        {
          name: "command",
          description: "启动命令",
          call: async () => {
            const result = await terminal.execCommand(
              {
                cmd: nodeCommand(
                  'process.stdin.once("data",x=>process.stdout.write(x,()=>process.exit(0)))',
                ),
                yield_time_ms: 0,
              },
              tmpdir(),
            );
            sessionId = result.session_id!;
            return result;
          },
        },
        {
          name: "pending",
          description: "等待取消",
          call: async (_args, context) => {
            started();
            await new Promise<void>((resolve) => {
              const abort = () => {
                aborted = true;
                resolve();
              };
              if (context.signal.aborted) abort();
              else
                context.signal.addEventListener("abort", abort, { once: true });
            });
            return {};
          },
        },
      ],
    });
    await start;
    await service.wait({ cellId: cellId(first), terminate: true });
    expect(aborted).toBe(true);
    const part = await terminal.writeStdin({
      session_id: sessionId,
      chars: "still alive",
      yield_time_ms: 3000,
    });
    const result = await observeTerminal(part, (input) =>
      terminal.writeStdin(input),
    );
    expect(result.output).toBe("still alive");
    expect(result.exit_code).toBe(0);
  });
  it("uses flow control to retain unread terminal bytes rather than dropping them", async () => {
    const terminal = new TerminalManager({
      highWater: 32 * 1024,
      lowWater: 8 * 1024,
    });
    cleanup.push(() => terminal.close());
    const first = await terminal.execCommand(
      {
        cmd: nodeCommand('process.stdout.write("x".repeat(2*1024*1024))'),
        yield_time_ms: 100,
      },
      tmpdir(),
    );
    const result = await observeTerminal(first, (input) =>
      terminal.writeStdin(input),
    );
    expect(result.exit_code).toBe(0);
    expect(result.output).toBe("x".repeat(2 * 1024 * 1024));
  });
  it("does not serialize away distinct native media or its detail", async () => {
    const file = path.join(await directory(), "one.png");
    await writeFile(
      file,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1kAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    const image = await viewImage(file, "original");
    expect(image.content[0]).toMatchObject({
      type: "image",
      mimeType: "image/png",
      _meta: { "codex/imageDetail": "original" },
    });
    const service = new CodeModeService();
    cleanup.push(() => service.close());
    const result = await service.exec({
      source: "image((await tools.picture({})).content[0]);",
      tools: [
        { name: "picture", description: "图片", call: async () => image },
      ],
    });
    expect(result.content.some((block) => block.type === "image")).toBe(true);
  });
  it("returns a tool error for oversized nested results without replay or spill", async () => {
    const service = new CodeModeService();
    cleanup.push(() => service.close());
    let calls = 0;
    const result = await service.exec({
      source: "await tools.large({});",
      tools: [
        {
          name: "large",
          description: "大结果",
          call: async () => {
            calls++;
            return "x".repeat(48 * 1024 * 1024);
          },
        },
      ],
    });
    expect(calls).toBe(1);
    expect(result.isError).toBe(true);
    expect(texts(result).join("\n")).toContain("未截断或落盘");
  });
  it("serializes concurrent patches in one directory without losing changes", async () => {
    const dir = await directory();
    const patch = new PatchRunner();
    cleanup.push(() => patch.close());
    const results = await Promise.all(
      ["one", "two"].map((name) =>
        patch.apply(
          `*** Begin Patch\n*** Add File: ${name}.txt\n+${name}\n*** End Patch\n`,
          dir,
        ),
      ),
    );
    expect(results.every((result) => result.success)).toBe(true);
    expect(await readFile(path.join(dir, "one.txt"), "utf8")).toBe("one\n");
    expect(await readFile(path.join(dir, "two.txt"), "utf8")).toBe("two\n");
  });
  it.skipIf(process.platform !== "linux")(
    "reports an indeterminate cell after host crash and starts a fresh host",
    () => {
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "--eval",
          String.raw`
      import {execFileSync} from 'node:child_process';
      import {CodeModeService} from './src/code-mode/service.ts';
      let failed=false;
      const service=new CodeModeService({onError(){failed=true;},transportTimeoutMs:1000});
      try {
        await service.exec({source:'store("cache",7);',tools:[],sessionScope:'scope'});
        const first=await service.exec({source:'await new Promise(()=>{});',tools:[],yieldTimeMs:0,sessionScope:'scope'});
        const id=JSON.stringify(first).match(/cell_[A-Za-z0-9_-]+/)[0];
        const rows=execFileSync('ps',['-o','pid=,args=','--ppid',String(process.pid)],{encoding:'utf8'}).split('\n');
        const row=rows.find(line=>line.includes('codex-code-mode-host'));
        if(!row)throw new Error('No owned host process');
        process.kill(Number(row.trim().split(/\s+/)[0]),'SIGKILL');
        const end=Date.now()+5000;
        while(!failed&&Date.now()<end)await new Promise(r=>setTimeout(r,10));
        let message='';try{await service.wait({cellId:id,sessionScope:'scope'});}catch(error){message=error.message;}
        if(!message.includes('结果不确定'))throw new Error(message);
        const next=await service.exec({source:'text({recovered:load("cache")===undefined});',tools:[],sessionScope:'scope'});
        if(!JSON.stringify(next).includes('recovered')||!JSON.stringify(next).includes('true'))throw new Error('No recovery');
        console.log('host recovery ok');
      } finally {await service.close();}
    `,
        ],
        { cwd: process.cwd(), encoding: "utf8", timeout: 15000 },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("host recovery ok");
    },
  );
});

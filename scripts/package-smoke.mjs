import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(path.join(tmpdir(), "exec-mcp-package-"));
const run = promisify(execFile);
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("请通过 npm run test:package 执行。");
let child;
let client;
let exited;
try {
  const packed = await run(
    process.execPath,
    [npmCli, "pack", "--silent", "--pack-destination", temporary],
    {
      cwd: root,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 120_000,
    },
  );
  const filename = packed.stdout
    .trim()
    .split(/\r?\n/)
    .findLast((line) => /^exec-mcp-.*\.tgz$/.test(line));
  assert.ok(filename, "npm pack did not produce a tarball");
  const isolated = path.join(temporary, "installation");
  await mkdir(isolated);
  await writeFile(
    path.join(isolated, "package.json"),
    '{"name":"exec-mcp-package-smoke","private":true}',
  );
  await run(
    process.execPath,
    [
      npmCli,
      "install",
      "--omit=dev",
      "--legacy-peer-deps",
      "--no-audit",
      "--no-fund",
      "--registry=https://registry.npmjs.org",
      path.join(temporary, filename),
    ],
    {
      cwd: isolated,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 180_000,
    },
  );
  const cli = path.join(
    isolated,
    "node_modules",
    "exec-mcp",
    "dist",
    "src",
    "cli.js",
  );
  const config = path.join(temporary, "config.toml");
  const executeCli = async (args) =>
    (
      await run(process.execPath, [cli, ...args], {
        cwd: isolated,
        timeout: 30_000,
      })
    ).stdout;
  assert.match(await executeCli(["--help"]), /init\|serve\|doctor/);
  await executeCli(["init", "--config", config]);
  const originalConfig = await readFile(config, "utf8");
  await writeFile(config, originalConfig.replace("port = 8891", "port = 0"));
  assert.match(await executeCli(["doctor", "--config", config]), /V8 探针通过/);
  child = spawn(process.execPath, [cli, "serve", "--config", config], {
    cwd: isolated,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  exited = once(child, "exit");
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (text) => {
    stderr += text;
  });
  const url = await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(
      () => reject(new Error(`packaged server did not start: ${stderr}`)),
      15_000,
    );
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error(`packaged server exited early: ${stderr}`));
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (text) => {
      output += text;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/mcp/);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
  });
  client = new Client(
    { name: "package-smoke", version: "1" },
    { versionNegotiation: { mode: "auto" } },
  );
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  assert.deepEqual(
    (await client.listTools()).tools.map((tool) => tool.name),
    ["exec", "wait"],
  );
  const project = path.join(temporary, "project with spaces");
  await mkdir(project);
  const patch =
    "*** Begin Patch\n*** Add File: smoke.txt\n+packaged runtime works\n*** End Patch\n";
  const result = await client.callTool({
    name: "exec",
    arguments: {
      workdir: project,
      source: `text(await tools.apply_patch(${JSON.stringify(patch)})); text({tools:ALL_TOOLS.map(t=>t.name)});`,
    },
  });
  assert.ok(!result.isError, JSON.stringify(result));
  assert.equal(
    await readFile(path.join(project, "smoke.txt"), "utf8"),
    "packaged runtime works\n",
  );
  assert.equal(result.structuredContent, undefined);
  assert.ok(
    result.content.some(
      (block) => block.type === "text" && block.text.includes("tool_search"),
    ),
  );
  const scopedCall = (source, extra = {}) =>
    client.callTool({
      name: "exec",
      arguments: { source, ...extra },
      _meta: { "openai/session": "package-smoke-conversation" },
    });
  const saved = await scopedCall(
    'store("cache", {value:42}); text("hidden");',
    { max_output_tokens: 0 },
  );
  assert.ok(!saved.isError, JSON.stringify(saved));
  assert.equal(saved.content.length, 1);
  const restored = await scopedCall('text(load("cache"));');
  assert.ok(
    restored.content.some(
      (block) => block.type === "text" && block.text === '{"value":42}',
    ),
  );
  const png =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5xkAAAAASUVORK5CYII=";
  const media = await scopedCall(
    `generatedImage({image_url:${JSON.stringify(png)},output_hint:"图片说明"});`,
  );
  assert.ok(!media.isError, JSON.stringify(media));
  assert.equal(
    media.content.filter((block) => block.type === "image").length,
    1,
  );
  assert.equal(
    media.content.filter(
      (block) => block.type === "text" && block.text === "图片说明",
    ).length,
    1,
  );
  console.log(
    "PASS: 独立 tarball 安装、CLI 初始化、固定 V8 探针、MCP 两工具目录、真实补丁、跨 exec 存储、输出预算和图片说明。",
  );
} finally {
  await client?.close();
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    try {
      await exited;
    } finally {
      clearTimeout(timer);
    }
  }
  await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
}

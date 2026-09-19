import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import {
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
  const installationAlias = path.join(temporary, "installation alias");
  await symlink(
    isolated,
    installationAlias,
    process.platform === "win32" ? "junction" : "dir",
  );
  const aliasCli = path.join(
    installationAlias,
    "node_modules",
    "exec-mcp",
    "dist",
    "src",
    "cli.js",
  );
  const aliasHelp = await run(process.execPath, [aliasCli, "--help"], {
    cwd: isolated,
    timeout: 30_000,
  });
  assert.match(aliasHelp.stdout, /init\|serve\|doctor/);
  await executeCli(["init", "--config", config]);
  const originalConfig = await readFile(config, "utf8");
  await writeFile(
    config,
    originalConfig.replace("port = 8891", "port = 0") +
      `
[[skills.config]]
name = "packaged-disabled"
enabled = false
[[skills.config]]
name = "packaged-skill"
enabled = false
[[skills.config]]
path = "./project with spaces/.agents/skills/packaged-skill/SKILL.md"
enabled = true
`,
  );
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
  const skillDirectory = path.join(
    project,
    ".agents",
    "skills",
    "packaged-skill",
  );
  await mkdir(path.join(skillDirectory, "agents"), { recursive: true });
  await writeFile(
    path.join(skillDirectory, "SKILL.md"),
    "---\nname: packaged-skill\ndescription: PRIVATE_PACKAGED_TRIGGER\n---\nPRIVATE_PACKAGED_BODY\n",
  );
  await writeFile(
    path.join(skillDirectory, "agents", "openai.yaml"),
    "policy:\n  allow_implicit_invocation: false\n",
  );
  const disabledDirectory = path.join(
    project,
    ".agents",
    "skills",
    "packaged-disabled",
  );
  await mkdir(disabledDirectory, { recursive: true });
  await writeFile(
    path.join(disabledDirectory, "SKILL.md"),
    "---\nname: packaged-disabled\ndescription: PRIVATE_DISABLED_TRIGGER\n---\nPRIVATE_DISABLED_BODY\n",
  );
  const skillsResult = await client.callTool({
    name: "exec",
    arguments: {
      workdir: project,
      source: "text(await tools.list_skills({}));",
    },
  });
  assert.ok(!skillsResult.isError, JSON.stringify(skillsResult));
  const skillsText = skillsResult.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  assert.match(skillsText, /packaged-skill/);
  assert.match(skillsText, /仅用户明确要求使用/);
  assert.doesNotMatch(
    skillsText,
    /PRIVATE_PACKAGED_TRIGGER|PRIVATE_PACKAGED_BODY/,
  );
  assert.equal(skillsResult.structuredContent, undefined);
  assert.doesNotMatch(
    skillsText,
    /packaged-disabled|PRIVATE_DISABLED_TRIGGER|PRIVATE_DISABLED_BODY/,
  );
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
  // Verify native PTY after a clean tarball installation, not only in the checkout.
  const processFixture = path.join(project, "process fixture.cjs");
  await writeFile(
    processFixture,
    'console.log("PROCESS_READY");let line="";process.stdin.on("data",chunk=>{line+=chunk;if(/[\\r\\n]/.test(line)){process.stdin.pause();process.stdout.write("PROCESS_REPLY:"+line.trim()+"\\n",()=>process.exit(0));}});',
  );
  const quote = (value) =>
    `'${value.replaceAll("'", process.platform === "win32" ? "''" : "'\\''")}'`;
  const command = `${process.platform === "win32" ? "& " : ""}${quote(process.execPath)} ${quote(processFixture)}${process.platform === "win32" ? "; exit $LASTEXITCODE" : ""}`;
  const terminalCall = async (source) => {
    const result = await scopedCall(source, { workdir: project });
    assert.ok(!result.isError, JSON.stringify(result));
    const body = result.content.findLast(
      (block) => block.type === "text" && block.text.startsWith("{"),
    );
    assert.ok(body, JSON.stringify(result));
    return JSON.parse(body.text);
  };
  for (const tty of [false, true]) {
    // Exercise the optional Direct-style overrides, then reuse the instance default.
    const overrides = tty
      ? {}
      : {
          shell: process.platform === "win32" ? "powershell.exe" : "/bin/sh",
          login: false,
        };
    let part = await terminalCall(
      `text(await tools.exec_command(${JSON.stringify({ cmd: command, tty, yield_time_ms: 0, ...overrides })}));`,
    );
    let output = part.output;
    const deadline = Date.now() + 30_000;
    while (!output.includes("PROCESS_READY")) {
      assert.ok(
        part.session_id && Date.now() < deadline,
        JSON.stringify({ part, output }),
      );
      part = await terminalCall(
        `text(await tools.write_stdin({session_id:${JSON.stringify(part.session_id)},yield_time_ms:1000}));`,
      );
      output += part.output;
    }
    assert.ok(part.session_id);
    part = await terminalCall(
      `text(await tools.write_stdin({session_id:${JSON.stringify(part.session_id)},chars:${JSON.stringify(tty ? "smoke\r" : "smoke\n")},yield_time_ms:1000}));`,
    );
    output += part.output;
    while (part.session_id) {
      assert.ok(Date.now() < deadline, JSON.stringify({ part, output }));
      part = await terminalCall(
        `text(await tools.write_stdin({session_id:${JSON.stringify(part.session_id)},yield_time_ms:1000}));`,
      );
      output += part.output;
    }
    assert.equal(part.exit_code, 0);
    assert.match(output, /PROCESS_REPLY:smoke/);
  }
  const undefinedStore = await scopedCall(
    'store("nullable",null);try{store("nullable",undefined)}catch(error){text(String(error));}text({value:load("nullable")});',
  );
  assert.ok(!undefinedStore.isError, JSON.stringify(undefinedStore));
  assert.ok(
    undefinedStore.content.some(
      (block) =>
        block.type === "text" &&
        block.text.includes("Only plain serializable objects can be stored"),
    ),
  );
  assert.ok(
    undefinedStore.content.some(
      (block) => block.type === "text" && block.text === '{"value":null}',
    ),
  );
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
  const exported = await scopedCall(
    'const file = await tools.export_file({path:"smoke.txt"}); store("export-id",file.id);',
    { workdir: project, max_output_tokens: 0 },
  );
  assert.ok(!exported.isError, JSON.stringify(exported));
  const fileLink = exported.content.find(
    (block) => block.type === "resource_link",
  );
  assert.ok(fileLink, "packaged server omitted the native resource link");
  const resource = await client.readResource({
    uri: fileLink.uri,
    _meta: { "openai/session": "package-smoke-conversation" },
  });
  assert.equal(
    Buffer.from(resource.contents[0].blob, "base64").toString("utf8"),
    "packaged runtime works\n",
  );
  const revoked = await scopedCall(
    'await tools.revoke_file({id:load("export-id")});',
  );
  assert.ok(!revoked.isError, JSON.stringify(revoked));
  await assert.rejects(client.readResource({ uri: fileLink.uri }));
  const installedServer = pathToFileURL(
    path.join(isolated, "node_modules", "exec-mcp", "dist", "src", "server.js"),
  ).href;
  const publicCheck = await run(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
    import assert from 'node:assert/strict';
    import {startServer} from ${JSON.stringify(installedServer)};
    import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
    process.env.EXEC_MCP_PACKAGE_TOKEN='package-fixture-token-012345678901234567890123';
    const server=await startServer({host:'127.0.0.1',port:0,access:'public',public_url:'https://package.example.test',auth:{type:'bearer',token_env:'EXEC_MCP_PACKAGE_TOKEN'},mcpServers:[]});
    const client=new Client({name:'packaged-public',version:'1'});
    try{
      assert.equal((await fetch(server.url)).status,401);
      await client.connect(new StreamableHTTPClientTransport(new URL(server.url),{requestInit:{headers:{Authorization:'Bearer '+process.env.EXEC_MCP_PACKAGE_TOKEN}}}));
      const result=await client.callTool({name:'exec',arguments:{source:'text(42);'}});
      assert.ok(!result.isError&&result.content.some(x=>x.type==='text'&&x.text==='42'));
      console.log('PUBLIC_AUTH_OK');
    }finally{await client.close();await server.close();}
  `,
    ],
    { cwd: isolated, timeout: 30_000 },
  );
  assert.match(publicCheck.stdout, /PUBLIC_AUTH_OK/);
  await assert.rejects(executeCli(["tunnel", "--config", config])); // The private mode must never publish a tunnel.
  console.log(
    "PASS: 独立 tarball 安装、CLI、管道/PTY、固定 V8、文件/Skill，以及公网认证和私有模式 Tunnel 拒绝。",
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

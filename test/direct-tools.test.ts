import { afterEach, describe, expect, it } from "vitest";
import { readFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
} from "@modelcontextprotocol/client";
import { startServer } from "../src/server.js";
import { ArtifactStore } from "../src/files/artifacts.js";
import { ActivityStore } from "../src/web/activity.js";
import { startWebServer } from "../src/web/server.js";
import { TOP_LEVEL_TOOL_NAMES } from "../src/tool-names.js";
import {
  nativeContracts,
  directContract,
  jsonSchema,
  describeContract,
} from "../src/catalog.js";
import { resolveShell, findShellExecutable } from "../src/host/shell.js";
import { directResult } from "../src/results.js";
import { MODEL_TEXT_BYTES } from "../src/code-mode/model-output.js";
import type { TerminalResult } from "../src/host/terminal.js";
import {
  cellId,
  jsonOutput,
  nodeCommand,
  observeTerminal,
  texts,
} from "./helpers.js";

const cleanups: (() => Promise<unknown>)[] = [];
// The SDK adds private transport metadata after the runtime prepares its response.
const visibleResult = ({ _meta: _private, ...result }: CallToolResult) =>
  result;
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
const directory = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "exec-direct-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
};
async function setup(legacy: boolean) {
  const root = await directory();
  const bytes = Buffer.from("raw file `${name}` \\uXXXX 中文\n");
  let downloads = 0;
  const artifacts = new ArtifactStore(undefined, {
    download: async () => {
      downloads++;
      return Object.assign(Readable.from([bytes]), {
        headers: { "content-length": String(bytes.length) },
      });
    },
  });
  const activity = new ActivityStore();
  const config = {
    host: "127.0.0.1" as const,
    port: 0,
    access: "openai-tunnel" as const,
    mcpServers: [],
  };
  const server = await startServer(config, { artifacts, activity });
  cleanups.push(() => server.close());
  const client = new Client(
    { name: "direct-test", version: "1" },
    { versionNegotiation: { mode: legacy ? "legacy" : "auto" } },
  );
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
  cleanups.push(() => client.close());
  const file = {
    download_url:
      "https://fixture.example/file?secret=SYNTHETIC_SIGNED_FILE_URL",
    file_id: "host-bound-fixture",
    size: bytes.length,
  };
  const call = (
    name: string,
    args: Record<string, unknown>,
    scope = "direct-conversation",
  ) =>
    client.callTool({
      name,
      arguments: args,
      _meta: { "openai/session": scope },
    });
  return {
    root,
    bytes,
    file,
    client,
    server,
    config,
    activity,
    call,
    downloads: () => downloads,
  };
}
const add = (name: string, body: string) =>
  `*** Begin Patch\n*** Add File: ${name}\n${body
    .trimEnd()
    .split("\n")
    .map((line) => "+" + line)
    .join("\n")}\n*** End Patch\n`;
const digest = (value: Buffer | string) =>
  createHash("sha256").update(value).digest("hex");

describe.each([false, true])(
  "direct and nested native tools over MCP (legacy=%s)",
  (legacy) => {
    it("advertises all ten object-input tools with native contracts, no duplicated exec catalog and no V8 startup", async () => {
      const t = await setup(legacy);
      const tools = (await t.client.listTools()).tools;
      expect(tools.map((tool) => tool.name)).toEqual(TOP_LEVEL_TOOL_NAMES);
      expect(tools).toHaveLength(10);
      const exec = tools.find((tool) => tool.name === "exec")!;
      expect(exec.description).not.toContain("输入 JSON Schema");
      expect(exec.description).not.toContain("Lark grammar");
      expect(exec.description).not.toContain("优先使用顶层");
      expect(exec.description).not.toContain("必须通过 exec");
      for (const contract of nativeContracts(resolveShell())) {
        const direct = tools.find((tool) => tool.name === contract.name)!;
        expect(direct.inputSchema).toMatchObject(
          jsonSchema(directContract(contract).schema),
        );
        expect(direct.description).toBe(directContract(contract).description);
        expect(direct.inputSchema.type).toBe("object");
        expect(exec.description).toContain(contract.name);
      }
      expect(
        tools.find((tool) => tool.name === "import_file")!._meta,
      ).toMatchObject({ "openai/fileParams": ["file"] });
      expect(
        (await t.server.runtime.codeMode.getMemoryStatus()).hostPid,
      ).toBeUndefined();
    });
    it("passes a large Markdown patch as data, preserves every delimiter, and shares edits with nested apply_patch", async () => {
      const t = await setup(legacy);
      const block = await readFile(
        new URL("./fixtures/direct-markdown.md", import.meta.url),
        "utf8",
      );
      const body = block.repeat(600).trimEnd() + "\n";
      expect(Buffer.byteLength(body)).toBeGreaterThan(256 * 1024);
      const result = await t.call("apply_patch", {
        workdir: t.root,
        patch: add("raw.md", body),
      });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        success: true,
        exit_code: 0,
      });
      expect(result.content).toEqual([]);
      expect(digest(await readFile(path.join(t.root, "raw.md")))).toBe(
        digest(body),
      );
      expect(
        (await t.server.runtime.codeMode.getMemoryStatus()).hostPid,
      ).toBeUndefined();
      const patch =
        "*** Begin Patch\n*** Update File: raw.md\n@@\n-# 原文回归\n+# Updated\n*** End Patch\n";
      const nested = await t.call("exec", {
        workdir: t.root,
        source: `text(await tools.apply_patch(${JSON.stringify(patch)}));`,
      });
      expect(nested.isError, JSON.stringify(nested)).not.toBe(true);
      expect(digest(await readFile(path.join(t.root, "raw.md")))).toBe(
        digest(body.replace("# 原文回归", "# Updated")),
      );
      const directAgain = await t.call("apply_patch", {
        workdir: t.root,
        patch:
          "*** Begin Patch\n*** Update File: raw.md\n@@\n-# Updated\n+# Final\n*** End Patch\n",
      });
      expect(directAgain.isError).not.toBe(true);
    });
    it("applies the documented direct patch as exact data without template escaping", async () => {
      const t = await setup(legacy);
      const docs = await readFile(
        new URL("../docs/code-mode-examples.md", import.meta.url),
        "utf8",
      );
      const patch = /````diff\n([\s\S]*?)\n````/.exec(docs)?.[1];
      expect(patch).toBeDefined();
      const result = await t.call("apply_patch", {
        patch: patch!,
        workdir: t.root,
      });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(
        await readFile(path.join(t.root, "literal-example.md"), "utf8"),
      ).toBe(
        '# 原文示例\nInline: `review`，字面量 ${name}，路径 C:\\work\\new\\file.txt。\n```powershell\nWrite-Output "`tname`nnext"\n```\n',
      );
    });
    it("passes Shell raw text without evaluating its backticks or interpolation as JavaScript", async () => {
      const t = await setup(legacy);
      const code =
        'console.log(JSON.stringify({fence:"```bash",placeholder:"${name}",path:String.raw`C:\\work\\new\\file.txt`}));';
      const first = await t.call("exec_command", {
        cmd: nodeCommand(code),
        workdir: t.root,
        yield_time_ms: 0,
      });
      expect(first.isError).not.toBe(true);
      const result = await observeTerminal(
        jsonOutput<TerminalResult>(first),
        async (input) =>
          jsonOutput<TerminalResult>(
            await t.call(
              "write_stdin",
              input as unknown as Record<string, unknown>,
            ),
          ),
      );
      expect(result.exit_code).toBe(0);
      expect(JSON.parse(result.output)).toEqual({
        fence: "```bash",
        placeholder: "${name}",
        path: String.raw`C:\work\new\file.txt`,
      });
      expect(
        (await t.server.runtime.codeMode.getMemoryStatus()).hostPid,
      ).toBeUndefined();
    });
    it("bounds an actual large direct command response without losing exit metadata", async () => {
      const t = await setup(legacy);
      const first = await t.call("exec_command", {
        cmd: nodeCommand(
          'process.stdout.write("HEAD_MARKER\\n"+"x".repeat(100000)+"\\nTAIL_MARKER");',
        ),
        workdir: t.root,
        yield_time_ms: 30000,
      });
      expect(first.isError).not.toBe(true);
      expect(first.structuredContent).toBeUndefined();
      expect(
        texts(first).reduce(
          (bytes, text) => bytes + Buffer.byteLength(text) + 2,
          0,
        ),
      ).toBeLessThanOrEqual(MODEL_TEXT_BYTES);
      expect(texts(first)[0]).toContain('"exit_code":0');
      expect(texts(first).join("\n")).toContain("HEAD_MARKER");
      expect(texts(first).join("\n")).toContain("TAIL_MARKER");
      expect(texts(first).join("\n")).not.toContain("cell_");
      expect(
        (await t.server.runtime.codeMode.getMemoryStatus()).hostPid,
      ).toBeUndefined();
    });
    it("crosses the direct/nested boundary in both directions with the same terminal handle", async () => {
      const t = await setup(legacy);
      const cmd = nodeCommand(
        'console.log("READY");process.stdin.once("data",b=>{process.stdout.write("REPLY:"+b.toString(),()=>process.exit(0));});',
      );
      for (const directFirst of [false, true]) {
        const first = directFirst
          ? await t.call("exec_command", { cmd, yield_time_ms: 0 })
          : await t.call("exec", {
              source: `text(await tools.exec_command(${JSON.stringify({ cmd, yield_time_ms: 0 })}));`,
            });
        const ready = await observeTerminal(
          jsonOutput<TerminalResult>(first),
          async (input) =>
            jsonOutput<TerminalResult>(
              await t.call(
                "write_stdin",
                input as unknown as Record<string, unknown>,
              ),
            ),
          (r) => r.output.includes("READY"),
        );
        const input = {
          session_id: ready.session_id!,
          chars: "literal `${name}`\n",
          yield_time_ms: 0,
        };
        const sent = directFirst
          ? await t.call("exec", {
              source: `text(await tools.write_stdin(${JSON.stringify(input)}));`,
            })
          : await t.call("write_stdin", input);
        const result = await observeTerminal(
          jsonOutput<TerminalResult>(sent),
          async (value) =>
            jsonOutput<TerminalResult>(
              await t.call(
                "write_stdin",
                value as unknown as Record<string, unknown>,
              ),
            ),
        );
        expect(result.output).toContain("REPLY:literal `${name}`");
        expect(result.exit_code).toBe(0);
      }
    });
    it("uses the same complete search snapshot without putting those descriptions back in exec", async () => {
      const t = await setup(legacy);
      const direct = jsonOutput<{
        tools: { name: string; description: string }[];
      }>(await t.call("tool_search", { query: "apply_patch", limit: 1 }));
      expect(direct.tools[0]!.name).toBe("apply_patch");
      const nested = jsonOutput<{ name: string; description: string }>(
        await t.call("exec", {
          source: 'text(ALL_TOOLS.find(t=>t.name==="apply_patch"));',
        }),
      );
      expect(direct.tools[0]).toEqual(nested);
      expect(nested.description).toContain("await tools.apply_patch(patch)");
      expect(nested.description).toBe(
        describeContract(
          nativeContracts(resolveShell()).find(
            (t) => t.name === "apply_patch",
          )!,
        ),
      );
    });
    it("discovers the same project Skills directly and inside exec", async () => {
      const t = await setup(legacy);
      const directory = path.join(t.root, ".agents", "skills", "native-entry");
      await mkdir(directory, { recursive: true });
      await writeFile(
        path.join(directory, "SKILL.md"),
        "---\nname: native-entry\ndescription: For native entry regression\n---\nSynthetic skill body.\n",
      );
      const direct = await t.call("list_skills", { workdir: t.root });
      expect(direct.isError).not.toBe(true);
      expect(texts(direct).join("\n")).toContain("native-entry");
      expect(
        (await t.server.runtime.codeMode.getMemoryStatus()).hostPid,
      ).toBeUndefined();
      const nested = await t.call("exec", {
        workdir: t.root,
        source: "text(await tools.list_skills({}));",
      });
      expect(texts(nested)).toContain(texts(direct)[0]);
    });
    it("cancels an unreturned direct command through the same process cleanup path, without a cell", async () => {
      const t = await setup(legacy);
      const abort = new AbortController();
      const pending = t.client.callTool(
        {
          name: "exec_command",
          arguments: {
            cmd: nodeCommand("setInterval(()=>{},1000);"),
            yield_time_ms: 30000,
          },
        },
        { signal: abort.signal },
      );
      const observed = pending.catch((error) => error);
      const deadline = Date.now() + 5000;
      while (
        !t.server.runtime.terminal["sessions"].size &&
        Date.now() < deadline
      )
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(t.server.runtime.terminal["sessions"].size).toBe(1);
      abort.abort();
      await observed;
      const cleanupDeadline = Date.now() + 10000;
      while (
        t.server.runtime.terminal["sessions"].size &&
        Date.now() < cleanupDeadline
      )
        await new Promise((resolve) => setTimeout(resolve, 20));
      expect(t.server.runtime.terminal["sessions"].size).toBe(0);
      expect(
        (await t.server.runtime.codeMode.getMemoryStatus()).hostPid,
      ).toBeUndefined();
    });
    it("imports host-bound files directly, exports native resources, and retains scope and audit boundaries", async () => {
      const t = await setup(legacy);
      const destination = path.join(t.root, "imported.txt");
      const result = await t.call("import_file", { file: t.file, destination });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(await readFile(destination)).toEqual(t.bytes);
      expect(t.downloads()).toBe(1);
      expect(
        (await t.call("import_file", { index: 0, destination })).isError,
      ).toBe(true);
      const exported = await t.call("export_file", { path: destination });
      expect(exported.structuredContent).toMatchObject({
        size: t.bytes.length,
        sha256: digest(t.bytes),
      });
      const link = exported.content.find(
        (item) => item.type === "resource_link",
      )!;
      expect(link).toBeDefined();
      if (link.type !== "resource_link") throw new Error("missing resource");
      const read = await t.client.readResource({
        uri: link.uri,
        _meta: { "openai/session": "direct-conversation" },
      });
      expect(JSON.stringify(read)).toContain(t.bytes.toString("base64"));
      await expect(
        t.client.readResource({
          uri: link.uri,
          _meta: { "openai/session": "foreign-conversation" },
        }),
      ).rejects.toThrow();
      expect(JSON.stringify(t.activity.getCalls())).not.toContain(
        "SYNTHETIC_SIGNED_FILE_URL",
      );
      expect(
        (await t.server.runtime.codeMode.getMemoryStatus()).hostPid,
      ).toBeUndefined();
    });
    it("returns an existing image as a native content block without booting a cell", async () => {
      const t = await setup(legacy);
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZAAAAABJRU5ErkJggg==",
        "base64",
      );
      const file = path.join(t.root, "image.png");
      await writeFile(file, png);
      const result = await t.call("view_image", {
        path: file,
        detail: "original",
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toBeUndefined();
      expect(result.content).toEqual([
        {
          type: "image",
          data: png.toString("base64"),
          mimeType: "image/png",
          _meta: { "codex/imageDetail": "original" },
        },
      ]);
      expect(
        (await t.server.runtime.codeMode.getMemoryStatus()).hostPid,
      ).toBeUndefined();
    });
    it("logs direct calls under their real names and keeps previews, filtering and raw input available in Web", async () => {
      const t = await setup(legacy);
      const web = await startWebServer(t.server.runtime, t.config, {
        port: 0,
        publicDir: t.root,
      });
      cleanups.push(() => web.close());
      const patch = add("web.md", "# Web fixture\n");
      await t.call("apply_patch", { patch, workdir: t.root });
      const response = await fetch(
        new URL("api/calls?tool=apply_patch&search=web.md", web.loopbackUrl),
      );
      const list = (await response.json()) as {
        items: { id: string; tool: string; args: { patch: string } }[];
      };
      expect(list.items).toHaveLength(1);
      expect(list.items[0]!.tool).toBe("apply_patch");
      expect(list.items[0]!.args.patch).toBe("*** Add File: web.md");
      const detail = (await (
        await fetch(new URL("api/calls/" + list.items[0]!.id, web.loopbackUrl))
      ).json()) as { args: { patch: string }; subcalls: unknown[] };
      expect(detail.args.patch).toBe(patch);
      expect(detail.subcalls).toHaveLength(0);
      expect(t.activity.getSessions().items[0]!.lastCall!.preview).toBe(
        "*** Add File: web.md",
      );
    });
    it("retains search options and the actual direct MCP response in the audit", async () => {
      const t = await setup(legacy);
      const result = await t.call("tool_search", {
        query: "apply_patch",
        limit: 1,
      });
      const call = t.activity.getCalls({ tool: "tool_search" }).items[0]!;
      expect(call.args).toEqual({ query: "apply_patch", limit: 1 });
      expect(call.status).toBe("completed");
      expect(call.output).toEqual(visibleResult(result));
      expect(call.subcalls).toEqual([]);
      const tools = (await t.client.listTools()).tools;
      expect(
        tools.find((tool) => tool.name === "tool_search")!.description,
      ).toContain("对象结果在 structuredContent");
      expect(tools[0]!.description).toContain("本机对象结果直接返回");
    });
    it("keeps max_tokens under its actual wait parameter name and retains zero and false", async () => {
      const t = await setup(legacy);
      const first = await t.call("exec", {
        source: "yield_control();await new Promise(()=>{});",
      });
      expect(first.isError).not.toBe(true);
      const id = cellId(first);
      const args = {
        cell_id: id,
        yield_time_ms: 0,
        max_tokens: 0,
        terminate: false,
      };
      const response = await t.call("wait", args);
      const call = t.activity.getCalls({ tool: "wait" }).items[0]!;
      expect(call.args).toEqual(args);
      expect(call.output).toEqual(visibleResult(response));
      await t.call("wait", { cell_id: id, terminate: true });
    });
    it("keeps safe host file metadata in direct and exec audit inputs without their credentials", async () => {
      const t = await setup(legacy);
      const file = {
        ...t.file,
        file_name: "report.txt",
        mime_type: "text/plain",
      };
      await t.call("import_file", {
        file,
        destination: path.join(t.root, "direct.txt"),
        overwrite: false,
      });
      await t.call("exec", { files: [file], source: "text(42);" });
      const metadata = {
        name: "report.txt",
        type: "text/plain",
        size: t.bytes.length,
      };
      expect(
        t.activity.getCalls({ tool: "import_file" }).items[0]!.args.file,
      ).toEqual(metadata);
      expect(
        t.activity.getCalls({ tool: "exec" }).items[0]!.args.files,
      ).toEqual([metadata]);
      expect(JSON.stringify(t.activity.getCalls())).not.toMatch(
        /SYNTHETIC_SIGNED_FILE_URL|host-bound-fixture|download_url/,
      );
    });
    it("records an explicit direct termination as terminated, preserving the actual exit result", async () => {
      const t = await setup(legacy);
      const first = await t.call("exec_command", {
        cmd: nodeCommand("setInterval(()=>{},1000);"),
        workdir: t.root,
        yield_time_ms: 0,
      });
      const id = jsonOutput<TerminalResult>(first).session_id!;
      const result = await t.call("write_stdin", {
        session_id: id,
        terminate: true,
      });
      const call = t.activity.getCalls({ tool: "write_stdin" }).items[0]!;
      expect(call.status).toBe("terminated");
      expect(call.output).toEqual(visibleResult(result));
      expect(jsonOutput<TerminalResult>(result).exit_code).toBeDefined();
    });
  },
);

it("requires public authentication before dispatching any of the new direct tools", async () => {
  const root = await directory();
  const key = "EXEC_MCP_DIRECT_BOUNDARY_TEST";
  const previous = process.env[key];
  const token = "synthetic-direct-boundary-token-01234567890123456789";
  process.env[key] = token;
  cleanups.push(async () => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  });
  const server = await startServer({
    host: "127.0.0.1",
    port: 0,
    access: "public",
    public_url: "https://direct.example.test",
    mcpServers: [],
    auth: { type: "bearer", token_env: key },
  });
  cleanups.push(() => server.close());
  for (const name of TOP_LEVEL_TOOL_NAMES.slice(2)) {
    const response = await fetch(server.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name,
          arguments: { patch: add("denied.md", "not written"), workdir: root },
        },
      }),
    });
    expect(response.status).toBe(401);
    await response.text();
  }
  await expect(readFile(path.join(root, "denied.md"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  const client = new Client({ name: "authenticated-direct", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  cleanups.push(() => client.close());
  const result = await client.callTool({
    name: "apply_patch",
    arguments: {
      patch: add("allowed.md", "written after authentication"),
      workdir: root,
    },
  });
  expect(result.isError).not.toBe(true);
  expect(await readFile(path.join(root, "allowed.md"), "utf8")).toContain(
    "written after authentication",
  );
});

describe("direct response budget", () => {
  it("retains large-output handles and status, with one representation, no spill and a bounded text fallback", () => {
    const result = directResult("exec_command", {
      output: "first" + "x".repeat(100000) + "last",
      wall_time_seconds: 0.2,
      session_id: "term-known",
      stderr_bytes: 3,
    });
    expect(result.structuredContent).toBeUndefined();
    expect(
      texts(result).reduce(
        (size, text) => size + Buffer.byteLength(text) + 2,
        0,
      ),
    ).toBeLessThanOrEqual(MODEL_TEXT_BYTES);
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect(texts(result)[0]).toContain("term-known");
    expect(texts(result).join("\n")).toContain("first");
    expect(texts(result).join("\n")).toContain("last");
    expect(texts(result).join("\n")).not.toContain("outputFile");
    const failed = directResult(
      "exec_command",
      { output: "expected failure", exit_code: 1, wall_time_seconds: 0 },
      true,
    );
    expect(failed).toEqual({
      content: [],
      isError: true,
      structuredContent: {
        output: "expected failure",
        exit_code: 1,
        wall_time_seconds: 0,
      },
    });
  });
});

const powershell = findShellExecutable(
  process.platform === "win32" ? "pwsh.exe" : "pwsh",
);
describe.skipIf(!powershell)("literal PowerShell input over direct MCP", () => {
  it.each([false, true])(
    "preserves PowerShell backticks and a nested JavaScript here-string without a JS wrapper (legacy=%s)",
    async (legacy) => {
      const t = await setup(legacy);
      const cmd = await readFile(
        new URL("./fixtures/direct-shell.ps1", import.meta.url),
        "utf8",
      );
      const first = await t.call("exec_command", {
        cmd,
        shell: powershell!,
        login: false,
        workdir: t.root,
        yield_time_ms: 0,
      });
      const result = await observeTerminal(
        jsonOutput<TerminalResult>(first),
        async (input) =>
          jsonOutput<TerminalResult>(
            await t.call(
              "write_stdin",
              input as unknown as Record<string, unknown>,
            ),
          ),
      );
      expect(result.exit_code).toBe(0);
      expect(result.output).toContain("\tPS_BACKTICK");
      expect(result.output).toContain("NEXT_LINE");
      expect(result.output).toContain("%h`t%ad`t%an`t%s");
      const json = result.output
        .split(/\r?\n/)
        .find((line) => line.startsWith("{"))!;
      expect(JSON.parse(json)).toEqual({
        id: "a.ts:7|b.ts:8|9",
        path: String.raw`C:\work\new\file.txt`,
        matched: true,
        literal: "${notDefined}",
        fence: "```bash",
      });
      expect(
        (await t.server.runtime.codeMode.getMemoryStatus()).hostPid,
      ).toBeUndefined();
    },
  );
});

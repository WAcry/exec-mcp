import { afterEach, describe, expect, it, vi } from "vitest";
import { readFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { startServer } from "../src/server.js";
import { ArtifactStore } from "../src/files/artifacts.js";
import { ActivityStore } from "../src/web/activity.js";
import { startWebServer } from "../src/web/server.js";
import { describeContract, nativeContracts } from "../src/catalog.js";
import { findShellExecutable } from "../src/host/shell.js";
import { modelTextBytes } from "../src/session-notes.js";
import type { TerminalResult } from "../src/host/terminal.js";
import {
  cellId,
  jsonOutput,
  nativeRequest,
  nodeCommand,
  observeTerminal,
  texts,
} from "./helpers.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function setup(legacy: boolean) {
  const root = await mkdtemp(path.join(tmpdir(), "exec-native-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
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
    { name: "native-test", version: "1" },
    { versionNegotiation: { mode: legacy ? "legacy" : "auto" } },
  );
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
  cleanups.push(() => client.close());
  const exec = (source: string, extra: Record<string, unknown> = {}) =>
    client.callTool({
      name: "exec",
      arguments: { workdir: root, source, ...extra },
      _meta: { "openai/session": "native-conversation" },
    });
  const call = (name: string, args: Record<string, unknown>) =>
    client.callTool({
      ...nativeRequest(name, args),
      _meta: { "openai/session": "native-conversation" },
    });
  const file = {
    download_url:
      "https://fixture.example/file?secret=SYNTHETIC_SIGNED_FILE_URL",
    file_id: "host-bound-fixture",
    file_name: "report.txt",
    mime_type: "text/plain",
    size: bytes.length,
  };
  return {
    root,
    bytes,
    file,
    client,
    server,
    config,
    activity,
    exec,
    call,
    downloads: () => downloads,
  };
}
const digest = (value: Buffer | string) =>
  createHash("sha256").update(value).digest("hex");
const patch = (name: string, body: string) =>
  `*** Begin Patch\n*** Add File: ${name}\n${body
    .trimEnd()
    .split("\n")
    .map((line) => "+" + line)
    .join("\n")}\n*** End Patch\n`;

describe.each([false, true])(
  "Code Mode Only native tools over actual MCP (legacy=%s)",
  (legacy) => {
    it("advertises just exec/wait with complete native contracts without needing a discovery call", async () => {
      const t = await setup(legacy);
      const tools = (await t.client.listTools()).tools;
      expect(tools.map((tool) => tool.name)).toEqual(["exec", "wait"]);
      expect(tools[0]!._meta).toMatchObject({ "openai/fileParams": ["files"] });
      const contracts = nativeContracts(t.server.runtime.terminal.shell);
      for (const contract of contracts) {
        expect(tools[0]!.description).toContain(describeContract(contract));
        await expect(
          t.client.callTool({ name: contract.name, arguments: {} }),
        ).rejects.toThrow();
      }
      expect(
        (await t.server.runtime.codeMode.getMemoryStatus()).hostPid,
      ).toBeUndefined();
      const result = await t.exec(
        `text(await tools.apply_patch(${JSON.stringify(patch("first.txt", "created on first exec"))}));`,
      );
      expect(result.isError).not.toBe(true);
      expect(jsonOutput(result)).toMatchObject({ success: true, exit_code: 0 });
      expect(await readFile(path.join(t.root, "first.txt"), "utf8")).toBe(
        "created on first exec\n",
      );
    });

    it("preserves a large Markdown patch across two fresh isolates", async () => {
      const t = await setup(legacy);
      const block = await readFile(
        new URL("./fixtures/direct-markdown.md", import.meta.url),
        "utf8",
      );
      const body = block.repeat(600).trimEnd() + "\n";
      expect(Buffer.byteLength(body)).toBeGreaterThan(256 * 1024);
      const added = await t.exec(
        `text(await tools.apply_patch(${JSON.stringify(patch("large.md", body))}));`,
      );
      expect(jsonOutput(added)).toMatchObject({ success: true });
      expect(digest(await readFile(path.join(t.root, "large.md")))).toBe(
        digest(body),
      );
      const update =
        "*** Begin Patch\n*** Update File: large.md\n@@\n-# 原文回归\n+# Updated\n*** End Patch\n";
      expect(
        jsonOutput(
          await t.exec(
            `text(await tools.apply_patch(${JSON.stringify(update)}));`,
          ),
        ),
      ).toMatchObject({ success: true });
      expect(digest(await readFile(path.join(t.root, "large.md")))).toBe(
        digest(body.replace("# 原文回归", "# Updated")),
      );
    });

    it("keeps terminal handles usable across independent exec cells", async () => {
      const t = await setup(legacy);
      const first = jsonOutput<TerminalResult>(
        await t.call("exec_command", {
          cmd: nodeCommand(
            'console.log("READY");process.stdin.once("data",b=>process.stdout.write("REPLY:"+b,()=>process.exit(0)));',
          ),
          yield_time_ms: 0,
        }),
      );
      const read = async (input: object) =>
        jsonOutput<TerminalResult>(await t.call("write_stdin", { ...input }));
      const ready = await observeTerminal(first, read, (value) =>
        value.output.includes("READY"),
      );
      const input = {
        session_id: ready.session_id!,
        chars: "literal `${name}`\n",
        yield_time_ms: 0,
      };
      const final = await observeTerminal(await read(input), read);
      expect(final.output).toContain("REPLY:literal `${name}`");
      expect(final.exit_code).toBe(0);
      const record = t.activity
        .getCalls()
        .items.find((call) =>
          call.subcalls.some(
            (sub) => JSON.stringify(sub.input) === JSON.stringify(input),
          ),
        )!;
      expect(record.tool).toBe("exec");
      expect(record.subcalls[0]!.input).toEqual(input);
    });

    it("lets JS inspect full large results before the model output limit and retain only selected data", async () => {
      const t = await setup(legacy);
      const command = nodeCommand(
        'process.stdout.write("HEAD_MARKER\\n"+"x".repeat(100000)+"\\nTAIL_MARKER");',
      );
      const result = await t.exec(
        `const r=await tools.exec_command({cmd:${JSON.stringify(command)},yield_time_ms:30000});store('log',r);text({length:r.output.length,exit:r.exit_code,tail:r.output.slice(-11)});`,
        { yield_time_ms: 30000 },
      );
      expect(jsonOutput(result)).toEqual({
        length: 100024,
        exit: 0,
        tail: "TAIL_MARKER",
      });
      const preview = await t.exec("text(load('log'));");
      expect(modelTextBytes(preview)).toBeLessThanOrEqual(36000);
      expect(texts(preview).join("\n")).toContain("保留首尾");
      expect(jsonOutput(await t.exec("text(load('log').output.length);"))).toBe(
        100024,
      );
    });

    it("imports indexed host files, exports native links and preserves resource ownership and audit privacy", async () => {
      const t = await setup(legacy);
      const result = await t.exec(
        "const r=await tools.import_file({index:0,destination:'imported.txt'});text(r);await tools.export_file({path:r.path});",
        { files: [t.file] },
      );
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(await readFile(path.join(t.root, "imported.txt"))).toEqual(
        t.bytes,
      );
      expect(t.downloads()).toBe(1);
      expect(jsonOutput(result)).toMatchObject({
        size: t.bytes.length,
        sha256: digest(t.bytes),
      });
      const link = result.content.find(
        (item) => item.type === "resource_link",
      )!;
      if (link.type !== "resource_link") throw new Error("missing resource");
      expect(link.description).toContain("File snapshot expires at");
      expect(link.description).not.toMatch(/\p{Script=Han}/u);
      const read = await t.client.readResource({
        uri: link.uri,
        _meta: { "openai/session": "native-conversation" },
      });
      expect(JSON.stringify(read)).toContain(t.bytes.toString("base64"));
      await expect(
        t.client.readResource({
          uri: link.uri,
          _meta: { "openai/session": "foreign" },
        }),
      ).rejects.toThrow();
      const call = t.activity.getCalls().items[0]!;
      expect(call.args.files).toEqual([
        { name: "report.txt", type: "text/plain", size: t.bytes.length },
      ]);
      expect(call.subcalls.map((item) => item.name)).toEqual([
        "import_file",
        "export_file",
      ]);
      expect(JSON.stringify(call)).not.toMatch(
        /SYNTHETIC_SIGNED_FILE_URL|host-bound-fixture|download_url/,
      );
      const invalid = await t.exec(
        "await tools.import_file({index:1,destination:'other.txt'});",
        { files: [t.file] },
      );
      expect(invalid.isError).toBe(true);
      expect(t.downloads()).toBe(1);
    });

    it("emits native images only when explicitly passed to image", async () => {
      const t = await setup(legacy);
      const data =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZAAAAABJRU5ErkJggg==";
      await writeFile(
        path.join(t.root, "pixel.png"),
        Buffer.from(data, "base64"),
      );
      const hidden = await t.exec(
        "await tools.view_image({path:'pixel.png'});",
      );
      expect(hidden.content.some((item) => item.type === "image")).toBe(false);
      const shown = await t.exec(
        "image((await tools.view_image({path:'pixel.png',detail:'original'})).content[0]);",
      );
      expect(shown.isError).not.toBe(true);
      expect(shown.content.find((item) => item.type === "image")).toMatchObject(
        { type: "image", data, mimeType: "image/png" },
      );
    });

    it("discovers project skills through both the exec default and an explicit nested workdir", async () => {
      const t = await setup(legacy);
      const directory = path.join(t.root, ".agents", "skills", "native-entry");
      await mkdir(directory, { recursive: true });
      await writeFile(
        path.join(directory, "SKILL.md"),
        "---\nname: native-entry\ndescription: For native entry regression\n---\nSynthetic skill body.\n",
      );
      const explicit = await t.call("list_skills", { workdir: t.root });
      const implicit = await t.exec("text(await tools.list_skills({}));");
      expect(texts(explicit).join("\n")).toContain("native-entry");
      const directoryText = texts(explicit).find((text) =>
        text.includes("Skill 目录"),
      )!;
      expect(texts(implicit)).toContain(directoryText);
    });

    it("cancels an unreturned command through cell cancellation and cleans up the unexposed process", async () => {
      const t = await setup(legacy);
      const abort = new AbortController();
      const pending = t.client.callTool(
        {
          name: "exec",
          arguments: {
            source: `text(await tools.exec_command({cmd:${JSON.stringify(nodeCommand("setInterval(()=>{},1000);"))},yield_time_ms:30000}));`,
            yield_time_ms: 30000,
          },
        },
        { signal: abort.signal },
      );
      const observed = pending.catch((error) => error);
      await vi.waitFor(
        () =>
          expect(t.server.runtime.terminal.getActiveSessions()).toHaveLength(1),
        { timeout: 10000 },
      );
      abort.abort();
      await observed;
      await vi.waitFor(
        () =>
          expect(t.server.runtime.terminal.getActiveSessions()).toHaveLength(0),
        { timeout: 10000 },
      );
    });

    it("keeps cmd and freeform patch inputs visible as subcalls in Web, including failures", async () => {
      const t = await setup(legacy);
      const web = await startWebServer(t.server.runtime, t.config, {
        port: 0,
        configPath: path.join(t.root, "config.toml"),
      });
      cleanups.push(() => web.close());
      const sourcePatch = patch("web.md", "# Web `raw`\n");
      const result = await t.exec(
        `text(await tools.apply_patch(${JSON.stringify(sourcePatch)}));text(await tools.exec_command({cmd:${JSON.stringify(nodeCommand("process.exit(3);"))},yield_time_ms:30000}));`,
      );
      expect(result.isError).not.toBe(true); // JS succeeded while deliberately observing a failed command.
      const call = t.activity.getCalls().items[0]!;
      const response = await fetch(
        new URL(`/api/calls/${call.id}`, web.loopbackUrl),
      );
      const body = await response.json();
      expect(body.tool).toBe("exec");
      expect(body.subcalls[0]).toMatchObject({
        name: "apply_patch",
        input: sourcePatch,
        status: "success",
      });
      expect(body.subcalls[1]).toMatchObject({
        name: "exec_command",
        status: "error",
        output: { exit_code: 3 },
      });
      expect(body.output.content).toEqual(result.content);
    });

    it("records wait's exact max_tokens field and cancels only the specified cell", async () => {
      const t = await setup(legacy);
      const first = await t.exec("yield_control();await new Promise(()=>{});");
      const id = cellId(first);
      const args = {
        cell_id: id,
        yield_time_ms: 0,
        max_tokens: 0,
        terminate: false,
      };
      const result = await t.client.callTool({
        name: "wait",
        arguments: args,
        _meta: { "openai/session": "native-conversation" },
      });
      const call = t.activity.getCalls({ tool: "wait" }).items[0]!;
      expect(call.args).toEqual(args);
      expect(call.output).toMatchObject({ content: result.content });
      await t.client.callTool({
        name: "wait",
        arguments: { cell_id: id, terminate: true },
        _meta: { "openai/session": "native-conversation" },
      });
    });
  },
);

const powershell =
  findShellExecutable("pwsh") ?? findShellExecutable("powershell");
describe.skipIf(!powershell)("PowerShell through a Code Mode string", () => {
  it.each([false, true])(
    "preserves backticks, here-strings and nested JavaScript (legacy=%s)",
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
          jsonOutput<TerminalResult>(await t.call("write_stdin", { ...input })),
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
    },
  );
});

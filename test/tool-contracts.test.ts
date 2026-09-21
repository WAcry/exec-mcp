import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  describeContract,
  execDescription,
  nativeContracts,
  EXEC_SCHEMA,
  WAIT_SCHEMA,
} from "../src/catalog.js";
import { TOP_LEVEL_TOOL_NAMES } from "../src/tool-names.js";
import { resolveShell } from "../src/host/shell.js";
import { TerminalManager } from "../src/host/terminal.js";
import {
  connect,
  jsonOutput,
  nodeCommand,
  observeTerminal,
  texts,
} from "./helpers.js";

const connections: Awaited<ReturnType<typeof connect>>[] = [];
const terminals: TerminalManager[] = [];
const directories: string[] = [];
const SKILL_RULE =
  "普通 Skill 可按目录中的触发描述自动选择；标记为仅显式的 Skill 只有用户明确点名要求使用时才能读取。";
const FILE_EDIT_RULE =
  "创建和修改文本文件优先用 tools.apply_patch，避免命令行参数长度限制。";
const MULTILINE_RULE =
  "多行字符串可用模板字面量；String.raw 保留反斜杠，反引号及 ${...} 仍遵循 JS 语法，Shell 引号和 Markdown 围栏不隔离外层模板。";
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

describe("self-contained model-visible contracts", () => {
  it("omits retired user-input fields rather than accepting hidden acknowledgments", () => {
    expect(EXEC_SCHEMA.safeParse({ source: "text(42)" }).success).toBe(true);
    expect(WAIT_SCHEMA.safeParse({ cell_id: "existing-cell" }).success).toBe(
      true,
    );
    for (const ack_user_input of [[], ["old-answer-event"]]) {
      expect(
        EXEC_SCHEMA.safeParse({ source: "text(42)", ack_user_input }).success,
      ).toBe(false);
      expect(
        WAIT_SCHEMA.safeParse({ cell_id: "existing-cell", ack_user_input })
          .success,
      ).toBe(false);
    }
  });
  it("includes skill selection once in exec's native contract and scopes result handling to downstream MCP", () => {
    const contracts = nativeContracts(resolveShell());
    const description = execDescription(contracts);
    expect(description.split("本机及发现契约：")[0]).toContain(SKILL_RULE);
    expect(
      contracts.find((contract) => contract.name === "list_skills")!
        .description,
    ).toContain(SKILL_RULE);
    expect(description).toContain(
      "对下游 MCP 的 CallToolResult，先检查 isError，有 structuredContent 时优先使用",
    );
  });
  it("keeps the current native surface, runtime boundary and actual calling forms without historical instructions", () => {
    const contracts = nativeContracts(resolveShell());
    expect(contracts.map((contract) => contract.name)).toEqual([
      "list_skills",
      "import_file",
      "export_file",
      "exec_command",
      "write_stdin",
      "apply_patch",
      "view_image",
      "request_user_input_async",
    ]);
    const description = execDescription(contracts);
    expect(description).toContain("每次使用新的 V8");
    expect(description.split("本机及发现契约：")[0]).toContain(FILE_EDIT_RULE);
    expect(description.split("本机及发现契约：")[0]).toContain(MULTILINE_RULE);
    expect(description).toContain("文件和网络操作通过 tools 在实际机器执行");
    expect(description).toContain("ChatGPT 容器与该机器不共享文件和网络环境");
    expect(description).toContain("调用失败时先核对已发生的操作");
    expect(description).toContain(
      "宿主拒绝执行时检查请求，再修正或拆分复杂脚本",
    );
    expect(description).toContain("exec.files[index]");
    expect(description).toContain(
      "已知名称和参数可直接 await tools[name](args)",
    );
    expect(description).toContain("ALL_TOOLS.filter");
    expect(description).not.toMatch(
      /revoke_file|\{patch,\s*workdir\}|import_file\(index\)|notify 不支持/,
    );
    for (const contract of contracts) {
      expect(description).toContain(contract.name);
      expect(description).toContain(describeContract(contract));
      expect(description.split(`### ${contract.name}\n`)).toHaveLength(2);
    }
    const patch = contracts.find(
      (contract) => contract.name === "apply_patch",
    )!;
    expect(
      patch.schema.safeParse(
        "*** Begin Patch\n*** Add File: example.txt\n+hello\n*** End Patch\n",
      ).success,
    ).toBe(true);
    expect(patch.description).toContain("Lark grammar");
    expect(patch.description).toContain("exec.workdir");
    const skill = contracts.find(
      (contract) => contract.name === "list_skills",
    )!;
    expect(skill.description).toContain("完整 SKILL.md");
    expect(skill.description).toContain("仅显式");
    expect(skill.description).not.toMatch(
      /40000|40,000|max_chars|round.?robin|预算|去重|压缩|Git 根/i,
    );
    expect(
      contracts.find((contract) => contract.name === "export_file")!
        .description,
    ).toContain("持有链接者均可下载");
  });

  it("publishes the optional truncation fields actually returned by a full terminal buffer", async () => {
    const terminal = new TerminalManager({ bufferBytes: 512 });
    terminals.push(terminal);
    const first = await terminal.execCommand(
      {
        cmd: nodeCommand(
          'process.stdout.write("head\\n"+"x".repeat(65536)+"\\ntail\\n");',
        ),
        yield_time_ms: 30000,
      },
      tmpdir(),
    );
    const result = await observeTerminal(first, (input) =>
      terminal.writeStdin(input),
    );
    expect(result.exit_code).toBe(0);
    expect(result.truncated).toBe(true);
    expect(result.omitted_bytes).toBeGreaterThan(0);
    expect(result.output).toContain("head");
    expect(result.output).toContain("tail");
    const ajv = new Ajv2020({ strict: false });
    for (const name of ["exec_command", "write_stdin"]) {
      const contract = nativeContracts(terminal.shell).find(
        (item) => item.name === name,
      )!;
      const validate = ajv.compile(contract.output!);
      expect(validate(result), JSON.stringify(validate.errors)).toBe(true);
      expect(validate({ ...result, omitted_bytes: "not-a-number" })).toBe(
        false,
      );
    }
  });
});

describe.each([false, true])("fresh MCP contract (legacy=%s)", (legacy) => {
  it("offers one asynchronous question function and no answer-polling tool", async () => {
    const connection = await connect(
      { web: { enabled: true, host: "127.0.0.1", port: 0 } },
      legacy,
    );
    connections.push(connection);
    const listed = (await connection.client.listTools()).tools;
    expect(JSON.stringify(listed)).not.toMatch(/get_user_input|ack_user_input/);
    const result = await connection.client.callTool({
      name: "exec",
      arguments: {
        source:
          "text({create:typeof tools.request_user_input_async,read:typeof tools.get_user_input,names:ALL_TOOLS.map(t=>t.name)});",
      },
      _meta: { "openai/session": "same-conversation-without-inbox" },
    });
    expect(result.isError).not.toBe(true);
    expect(jsonOutput(result)).toEqual({
      create: "function",
      read: "undefined",
      names: nativeContracts(resolveShell()).map((tool) => tool.name),
    });
  });
  it("exposes the revised contracts and executes a literal string patch on the first exec", async () => {
    const connection = await connect({}, legacy);
    connections.push(connection);
    const directory = await mkdtemp(path.join(tmpdir(), "exec-contract-"));
    directories.push(directory);
    const listed = (await connection.client.listTools()).tools;
    expect(listed.map((tool) => tool.name)).toEqual(TOP_LEVEL_TOOL_NAMES);
    expect(listed[0]!.description).not.toContain("revoke_file");
    expect(listed[0]!.description!.split("本机及发现契约：")[0]).toContain(
      FILE_EDIT_RULE,
    );
    expect(listed[0]!.description!.split("本机及发现契约：")[0]).toContain(
      MULTILINE_RULE,
    );
    expect(listed[0]!.description).toContain(SKILL_RULE);
    expect(listed[0]!.description).toContain(
      "对下游 MCP 的 CallToolResult，先检查 isError",
    );
    const patch =
      "*** Begin Patch\n*** Add File: hello.txt\n+hello\n*** End Patch\n";
    const result = await connection.client.callTool({
      name: "exec",
      arguments: {
        workdir: directory,
        source: `const patched=await tools.apply_patch(${JSON.stringify(patch)});text({patched,revoke:typeof tools.revoke_file,catalog:ALL_TOOLS});`,
      },
    });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    const value = jsonOutput<{
      patched: { success: boolean };
      revoke: string;
      catalog: { name: string; description: string }[];
    }>(result);
    expect(value.patched.success).toBe(true);
    expect(await readFile(path.join(directory, "hello.txt"), "utf8")).toBe(
      "hello\n",
    );
    expect(value.revoke).toBe("undefined");
    expect(value.catalog.some((tool) => tool.name === "revoke_file")).toBe(
      false,
    );
    expect(
      value.catalog.find((tool) => tool.name === "list_skills")!.description,
    ).toContain(SKILL_RULE);
    for (const contract of nativeContracts(resolveShell())) {
      expect(
        value.catalog.find((tool) => tool.name === contract.name)!.description,
      ).toBe(describeContract(contract));
      expect(listed[0]!.description).toContain(describeContract(contract));
    }
  });
  it("creates and edits files with multiline templates while preserving raw backslashes and content indentation", async () => {
    const connection = await connect({}, legacy);
    connections.push(connection);
    const directory = await mkdtemp(path.join(tmpdir(), "exec-template-"));
    directories.push(directory);
    // The host receives real multiline templates, not a JSON-escaped patch argument.
    // Substitution values can safely carry literal template delimiters into the patch.
    const source = [
      'const literal = "${value}";',
      'const tick = "`";',
      "const created = await tools.apply_patch(`*** Begin Patch",
      "*** Add File: example.txt",
      "+initial",
      "+    indented",
      "*** End Patch",
      "`);",
      "const updated = await tools.apply_patch(String.raw`*** Begin Patch",
      "*** Update File: example.txt",
      "@@",
      "-initial",
      String.raw`+path=C:\work\new\task.txt`,
      String.raw`+pattern=Sig\[\d+\]`,
      "+literal=${literal}",
      "+tick=${tick}",
      "     indented",
      "*** End Patch",
      "`);",
      "text({created,updated});",
    ].join("\n");
    const result = await connection.client.callTool({
      name: "exec",
      arguments: { workdir: directory, source },
    });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    const value = jsonOutput<{
      created: { success: boolean };
      updated: { success: boolean };
    }>(result);
    expect(value.created.success).toBe(true);
    expect(value.updated.success).toBe(true);
    expect(await readFile(path.join(directory, "example.txt"), "utf8")).toBe(
      [
        String.raw`path=C:\work\new\task.txt`,
        String.raw`pattern=Sig\[\d+\]`,
        "literal=${value}",
        "tick=`",
        "    indented",
        "",
      ].join("\n"),
    );
  });
  it("rejects an unescaped Markdown fence during parsing before any patch or subsequent command runs", async () => {
    const connection = await connect({}, legacy);
    connections.push(connection);
    const directory = await mkdtemp(
      path.join(tmpdir(), "exec-invalid-template-"),
    );
    directories.push(directory);
    const marker =
      "*** Begin Patch\n*** Add File: before.txt\n+not executed\n*** End Patch\n";
    const source = [
      `await tools.apply_patch(${JSON.stringify(marker)});`,
      "const patch = String.raw`*** Begin Patch",
      "*** Add File: broken.md",
      "+```console",
      "+echo example",
      "+```",
      "*** End Patch",
      "`;",
      "text(await tools.apply_patch(patch));",
      `await tools.apply_patch(${JSON.stringify(marker.replace("before.txt", "after.txt"))});`,
    ].join("\n");
    const result = await connection.client.callTool({
      name: "exec",
      arguments: { workdir: directory, source },
    });
    expect(result.isError).toBe(true);
    const message = texts(result).join("\n");
    expect(message).toContain("SyntaxError");
    expect(message).toContain("解析阶段");
    expect(message).toContain("```console");
    for (const filename of ["before.txt", "broken.md", "after.txt"])
      await expect(
        readFile(path.join(directory, filename)),
      ).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("runs the exact documented Markdown patch and preserves interpolated delimiters without reparsing them", async () => {
    const connection = await connect({}, legacy);
    connections.push(connection);
    const directory = await mkdtemp(
      path.join(tmpdir(), "exec-markdown-example-"),
    );
    directories.push(directory);
    const doc = await readFile(
      new URL("../docs/code-mode-examples.md", import.meta.url),
      "utf8",
    );
    const section = doc.slice(
      doc.indexOf("## 在 exec 内构造含 Markdown 的多行补丁"),
    );
    const source = /```js\n([\s\S]*?)\n```/.exec(section)?.[1];
    expect(source).toBeDefined();
    const result = await connection.client.callTool({
      name: "exec",
      arguments: { workdir: directory, source: source! },
    });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(jsonOutput<{ success: boolean }>(result).success).toBe(true);
    expect(
      await readFile(path.join(directory, "patch-example.md"), "utf8"),
    ).toBe(
      [
        "# Review notes",
        "Use `review` mode.",
        "```console",
        "uv run demo.py",
        "```",
        "Literal placeholder: ${name}",
        String.raw`Windows path: C:\work\new\file.txt`,
        String.raw`Regex: Sig\[\d+\]`,
        String.raw`Literal escape: \uXXXX`,
        "",
      ].join("\n"),
    );
    // String.raw preserves the escape backslash; template substitutions do not reparse their text.
    const semantics = await connection.client.callTool({
      name: "exec",
      arguments: {
        source: [
          "text({",
          "rawTick: String.raw`\\``,",
          "rawSlot: String.raw`\\${name}`,",
          "cookedTick: `\\``,",
          "cookedSlot: `\\${name}`",
          "});",
        ].join("\n"),
      },
    });
    expect(semantics.isError, JSON.stringify(semantics)).not.toBe(true);
    expect(jsonOutput(semantics)).toEqual({
      rawTick: "\\`",
      rawSlot: "\\${name}",
      cookedTick: "`",
      cookedSlot: "${name}",
    });
  });
  it("creates and updates a large Markdown patch without argv-sized text, sentinel replacement or delimiter corruption", async () => {
    const connection = await connect({}, legacy);
    connections.push(connection);
    const directory = await mkdtemp(
      path.join(tmpdir(), "exec-large-markdown-"),
    );
    directories.push(directory);
    const count = 1600;
    // These are the source's native substitutions, not preprocessing applied by the service.
    const block =
      [
        '+Use ${"`"}review${"`"} with ${"${"}name}.',
        '+${"`".repeat(3)}console',
        String.raw`+C:\work\new\task.txt`,
        String.raw`+Regex: Sig\[\d+\]; literal \uXXXX, \n, \\server\share`,
        '+${"`".repeat(3)}',
        "+    indented 中文😀",
        "+Keep §, ~~~, __BACKTICK__ and __DOLLAR__ as ordinary text.",
        "+",
      ].join("\n") + "\n";
    const source = [
      "const created = await tools.apply_patch(String.raw`*** Begin Patch",
      "*** Add File: large.md",
      "+# Original",
      block.repeat(count) + "+END_MARKER\n*** End Patch",
      "`);",
      "const updated = await tools.apply_patch(String.raw`*** Begin Patch",
      "*** Update File: large.md",
      "@@",
      "-# Original",
      "+# Updated",
      "*** End Patch",
      "`);",
      "text({created,updated});",
    ].join("\n");
    expect(Buffer.byteLength(source)).toBeGreaterThan(256 * 1024);
    const result = await connection.client.callTool({
      name: "exec",
      arguments: { workdir: directory, source },
    });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    const value = jsonOutput<{
      created: { success: boolean };
      updated: { success: boolean };
    }>(result);
    expect(value.created.success).toBe(true);
    expect(value.updated.success).toBe(true);
    const expectedBlock =
      [
        "Use `review` with ${name}.",
        "```console",
        String.raw`C:\work\new\task.txt`,
        String.raw`Regex: Sig\[\d+\]; literal \uXXXX, \n, \\server\share`,
        "```",
        "    indented 中文😀",
        "Keep §, ~~~, __BACKTICK__ and __DOLLAR__ as ordinary text.",
        "",
      ].join("\n") + "\n";
    const expected = Buffer.from(
      "# Updated\n" + expectedBlock.repeat(count) + "END_MARKER\n",
    );
    const actual = await readFile(path.join(directory, "large.md"));
    expect(actual.length).toBe(expected.length);
    expect(createHash("sha256").update(actual).digest("hex")).toBe(
      createHash("sha256").update(expected).digest("hex"),
    );
  });
});

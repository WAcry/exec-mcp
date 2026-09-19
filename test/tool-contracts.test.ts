import { mkdtemp, readFile, rm } from "node:fs/promises";
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
import { resolveShell } from "../src/host/shell.js";
import { TerminalManager } from "../src/host/terminal.js";
import {
  connect,
  jsonOutput,
  nodeCommand,
  observeTerminal,
} from "./helpers.js";

const connections: Awaited<ReturnType<typeof connect>>[] = [];
const terminals: TerminalManager[] = [];
const directories: string[] = [];
const SKILL_RULE =
  "普通 Skill 可按目录中的触发描述自动选择；标记为仅显式的 Skill 只有用户明确点名要求使用时才能读取。";
const FILE_EDIT_RULE =
  "创建和修改文本文件优先用 tools.apply_patch，避免把文件内容塞进终端命令而触及参数长度上限。";
const MULTILINE_RULE =
  "多行字符串优先用模板字面量；需保留反斜杠时用 String.raw。两者仍有反引号和 ${...} 语义；补丁以 *** Begin Patch 起始，标记顶格、正文缩进保留。";
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
  it("states skill selection in both entry points and scopes result handling to downstream MCP", () => {
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
      "tool_search",
    ]);
    const description = execDescription(contracts);
    expect(description).toContain("V8 本身");
    expect(description.split("本机及发现契约：")[0]).toContain(FILE_EDIT_RULE);
    expect(description.split("本机及发现契约：")[0]).toContain(MULTILINE_RULE);
    expect(description).toContain(
      "文件与网络等外部操作由 tools.* 在实际机器执行",
    );
    expect(description).toContain("本机任务使用这里的工具");
    expect(description).toContain("ChatGPT 容器不共享本机的文件和网络环境");
    expect(description).toContain("通常组合独立调用以节省每轮工具次数");
    expect(description).toContain("仅在确认未执行后重试");
    expect(description).toContain(
      "若宿主拒绝执行，先检查请求是否合规，再修正或拆分复杂脚本",
    );
    expect(description).toContain("tools.import_file({index,destination})");
    expect(description).toContain("已知工具可直接 tools[name](args)");
    expect(description).not.toMatch(
      /revoke_file|\{patch,\s*workdir\}|import_file\(index\)|notify 不支持/,
    );
    for (const contract of contracts)
      expect(description).toContain(describeContract(contract));
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
  it("has no asynchronous question tools or response hooks, even with Web enabled", async () => {
    const connection = await connect(
      { web: { enabled: true, host: "127.0.0.1", port: 0 } },
      legacy,
    );
    connections.push(connection);
    const listed = (await connection.client.listTools()).tools;
    expect(JSON.stringify(listed)).not.toMatch(
      /request_user_input_async|get_user_input|ack_user_input|用户答复/,
    );
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
      create: "undefined",
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
    expect(listed.map((tool) => tool.name)).toEqual(["exec", "wait"]);
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
    for (const tool of value.catalog)
      expect(listed[0]!.description).toContain(tool.description);
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
});

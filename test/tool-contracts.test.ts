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
  jsonSchema,
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
  "Skills can be selected by their trigger descriptions; explicit-only skills are read only when the user explicitly requests them.";
const FILE_EDIT_RULE =
  "The patch is sent through stdin, avoiding command-line argument limits.";
const MULTILINE_RULE =
  "Nested JS, shell and other languages each interpret quoting, interpolation, escapes, argument boundaries and whitespace.";
const AGENT_CLI_RULE =
  "Work independently; do not invoke other agent CLIs on this machine (e.g. Codex or Claude Code) unless the user explicitly requests it.";
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
    expect(description.split(SKILL_RULE)).toHaveLength(2);
    expect(
      contracts.find((contract) => contract.name === "list_skills")!
        .description,
    ).toContain(SKILL_RULE);
    expect(description).toContain(
      "Downstream MCP methods return CallToolResult: {content, structuredContent?, isError?}; isError indicates failure.",
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
      "list_mcp_resources",
      "list_mcp_resource_templates",
      "read_mcp_resource",
    ]);
    const description = execDescription(contracts);
    expect(description).toContain("fresh V8 isolate as an async module");
    expect(description).toContain(FILE_EDIT_RULE);
    expect(description.split("## Local tools")[0]).toContain(MULTILINE_RULE);
    expect(description.split("## Local tools")[0]).toContain(AGENT_CLI_RULE);
    expect(description.split(AGENT_CLI_RULE)).toHaveLength(2);
    expect(description).toContain("this connection's specific remote machine");
    expect(description).toContain(
      "Only the orchestration JS isolate lacks Node.js, filesystem, network",
    );
    expect(description).toContain(
      "Tools access the remote machine's filesystem and network",
    );
    expect(description).toContain(
      "ChatGPT containers do not share that environment",
    );
    expect(description).toContain(
      "Failures and cancellation do not undo side effects",
    );
    expect(description).toContain("exec.files[index]");
    expect(description).toContain(
      "A known name and argument shape can be called directly with await tools[name](args)",
    );
    expect(description).toContain("ALL_TOOLS.filter");
    expect(description).not.toMatch(
      /revoke_file|\{patch,\s*workdir\}|import_file\(index\)|String\.raw|must use|always use/i,
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
    expect(skill.description).toContain("full SKILL.md");
    expect(skill.description).toContain("explicit-only");
    expect(skill.description).not.toMatch(
      /40000|40,000|max_chars|round.?robin|budget|dedup|compress|Git root/i,
    );
    expect(
      contracts.find((contract) => contract.name === "export_file")!
        .description,
    ).toContain("anyone with the link can download");
  });

  it("keeps every local description and schema in English for each supported shell", () => {
    for (const kind of [
      "bash",
      "zsh",
      "sh",
      "fish",
      "pwsh",
      "powershell",
      "other",
    ] as const) {
      for (const login of [false, true]) {
        const contracts = nativeContracts({
          file: kind,
          kind,
          login,
          platform: "linux",
        });
        const description = execDescription(contracts);
        expect(description).not.toMatch(/\p{Script=Han}/u);
        expect(description).toContain("Input JSON Schema:");
        expect(description).toContain("Output JSON Schema:");
        for (const schema of [
          EXEC_SCHEMA,
          WAIT_SCHEMA,
          ...contracts.map((c) => c.schema),
        ]) {
          expect(JSON.stringify(jsonSchema(schema))).not.toMatch(
            /\p{Script=Han}/u,
          );
        }
        // Grammar is carried as metadata, not a patch example or an unsupported MCP schema type.
        const patch = contracts.find((c) => c.name === "apply_patch")!;
        expect(patch.description).toContain('add_line: "+" /(.*)/ LF -> line');
        expect(patch.description).not.toMatch(
          /example|\*\*\* Add File: [a-z]/i,
        );
        expect(patch.schema.safeParse({ patch: "text" }).success).toBe(false);
      }
    }
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
    expect(listed[0]!.description!.split("## Local tools")[0]).toContain(
      AGENT_CLI_RULE,
    );
    expect(listed[0]!.description!.split(AGENT_CLI_RULE)).toHaveLength(2);
    expect(listed[0]!.description).not.toContain("revoke_file");
    expect(listed[0]!.description!).toContain(FILE_EDIT_RULE);
    expect(listed[0]!.description!.split("## Local tools")[0]).toContain(
      MULTILINE_RULE,
    );
    expect(listed[0]!.description).toContain(SKILL_RULE);
    expect(listed[0]!.description).toContain(
      "Downstream MCP methods return CallToolResult",
    );
    const instructions = connection.client.getInstructions()!;
    expect(instructions).toContain("one specific remote machine");
    expect(listed[0]!.description).toContain(
      "Only the orchestration JS isolate lacks",
    );
    expect(listed[0]!.description).toContain(
      "Tools access the remote machine's filesystem and network",
    );
    expect(instructions).toContain("user_notes");
    expect(instructions).toContain("this conversation's Web UI");
    expect(instructions).not.toMatch(/\p{Script=Han}/u);
    expect(JSON.stringify(listed)).not.toMatch(/\p{Script=Han}/u);
    const resourceTemplates = await connection.client.listResourceTemplates();
    expect(resourceTemplates.resourceTemplates.length).toBeGreaterThan(0);
    expect(JSON.stringify(resourceTemplates)).not.toMatch(/\p{Script=Han}/u);
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

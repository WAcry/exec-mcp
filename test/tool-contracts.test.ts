import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  describeContract,
  execDescription,
  nativeContracts,
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
    expect(description).toContain(
      "文件与网络等外部操作由 tools.* 在实际机器执行",
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
  it("exposes the revised contracts and executes a literal string patch on the first exec", async () => {
    const connection = await connect({}, legacy);
    connections.push(connection);
    const directory = await mkdtemp(path.join(tmpdir(), "exec-contract-"));
    directories.push(directory);
    const listed = (await connection.client.listTools()).tools;
    expect(listed.map((tool) => tool.name)).toEqual(["exec", "wait"]);
    expect(listed[0]!.description).not.toContain("revoke_file");
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
    for (const tool of value.catalog)
      expect(listed[0]!.description).toContain(tool.description);
  });
});

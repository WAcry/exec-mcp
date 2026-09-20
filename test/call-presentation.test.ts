import { describe, expect, it } from "vitest";
import { callPreview, inputPreview } from "../src/tool-names.js";
import {
  callInput,
  callStatusLabel,
  hasSubcalls,
} from "../ui/src/lib/call-presentation.js";
import type { CallRecord } from "../ui/src/types.js";

function record(
  tool: string,
  args: CallRecord["args"] = {},
  status: CallRecord["status"] = "completed",
): CallRecord {
  return {
    id: "call-fixture",
    sessionId: "scope",
    tool,
    args,
    status,
    startedAt: "2026-09-19T00:00:00Z",
    subcalls: [],
  };
}

describe("complete input presentation for every entry point", () => {
  it.each([
    ["exec", { source: "text(42);", workdir: "/repo", max_output_tokens: 0 }],
    [
      "wait",
      { cell_id: "cell_1", yield_time_ms: 0, max_tokens: 0, terminate: false },
    ],
    [
      "exec_command",
      {
        cmd: "echo one\necho two",
        shell: "sh",
        login: false,
        tty: false,
        yield_time_ms: 0,
      },
    ],
    [
      "apply_patch",
      {
        patch: "*** Begin Patch\n*** Add File: a.md\n+`hi`\n*** End Patch",
        workdir: "/repo",
      },
    ],
    ["tool_search", { query: "tools 中文", limit: 1 }],
    [
      "write_stdin",
      {
        session_id: "term_1",
        chars: "",
        terminate: false,
        close_stdin: false,
        yield_time_ms: 0,
      },
    ],
    ["list_skills", {}],
    [
      "import_file",
      {
        file: { name: "empty.txt", type: "text/plain", size: 0 },
        destination: "/tmp/file",
        overwrite: false,
      },
    ],
    [
      "export_file",
      { path: "/tmp/file", name: "copy.txt", delivery: "resource" },
    ],
    ["view_image", { path: "/tmp/image.png", detail: "original" }],
  ] as [string, CallRecord["args"]][])(
    "retains every explicit %s argument while separating raw code",
    (tool, args) => {
      const { code, parameters } = callInput(record(tool, args));
      expect({
        ...parameters,
        ...(code ? { [code.field]: code.value } : {}),
      }).toEqual(args);
      expect(Boolean(code)).toBe(
        ["exec", "exec_command", "apply_patch"].includes(tool),
      );
      if (code) expect(parameters).not.toHaveProperty(code.field);
    },
  );

  it("does not disguise direct calls or wait as an empty nested call flow", () => {
    for (const tool of ["tool_search", "exec_command", "apply_patch", "wait"]) {
      expect(hasSubcalls(record(tool))).toBe(false);
      expect(hasSubcalls(record(tool, {}, "running"))).toBe(false);
    }
    expect(hasSubcalls(record("exec", {}, "running"))).toBe(true);
    expect(hasSubcalls(record("exec"))).toBe(false);
    expect(hasSubcalls({ ...record("exec"), omittedSubcalls: 1 })).toBe(true);
  });

  it("distinguishes an observation returning from the underlying program completing", () => {
    expect(callStatusLabel(record("tool_search"))).toBe("调用完成");
    expect(callStatusLabel(record("exec"))).toBe("脚本完成");
    expect(callStatusLabel(record("exec", {}, "yielding"))).toBe(
      "脚本仍在运行",
    );
    expect(callStatusLabel(record("write_stdin", {}, "yielding"))).toBe(
      "终端运行或输出待取",
    );
    for (const output of [
      { exit_code: 0 },
      { content: [], structuredContent: { exit_code: 0 } },
    ])
      expect(
        callStatusLabel({ ...record("exec_command", {}, "yielding"), output }),
      ).toBe("进程已退出，输出待取");
    expect(callStatusLabel(record("write_stdin", {}, "terminated"))).toBe(
      "已终止",
    );
  });

  it("previews real command and patch content instead of blank first lines and envelope markers", () => {
    expect(
      callPreview("exec_command", { cmd: "\r\n\nWrite-Output 'ok'\nSECOND" }),
    ).toBe("Write-Output 'ok'");
    expect(
      callPreview("apply_patch", {
        patch:
          "*** Begin Patch\n*** Update File: docs/example.md\n@@\n-content\n+new",
      }),
    ).toBe("*** Update File: docs/example.md");
    expect(
      callPreview("write_stdin", { session_id: "term_1", chars: "" }),
    ).toBe("write_stdin(term_1)");
    expect(inputPreview("query", "x".repeat(1000))).toHaveLength(240);
    expect(callPreview("list_skills", {})).toBe("list_skills");
  });
});

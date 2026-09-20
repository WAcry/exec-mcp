import type { CallRecord } from "../types.js";

/** Preserve actual input keys and false/zero/empty values; source text has its own readable view. */
export function callInput(call: Pick<CallRecord, "tool" | "args">) {
  const field =
    call.tool === "exec"
      ? "source"
      : call.tool === "exec_command"
        ? "cmd"
        : call.tool === "apply_patch"
          ? "patch"
          : undefined;
  const value = field === undefined ? undefined : call.args[field];
  const code =
    field !== undefined && typeof value === "string"
      ? {
          field,
          value,
          language:
            field === "source"
              ? "javascript"
              : field === "patch"
                ? "diff"
                : "text",
        }
      : undefined;
  const parameters = Object.fromEntries(
    Object.entries(call.args).filter(([key]) => key !== code?.field),
  );
  return { code, parameters };
}

export function hasSubcalls(call: CallRecord): boolean {
  return (
    call.subcalls.length > 0 ||
    (call.omittedSubcalls ?? 0) > 0 ||
    (call.tool === "exec" && call.status === "running")
  );
}

export function callStatusLabel(
  call: Pick<CallRecord, "tool" | "status" | "output">,
): string {
  const codeMode = call.tool === "exec" || call.tool === "wait";
  switch (call.status) {
    case "running":
      return "调用中";
    case "completed":
      return codeMode ? "脚本完成" : "调用完成";
    case "terminated":
      return "已终止";
    case "error":
      return "报错 / 非零退出";
    case "yielding": {
      if (codeMode) return "脚本仍在运行";
      const output =
        call.output && typeof call.output === "object"
          ? (call.output as Record<string, unknown>)
          : undefined;
      const value = output?.structuredContent ?? output;
      return value && typeof value === "object" && "exit_code" in value
        ? "进程已退出，输出待取"
        : "终端运行或输出待取";
    }
  }
}

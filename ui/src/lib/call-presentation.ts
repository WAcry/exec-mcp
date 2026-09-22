import type { CallRecord } from "../types.js";
import { createTranslator, type Translate } from "./locale.js";

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
  t: Translate = createTranslator("zh-CN"),
): string {
  const codeMode = call.tool === "exec" || call.tool === "wait";
  switch (call.status) {
    case "running":
      return t("status.running");
    case "completed":
      return codeMode ? t("status.completed") : t("calls.completed");
    case "terminated":
      return t("common.stopped");
    case "error":
      return t("detail.failed");
    case "yielding": {
      if (codeMode) return t("status.yielding");
      const output =
        call.output && typeof call.output === "object"
          ? (call.output as Record<string, unknown>)
          : undefined;
      const structured = output?.structuredContent ?? output;
      const value =
        structured &&
        typeof structured === "object" &&
        "user_notes" in structured &&
        Array.isArray(structured.user_notes) &&
        "result" in structured
          ? structured.result
          : structured;
      return value && typeof value === "object" && "exit_code" in value
        ? t("status.exited")
        : t("status.terminal");
    }
  }
}

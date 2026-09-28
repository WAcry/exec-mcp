import type { CallListItem, CallStepSummary } from "../types";
import { visibleKeys } from "./format";
import type { MessageKey, Translate } from "./locale";

export type StepKind =
  | "command"
  | "stdin"
  | "patch"
  | "question"
  | "image"
  | "export"
  | "import"
  | "skills"
  | "resource"
  | "mcp"
  | "tool";

export function stepKind(name: string): StepKind {
  switch (name) {
    case "exec_command":
      return "command";
    case "write_stdin":
      return "stdin";
    case "apply_patch":
      return "patch";
    case "request_user_input_async":
      return "question";
    case "view_image":
      return "image";
    case "export_file":
      return "export";
    case "import_file":
      return "import";
    case "list_skills":
      return "skills";
    case "list_mcp_resources":
    case "list_mcp_resource_templates":
    case "read_mcp_resource":
      return "resource";
    default:
      return name.startsWith("mcp__") || name.startsWith("mcp_h__")
        ? "mcp"
        : "tool";
  }
}

/** Downstream code names: mcp__server__tool, or mcp_h__server__tool_<hash> when sanitized. */
export function mcpParts(
  name: string,
): { server: string; tool: string } | undefined {
  const plain = /^mcp__(.+?)__(.+)$/.exec(name);
  if (plain) return { server: plain[1]!, tool: plain[2]! };
  const hashed = /^mcp_h__(.+?)__(.+?)(?:_[0-9a-f]{12})?$/.exec(name);
  return hashed ? { server: hashed[1]!, tool: hashed[2]! } : undefined;
}

/** Catalog entries start with "MCP server: id." and optional server instructions. */
export function downstreamTool(tool: { name: string; description: string }) {
  const header = /^MCP server: (.+?)\. (?:Server instructions: [^\n]*\n)?/.exec(
    tool.description,
  );
  const server = header?.[1] ?? mcpParts(tool.name)?.server ?? "";
  const summary =
    tool.description
      .slice(header?.[0].length ?? 0)
      .split("\n")
      .find((line) => line.trim() && !line.startsWith("Call: ")) ?? "";
  return { server, short: mcpParts(tool.name)?.tool ?? tool.name, summary };
}

export interface StepSummary {
  verb: string;
  subject?: string;
  /** Subject is code, a path or an identifier. */
  code?: boolean;
  detail?: string;
}

const LIVE_VERB: Partial<Record<StepKind, MessageKey>> = {
  command: "live.command",
  stdin: "live.stdin",
  patch: "live.patch",
  question: "live.question",
  image: "live.image",
  export: "live.export",
  import: "live.import",
  skills: "live.skills",
  resource: "live.resource",
  mcp: "live.tool",
  tool: "live.tool",
};

export function describeStep(
  step: Pick<CallStepSummary, "name" | "preview" | "handle"> & {
    status?: CallStepSummary["status"];
  },
  t: Translate,
): StepSummary {
  const summary = describeFinished(step, t);
  const live = LIVE_VERB[stepKind(step.name)];
  return step.status === "running" && live
    ? { ...summary, verb: t(live) }
    : summary;
}

function describeFinished(
  step: Pick<CallStepSummary, "name" | "preview" | "handle">,
  t: Translate,
): StepSummary {
  const { name, preview, handle } = step;
  switch (stepKind(name)) {
    case "command":
      return { verb: t("step.ran"), subject: preview, code: true };
    case "stdin":
      return preview
        ? {
            verb: t("step.typed"),
            subject: visibleKeys(preview),
            code: true,
            ...(handle ? { detail: handle } : {}),
          }
        : {
            verb: t("step.readTerminal"),
            ...(handle ? { subject: handle, code: true } : {}),
          };
    case "patch":
      return { verb: t("step.edited"), subject: preview, code: true };
    case "question":
      return { verb: t("step.asked"), subject: preview };
    case "image":
      return { verb: t("step.viewedImage"), subject: preview, code: true };
    case "export":
      return { verb: t("step.exported"), subject: preview, code: true };
    case "import":
      return { verb: t("step.imported"), subject: preview, code: true };
    case "skills":
      return preview
        ? { verb: t("step.listedSkillsIn"), subject: preview, code: true }
        : { verb: t("step.listedSkills") };
    case "resource":
      return name === "read_mcp_resource"
        ? { verb: t("step.readResource"), subject: preview, code: true }
        : { verb: t("step.listedResources") };
    case "mcp": {
      const parts = mcpParts(name)!;
      return {
        verb: t("step.called"),
        subject: `${parts.server} · ${parts.tool}`,
        code: true,
        ...(preview ? { detail: preview } : {}),
      };
    }
    default:
      return {
        verb: t("step.called"),
        subject: name,
        code: true,
        ...(preview ? { detail: preview } : {}),
      };
  }
}

export interface CallSummaryText extends StepSummary {
  more: number;
}

export function describeCall(
  call: CallListItem,
  t: Translate,
): CallSummaryText {
  if (call.tool === "wait") {
    const cell = call.args.cell_id;
    return {
      verb:
        call.status === "terminated" ? t("step.stopped") : t("step.checked"),
      ...(cell ? { subject: cell, code: true } : {}),
      more: 0,
    };
  }
  const first = call.steps?.[0];
  if (first)
    return {
      ...describeStep(first, t),
      more: Math.max(0, call.subcallCount - 1),
    };
  const source = call.args.source ?? call.args.preview;
  return {
    verb: t("step.ranScript"),
    ...(source ? { subject: source, code: true } : {}),
    more: 0,
  };
}

/** The nested call happening now, when it is not already the row's title. */
export function latestStep(call: CallListItem): CallStepSummary | undefined {
  const last = call.steps?.at(-1);
  return last && call.steps!.length > 1 && last.status === "running"
    ? last
    : undefined;
}

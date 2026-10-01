import type { CallToolResult } from "@modelcontextprotocol/client";
import { encodePayload } from "../limits.js";
import { boundModelOutput } from "./model-output.js";
import { applyOutputBudget } from "./output-budget.js";
import { outputItemsToCallToolResult } from "./result.js";
import type { CodeModeOutputItem } from "./types.js";
import type { RuntimeOutcome } from "./wire.js";

/**
 * Builds the model-facing exec/wait result: status header, optional notice,
 * budgeted text, media, then attachments. Throws when it cannot be delivered.
 */
export function renderModelResult(
  outcome: RuntimeOutcome,
  wallTimeSeconds: number,
  maxTokens: number | undefined,
  attachments: CallToolResult["content"],
  notice?: string,
): CallToolResult {
  const items: CodeModeOutputItem[] = [...outcome.items];
  if (outcome.state === "completed" && outcome.errorText !== undefined) {
    items.push({ type: "text", text: `Script error:\n${outcome.errorText}` });
  }
  const budgeted = applyOutputBudget(items, maxTokens);
  const status =
    statusHeader(outcome, wallTimeSeconds) +
    (notice ?? "") +
    (budgeted.truncated
      ? `文本已按 ${maxTokens} token 预算截断；后续 wait 不补发被省略内容。\n`
      : "");
  const result = outputItemsToCallToolResult(
    [{ type: "text", text: status }, ...budgeted.items],
    outcome.state === "completed" && outcome.errorText !== undefined,
  );
  result.content.push(...attachments);
  const delivered = boundModelOutput(result);
  encodePayload(delivered);
  return delivered;
}

export function undeliverableResult(
  error: unknown,
  attachments: CallToolResult["content"],
): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: `结果不可交付；操作可能已生效，请勿自动重试。${error instanceof Error ? error.message : String(error)}`,
      },
      ...attachments,
    ],
    isError: true,
  };
}

function statusHeader(
  outcome: RuntimeOutcome,
  wallTimeSeconds: number,
): string {
  const status =
    outcome.state === "yielded"
      ? `Script running with cell ID ${outcome.cellId}`
      : outcome.state === "terminated"
        ? "Script terminated"
        : outcome.errorText === undefined
          ? "Script completed"
          : "Script failed";
  return `${status}\nWall time ${wallTimeSeconds.toFixed(1)} seconds\nOutput:\n`;
}

export function elapsedSeconds(startedAt: number, now: number): number {
  return Math.round(((now - startedAt) / 1_000) * 10) / 10;
}

import type { CallToolResult } from "@modelcontextprotocol/client";
import { encodePayload } from "../limits.js";
import { boundModelOutput } from "./model-output.js";
import { preserveNativeOutputNotices } from "./native-output.js";
import { applyOutputBudget } from "./output-budget.js";
import { outputItemsToCallToolResult } from "./result.js";
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
  // SERVER already renders the script error; errorText determines status only.
  const native = preserveNativeOutputNotices(outcome.items);
  const budgeted = applyOutputBudget(native.items, maxTokens);
  const status =
    statusHeader(outcome, wallTimeSeconds) +
    (notice ?? "") +
    native.notice +
    (budgeted.truncated
      ? `Text was truncated to the ${maxTokens}-token budget. Later wait calls do not return the omitted text.\n`
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
        text: `The result cannot be delivered. Its operations may have taken effect, so do not retry them automatically. ${error instanceof Error ? error.message : String(error)}`,
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

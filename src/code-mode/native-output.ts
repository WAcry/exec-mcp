import { MiB } from "../memory.js";
import type { CodeModeOutputItem } from "./types.js";

// Retention policy of the pinned official host, not configurable MCP quotas.
// codex-rs/code-mode-protocol/src/host/mod.rs and code-mode-runtime/src/output/.
export const NATIVE_OUTPUT_LIMITS = {
  textBytes: MiB,
  imageUrlBytes: 8 * MiB,
  audioUrlBytes: 62 * MiB,
  items: 32_768,
} as const;

// SERVER bounds collection independently. Keep its presentation allowance out
// of the way so a caller's text budget cannot remove retained audio. This is an
// exactly representable uint64 on every supported (64-bit) official host; the
// native formatter does not allocate in proportion to this allowance.
export const NATIVE_OUTPUT_MAX_TOKENS = Number.MAX_SAFE_INTEGER;

// The pinned protocol exposes collector omissions only as standalone text.
// Match the complete native format, never a substring of ordinary output.
const LOSS_NOTICE =
  /^\[Code Mode session output limit reached: (?:across this observation, )?omitted (\d{1,20}) text bytes; discarded (\d{1,20}) text segments, (\d{1,20}) images, (\d{1,20}) audio items\]$/;
const AUDIO_BUDGET_NOTICE = /^\[omitted (\d{1,20}) audio items \.\.\.\]$/;
const SHORT_AUDIO_NOTICE =
  "Audio output omitted because the clip is shorter than 25 ms; use a longer clip.";

/** Keep one compact loss summary in the status, outside the user's text budget. */
export function preserveNativeOutputNotices(
  items: readonly CodeModeOutputItem[],
): {
  items: CodeModeOutputItem[];
  notice: string;
} {
  const counts = [0n, 0n, 0n, 0n];
  let found = false;
  let budgetAudioItems = 0n;
  let shortAudioOmitted = false;
  const content = items.map((item): CodeModeOutputItem => {
    if (item.type !== "text") return item;
    const match = LOSS_NOTICE.exec(item.text);
    if (match?.[0] === item.text) {
      found = true;
      for (let index = 0; index < counts.length; index++)
        counts[index] = counts[index]! + BigInt(match[index + 1]!);
    } else {
      const audioMatch = AUDIO_BUDGET_NOTICE.exec(item.text);
      if (audioMatch?.[0] === item.text)
        budgetAudioItems += BigInt(audioMatch[1]!);
      else if (item.text === SHORT_AUDIO_NOTICE) shortAudioOmitted = true;
      else return item;
    }
    // Keep the gap's position without repeating the full diagnostic. Removing
    // it would make the retained fragments appear contiguous.
    return { type: "text", text: "[Output omitted]" };
  });
  const [textBytes, textItems, imageItems, audioItems] = counts;
  const notices: string[] = [];
  if (found)
    notices.push(
      `[Code Mode session output limit reached: omitted ${textBytes} text bytes; discarded ${textItems} text segments, ${imageItems} images, ${audioItems} audio items]`,
    );
  if (budgetAudioItems > 0n)
    notices.push(`[omitted ${budgetAudioItems} audio items ...]`);
  if (found || budgetAudioItems > 0n)
    notices.push(
      "Omitted output is not returned by later waits. Inspect retained source data in smaller exec calls" +
        (imageItems! > 0n || audioItems! > 0n || budgetAudioItems > 0n
          ? ", or export the source file with tools.export_file; a file link does not display its media."
          : "."),
    );
  if (shortAudioOmitted) notices.push(SHORT_AUDIO_NOTICE);
  return {
    items: content,
    notice: notices.length ? notices.join("\n") + "\n" : "",
  };
}

import { encodePayload } from "../limits.js";
import { discoverSkills, type DiscoverSkillsOptions } from "./discover.js";
import { renderSkills } from "./render.js";
import { MODEL_TEXT_BYTES } from "../code-mode/model-output.js";

export async function listSkills(
  options: DiscoverSkillsOptions & { maxChars?: number } = {},
): Promise<string> {
  const catalog = await discoverSkills(options);
  options.signal?.throwIfAborted();
  // A catalog is already a context summary. Fairly shorten descriptions before
  // the outer head/tail fallback could hide names in the middle of the directory.
  const result = renderSkills(
    catalog,
    options.maxChars,
    MODEL_TEXT_BYTES - 4000,
  );
  // Keep the existing actual transport boundary; a presentation budget is not a file spill policy.
  encodePayload(result);
  return result;
}

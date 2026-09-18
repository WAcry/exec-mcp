import { encodePayload } from "../limits.js";
import { discoverSkills, type DiscoverSkillsOptions } from "./discover.js";
import { renderSkills } from "./render.js";

export async function listSkills(
  options: DiscoverSkillsOptions & { maxChars?: number } = {},
): Promise<string> {
  const catalog = await discoverSkills(options);
  options.signal?.throwIfAborted();
  const result = renderSkills(catalog, options.maxChars);
  // Keep the existing actual transport boundary; a presentation budget is not a file spill policy.
  encodePayload(result);
  return result;
}

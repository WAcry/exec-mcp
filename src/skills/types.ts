import { z } from "zod/v4";

export const DEFAULT_SKILL_MAX_CHARS = 40_000;
export const SKILLS_CONFIG_SCHEMA = z
  .object({
    max_chars: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .default(DEFAULT_SKILL_MAX_CHARS),
  })
  .strict();
export type SkillsConfig = z.infer<typeof SKILLS_CONFIG_SCHEMA>;

export interface SkillMetadata {
  name: string;
  path: string;
  /** Absent for explicit-only skills: their trigger text must never reach the model. */
  description?: string;
  implicit: boolean;
}
export interface SkillCatalog {
  skills: SkillMetadata[];
  warnings: string[];
}

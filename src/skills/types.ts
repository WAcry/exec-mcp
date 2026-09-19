import { z } from "zod/v4";

export const DEFAULT_SKILL_MAX_CHARS = 40_000;
const SKILL_SETTING_SCHEMA = z.union([
  z.object({ name: z.string().trim().min(1), enabled: z.boolean() }).strict(),
  z
    .object({
      path: z
        .string()
        .min(1)
        .refine((value) => !!value.trim() && !value.includes("\0")),
      enabled: z.boolean(),
    })
    .strict(),
]);
export type SkillSetting = z.infer<typeof SKILL_SETTING_SCHEMA>;
export const SKILLS_CONFIG_SCHEMA = z
  .object({
    max_chars: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .default(DEFAULT_SKILL_MAX_CHARS),
    config: z.array(SKILL_SETTING_SCHEMA).optional(),
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

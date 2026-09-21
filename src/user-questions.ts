import { z } from "zod";
import { NOTE_MAX_BYTES } from "./session-notes-types.js";

/** Mirror Codex's questions/title/options shape, with options required for this Web workflow. */
export const REQUEST_USER_INPUT_SCHEMA = z
  .object({
    questions: z
      .array(
        z
          .object({
            title: z
              .string()
              .trim()
              .min(1)
              .max(2000)
              .describe(
                "The complete question shown to the user, including any context needed to answer it.",
              ),
            options: z
              .array(z.string().trim().min(1).max(500))
              .min(2)
              .max(6)
              .refine(
                (options) => new Set(options).size === options.length,
                "同一问题的选项不能重复",
              )
              .describe(
                "Distinct suggested answers in display order. The first is marked recommended but not preselected. The UI adds 'None of the above' and a note field for every choice.",
              ),
          })
          .strict(),
      )
      .min(1)
      .max(3)
      .describe(
        "One to three self-contained questions to present together, in display order.",
      ),
    request_key: z
      .string()
      .min(1)
      .max(80)
      .optional()
      .describe(
        "Optional deduplication key within this conversation. Identical content reuses the request; different content with the same key is rejected.",
      ),
  })
  .strict();

/** Web-only submission, deliberately not exposed as an MCP tool. */
export const QUESTION_ANSWER_SCHEMA = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
    option_index: z.number().int().min(0).nullable(),
    note: z.string().max(NOTE_MAX_BYTES),
  })
  .strict();

export type RequestUserInput = z.infer<typeof REQUEST_USER_INPUT_SCHEMA>;
export type QuestionAnswer = z.infer<typeof QUESTION_ANSWER_SCHEMA>;

import { z } from "zod";
import { NOTE_MAX_BYTES } from "./session-notes-types.js";

/** Mirror Codex's questions/title/options shape, with conversation-scoped retry identity. */
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
              .describe(
                "The complete question shown to the user, including any context needed to answer it.",
              ),
            options: z
              .array(z.string().trim().min(1))
              .min(1)
              .optional()
              .describe(
                "Suggested answers, in display order. Put the recommended answer first; the first option is preselected by default. The user can select one option or enter a free-text answer. Do not include an Other option or a free-text placeholder; the UI provides free-text input automatically. Omit options for a free-text-only question.",
              ),
          })
          .strict(),
      )
      .min(1)
      .describe(
        "One or more self-contained questions to present together, in display order.",
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

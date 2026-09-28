import { z } from "zod/v4";
import { NOTE_MAX_BYTES } from "./session-notes-types.js";

// Codex send_message_to_user_async uses a single message and returns acceptance.
export const SEND_MESSAGE_TO_USER_SCHEMA = z
  .object({
    message: z
      .string()
      .trim()
      .min(1)
      .max(NOTE_MAX_BYTES)
      .describe(
        "The concise question or update to send to the user. Up to 30,000 UTF-8 bytes.",
      ),
  })
  .strict();

export type SendMessageToUser = z.infer<typeof SEND_MESSAGE_TO_USER_SCHEMA>;

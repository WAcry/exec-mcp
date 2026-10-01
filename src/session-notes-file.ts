import { randomBytes } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync, renameSync } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod/v4";
import type { AgentMessage, SessionNote } from "./session-notes-types.js";
import type { UserQuestionRequest } from "./user-questions-types.js";

/** Version 1 is the first saved format. A new layout needs a new number and a reader. */
export const NOTES_FILE_VERSION = 1;
/** Saved data stays far below this; a larger file is not one we wrote. */
const MAX_FILE_BYTES = 64 * 1024 * 1024;

export interface StoredConversation {
  id: string;
  label: string;
  titled: boolean;
  firstSeen: string;
  touched: number;
  sequence: number;
  notes: SessionNote[];
  requests: UserQuestionRequest[];
  messages: AgentMessage[];
}

/** Beside the Web access key, in the private directory of this configuration file. */
export function sessionNotesPath(configPath: string): string {
  const config = path.resolve(configPath);
  return path.join(
    path.dirname(config),
    ".exec-mcp",
    `${path.basename(config)}.notes.json`,
  );
}

const time = z.string().min(1);
const NOTE = z.object({
  id: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  text: z.string(),
  createdAt: time,
  status: z.enum(["pending", "attached", "withdrawn"]),
  attachedAt: time.optional(),
  callId: z.string().optional(),
  questionId: z.string().optional(),
});
const MESSAGE = z.object({
  id: z.string().min(1),
  text: z.string(),
  createdAt: time,
  callId: z.string().optional(),
  readAt: time.optional(),
});
const REQUEST = z.object({
  id: z.string().min(1),
  request_key: z.string().optional(),
  createdAt: time,
  touched: z.number(),
  questions: z
    .array(
      z.object({
        id: z.string().min(1),
        title: z.string(),
        options: z.array(z.string()),
        answer: z
          .object({
            option_index: z.number().int().nonnegative().nullable(),
            note: z.string(),
            noteId: z.string().min(1),
            answeredAt: time,
          })
          .optional(),
      }),
    )
    .min(1),
});
const FILE = z.object({
  version: z.literal(NOTES_FILE_VERSION),
  conversations: z.array(
    z.object({
      id: z.string().min(1),
      label: z.string(),
      titled: z.boolean(),
      firstSeen: time,
      touched: z.number(),
      sequence: z.number().int().nonnegative(),
      notes: z.array(NOTE),
      requests: z.array(REQUEST),
      messages: z.array(MESSAGE),
    }),
  ),
});

export type NotesFileLoad =
  | { status: "missing" }
  | { status: "loaded"; conversations: StoredConversation[] }
  /** Unreadable or invalid: moved aside, or kept in place when moving failed. */
  | { status: "rejected"; reason: string; movedTo?: string };

function readLimited(filename: string): Buffer {
  const fd = openSync(filename, "r");
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw new Error("it is not a regular file");
    if (info.size > MAX_FILE_BYTES)
      throw new Error(`it is larger than ${MAX_FILE_BYTES} bytes`);
    const bytes = Buffer.alloc(info.size);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, null);
      if (!count) break;
      size += count;
    }
    return bytes.subarray(0, size);
  } finally {
    closeSync(fd);
  }
}

/** Startup reads synchronously, before any listener or tool call can change the store. */
export function loadNotesFile(filename: string): NotesFileLoad {
  let reason: string;
  try {
    const bytes = readLimited(filename);
    const parsed = FILE.safeParse(JSON.parse(bytes.toString("utf8")));
    if (parsed.success)
      return {
        status: "loaded",
        conversations: parsed.data.conversations as StoredConversation[],
      };
    reason = "its content is not a valid version 1 notes file";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { status: "missing" };
    reason =
      error instanceof SyntaxError
        ? "it is not valid JSON"
        : error instanceof Error && !(error as NodeJS.ErrnoException).code
          ? error.message
          : `it cannot be read (${(error as NodeJS.ErrnoException).code ?? "unknown error"})`;
  }
  const movedTo = `${filename}.unreadable-${Date.now()}`;
  try {
    renameSync(filename, movedTo);
    return { status: "rejected", reason, movedTo };
  } catch {
    return { status: "rejected", reason };
  }
}

/** Writes the whole store to a private temporary file, then replaces the saved file. */
export async function saveNotesFile(
  filename: string,
  conversations: readonly StoredConversation[],
): Promise<void> {
  const directory = path.dirname(filename);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(
    directory,
    `.notes-${randomBytes(12).toString("hex")}.tmp`,
  );
  const body = JSON.stringify({ version: NOTES_FILE_VERSION, conversations });
  let renamed = false;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(body, "utf8");
    await handle.sync();
    await handle.close();
    await rename(temporary, filename);
    renamed = true;
  } finally {
    await handle.close().catch(() => undefined);
    if (!renamed) await unlink(temporary).catch(() => undefined);
  }
}

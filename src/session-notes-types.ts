/** Shared by the Web composer and server validation; these are byte budgets, not token counts. */
export const NOTE_MAX_BYTES = 30_000;
export const NOTE_LABEL_BYTES = 256;
export const NOTES_RESPONSE_BYTES = 37_000;
export const NOTE_RETENTION_MS = 72 * 60 * 60 * 1000;

/** Web-only change event. Question text and answers stay behind the existing API. */
export interface SessionNotesEvent {
  type: "session:notes";
  sessionId: string;
  questionRequest?: { id: string; count: number };
}

export interface SessionNote {
  id: string;
  sequence: number;
  text: string;
  createdAt: string;
  status: "pending" | "attached" | "withdrawn";
  attachedAt?: string;
  callId?: string;
  questionId?: string;
}

export interface SessionNotesPage {
  sessionId: string;
  label: string;
  pendingCount: number;
  pendingQuestions: number;
  items: SessionNote[];
  page: number;
  totalPages: number;
  maxMessageBytes: number;
  retentionHours: number;
}

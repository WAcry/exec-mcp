/** Shared by the Web composer and server validation; these are byte budgets, not token counts. */
export const NOTE_MAX_BYTES = 30_000;
export const NOTE_LABEL_BYTES = 256;
export const NOTES_RESPONSE_BYTES = 37_000;
export const NOTE_RETENTION_MS = 72 * 60 * 60 * 1000;
/** Model-visible label for notes appended to results without structuredContent. */
export const USER_NOTE_TEXT_PREFIX = "用户额外补充：\n";
/** Model-visible hint after delivered notes while the agent can still title the conversation. */
export const TITLE_REMINDER =
  "This conversation has no title in the Web UI; consider setting one with tools.set_conversation_title in your next exec.";

/** Web-only change event. Question text and answers stay behind the existing API. */
export interface SessionNotesEvent {
  type: "session:notes";
  sessionId: string;
  questionRequest?: { id: string; count: number };
  agentMessage?: { id: string };
}

/** Agent-authored text for the Web timeline, never enqueued as user input. */
export interface AgentMessage {
  id: string;
  text: string;
  createdAt: string;
  callId?: string;
  /** Set when the operator dismisses it in the Web UI; the model is never told. */
  readAt?: string;
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
  agentMessages: AgentMessage[];
  page: number;
  totalPages: number;
  maxMessageBytes: number;
  retentionHours: number;
}

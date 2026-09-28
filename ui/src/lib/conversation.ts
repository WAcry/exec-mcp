import type { NativeSessionItem, SessionSummary } from "../types";

export const UNSCOPED = "unscoped";

export type LiveState =
  | "asking"
  | "message"
  | "working"
  | "background"
  | "idle";

export interface ConversationState {
  state: LiveState;
  /** ChatGPT is inside a tool call right now. */
  working: boolean;
  /** A script continues after its call returned. */
  background: boolean;
  questions: number;
  /** Messages from ChatGPT the operator has not dismissed. */
  unread: number;
}

export function conversationState(
  summary: Pick<
    SessionSummary,
    "lastCall" | "pendingQuestions" | "unreadMessages"
  >,
  native?: NativeSessionItem,
): ConversationState {
  const questions = summary.pendingQuestions ?? 0;
  const unread = summary.unreadMessages ?? 0;
  const working =
    summary.lastCall?.status === "running" ||
    (!!native && !native.retired && native.users > 0);
  const background =
    !working &&
    ((!!native && !native.retired && native.activeCellCount > 0) ||
      summary.lastCall?.status === "yielding");
  return {
    state: questions
      ? "asking"
      : unread
        ? "message"
        : working
          ? "working"
          : background
            ? "background"
            : "idle",
    working,
    background,
    questions,
    unread,
  };
}

const RANK: Record<LiveState, number> = {
  asking: 0,
  message: 1,
  working: 2,
  background: 3,
  idle: 4,
};

/** What needs the operator first, then live work, then recency; unidentified calls sink. */
export function sortConversations(
  items: readonly SessionSummary[],
  native: Readonly<Record<string, NativeSessionItem>>,
): SessionSummary[] {
  const rank = (item: SessionSummary) =>
    RANK[conversationState(item, native[item.id]).state];
  return [...items].sort((a, b) => {
    if ((a.id === UNSCOPED) !== (b.id === UNSCOPED))
      return a.id === UNSCOPED ? 1 : -1;
    return rank(a) - rank(b) || b.lastActive.localeCompare(a.lastActive);
  });
}

/** Where the console opens: whatever needs attention, else the latest work. */
export function preferredConversation(
  items: readonly SessionSummary[],
  native: Readonly<Record<string, NativeSessionItem>>,
): SessionSummary | undefined {
  const sorted = sortConversations(items, native);
  return sorted.find((item) => item.id !== UNSCOPED) ?? sorted[0];
}

/** Notes are more likely to arrive soon while ChatGPT is still calling tools. */
export const RECENT_ACTIVITY_MS = 2 * 60_000;

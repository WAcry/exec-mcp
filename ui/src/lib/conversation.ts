import type { NativeSessionItem, SessionSummary } from "../types";

export const UNSCOPED = "unscoped";

export type LiveState = "asking" | "working" | "background" | "idle";

export interface ConversationState {
  state: LiveState;
  /** ChatGPT is inside a tool call right now. */
  working: boolean;
  /** A script continues after its call returned. */
  background: boolean;
  questions: number;
}

export function conversationState(
  summary: Pick<SessionSummary, "lastCall" | "pendingQuestions">,
  native?: NativeSessionItem,
): ConversationState {
  const questions = summary.pendingQuestions ?? 0;
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
      : working
        ? "working"
        : background
          ? "background"
          : "idle",
    working,
    background,
    questions,
  };
}

const RANK: Record<LiveState, number> = {
  asking: 0,
  working: 1,
  background: 2,
  idle: 3,
};

/** Questions first, then live work, then recency; unidentified calls sink. */
export function sortConversations(
  items: readonly SessionSummary[],
  native: Readonly<Record<string, NativeSessionItem>>,
): SessionSummary[] {
  return [...items].sort((a, b) => {
    if ((a.id === UNSCOPED) !== (b.id === UNSCOPED))
      return a.id === UNSCOPED ? 1 : -1;
    const rank =
      RANK[conversationState(a, native[a.id]).state] -
      RANK[conversationState(b, native[b.id]).state];
    return rank || b.lastActive.localeCompare(a.lastActive);
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

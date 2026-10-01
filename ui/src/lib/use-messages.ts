import { useCallback, useEffect, useRef, useState } from "react";
import type {
  SessionNote,
  AgentMessage,
} from "../../../src/session-notes-types";
import type { UserQuestionView } from "../../../src/user-questions-types";
import { useLiveEvents, usePollWhileOffline } from "../context/LiveContext";
import type { NotesResponse, QuestionsResponse } from "../types";
import { apiFetch, isApiError } from "./api";
import { coalesced } from "./coalesce";
import { errorFeedback } from "./errors";
import type { Feedback } from "./locale";

export interface ConversationMessages {
  loaded: boolean;
  /** Missing until the conversation has been observed while Web is listening. */
  available: boolean;
  label: string;
  notes: SessionNote[];
  agentMessages: AgentMessage[];
  questions: UserQuestionView[];
  pendingNotes: number;
  pendingQuestions: number;
  maxMessageBytes: number;
  retentionHours: number;
  error: Feedback;
}

const initial: ConversationMessages = {
  loaded: false,
  available: false,
  label: "",
  notes: [],
  agentMessages: [],
  questions: [],
  pendingNotes: 0,
  pendingQuestions: 0,
  maxMessageBytes: 30_000,
  retentionHours: 72,
  error: "",
};

/** Notes and questions for one conversation, refreshed by its change events. */
export function useMessages(sessionId: string | undefined) {
  const [state, setState] = useState<ConversationMessages>(initial);
  const loader = useRef<ReturnType<typeof coalesced> | null>(null);
  const [notePages, setNotePages] = useState(1);
  const pages = useRef(1);
  pages.current = notePages;
  const moreNotes = useRef(false);

  useEffect(() => {
    setState(initial);
    setNotePages(1);
    if (!sessionId) return;
    let disposed = false;
    const base = `/api/sessions/${encodeURIComponent(sessionId)}`;
    const load = coalesced(async () => {
      try {
        const notePageNumbers = Array.from(
          { length: pages.current },
          (_, index) => index + 1,
        );
        const [noteResults, questions] = await Promise.all([
          Promise.all(
            notePageNumbers.map((page) =>
              apiFetch<NotesResponse>(`${base}/notes?page=${page}`),
            ),
          ),
          apiFetch<QuestionsResponse>(`${base}/questions?page=1`),
        ]);
        if (disposed) return;
        const first = noteResults[0]!;
        const notes = new Map<string, SessionNote>();
        const agentMessages = new Map<string, AgentMessage>();
        for (const page of noteResults) {
          for (const note of page.items) notes.set(note.id, note);
          for (const message of page.agentMessages ?? [])
            agentMessages.set(message.id, message);
        }
        setState({
          loaded: true,
          available: true,
          label: first.label,
          notes: [...notes.values()].sort((a, b) => a.sequence - b.sequence),
          agentMessages: [...agentMessages.values()].sort((a, b) =>
            a.createdAt.localeCompare(b.createdAt),
          ),
          questions: questions.items,
          pendingNotes: first.pendingCount,
          pendingQuestions: first.pendingQuestions,
          maxMessageBytes: first.maxMessageBytes,
          retentionHours: first.retentionHours,
          error: "",
        });
        if (first.totalPages < pages.current) setNotePages(first.totalPages);
        moreNotes.current = first.totalPages > pages.current;
      } catch (error) {
        if (disposed) return;
        // Only an unknown conversation has no messages; other failures keep what is shown.
        const unknown = isApiError(error, "conversation_not_found");
        setState((previous) => ({
          ...previous,
          loaded: true,
          available: unknown ? false : previous.available,
          error: errorFeedback(error),
        }));
      }
    }, 150);
    loader.current = load;
    load.now();
    return () => {
      disposed = true;
      loader.current = null;
      load.dispose();
    };
  }, [sessionId]);

  usePollWhileOffline(() => loader.current?.schedule(), 15_000);

  useEffect(() => {
    if (notePages > 1) loader.current?.now();
  }, [notePages]);

  useLiveEvents((event) => {
    if (event.type === "session:notes" && event.sessionId === sessionId)
      loader.current?.schedule();
  });

  const refresh = useCallback(() => loader.current?.now(), []);
  const loadEarlierNotes = useCallback(() => {
    if (moreNotes.current) setNotePages((value) => value + 1);
  }, []);
  return {
    ...state,
    refresh,
    loadEarlierNotes,
    hasEarlierNotes: moreNotes.current,
  };
}

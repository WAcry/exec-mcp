import { useCallback, useEffect, useRef, useState } from "react";
import type {
  SessionNote,
  SessionNotesPage,
} from "../../../src/session-notes-types";
import type {
  UserQuestionsPage,
  UserQuestionView,
} from "../../../src/user-questions-types";
import { useLiveEvents } from "../context/LiveContext";
import { apiFetch } from "./api";
import { coalesced } from "./coalesce";

export interface ConversationMessages {
  loaded: boolean;
  /** Missing until the conversation has been observed while Web is listening. */
  available: boolean;
  label: string;
  notes: SessionNote[];
  questions: UserQuestionView[];
  pendingNotes: number;
  pendingQuestions: number;
  maxMessageBytes: number;
  retentionHours: number;
  error: string;
}

const initial: ConversationMessages = {
  loaded: false,
  available: false,
  label: "",
  notes: [],
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
              apiFetch<SessionNotesPage>(`${base}/notes?page=${page}`),
            ),
          ),
          apiFetch<UserQuestionsPage>(`${base}/questions?page=1`),
        ]);
        if (disposed) return;
        const first = noteResults[0]!;
        const notes = new Map<string, SessionNote>();
        for (const page of noteResults)
          for (const note of page.items) notes.set(note.id, note);
        setState({
          loaded: true,
          available: true,
          label: first.label,
          notes: [...notes.values()].sort((a, b) => a.sequence - b.sequence),
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
        const message = String(error);
        // 404: this conversation has no identity recorded for messages yet.
        setState((previous) => ({
          ...previous,
          loaded: true,
          available: false,
          error: message,
        }));
      }
    }, 150);
    loader.current = load;
    load.now();
    const poll = window.setInterval(load.schedule, 15_000);
    return () => {
      disposed = true;
      loader.current = null;
      load.dispose();
      window.clearInterval(poll);
    };
  }, [sessionId]);

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

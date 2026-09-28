import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { draftId } from "../lib/draft-id";
import { useAuth } from "./AuthContext";

export interface NoteDraft {
  id: string;
  text: string;
}

export interface AnswerDraft {
  id: string;
  option_index?: number | null;
  note: string;
}

export function newNoteDraft(text: string): NoteDraft {
  return { id: draftId(), text };
}

interface DraftsValue {
  notes: Record<string, NoteDraft>;
  answers: Record<string, Record<string, AnswerDraft>>;
  setNote(sessionId: string, draft: NoteDraft): void;
  /** Clears only the submitted draft, so newer typing or another conversation survives. */
  clearNote(sessionId: string, id: string): void;
  setAnswer(sessionId: string, questionId: string, draft: AnswerDraft): void;
  clearAnswer(sessionId: string, questionId: string, id: string): void;
}

const Context = createContext<DraftsValue | null>(null);

export function DraftsProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useAuth();
  const [notes, setNotes] = useState<Record<string, NoteDraft>>({});
  const [answers, setAnswers] = useState<
    Record<string, Record<string, AnswerDraft>>
  >({});
  useEffect(() => {
    if (isAuthenticated) return;
    setNotes({});
    setAnswers({});
  }, [isAuthenticated]);
  const setNote = useCallback((sessionId: string, draft: NoteDraft) => {
    setNotes((previous) => ({ ...previous, [sessionId]: draft }));
  }, []);
  const clearNote = useCallback((sessionId: string, id: string) => {
    setNotes((previous) => {
      if (previous[sessionId]?.id !== id) return previous;
      const next = { ...previous };
      delete next[sessionId];
      return next;
    });
  }, []);
  const setAnswer = useCallback(
    (sessionId: string, questionId: string, draft: AnswerDraft) => {
      setAnswers((previous) => ({
        ...previous,
        [sessionId]: { ...previous[sessionId], [questionId]: draft },
      }));
    },
    [],
  );
  const clearAnswer = useCallback(
    (sessionId: string, questionId: string, id: string) => {
      setAnswers((previous) => {
        if (previous[sessionId]?.[questionId]?.id !== id) return previous;
        const next = { ...previous[sessionId] };
        delete next[questionId];
        return { ...previous, [sessionId]: next };
      });
    },
    [],
  );
  const value = useMemo(
    () => ({ notes, answers, setNote, clearNote, setAnswer, clearAnswer }),
    [notes, answers, setNote, clearNote, setAnswer, clearAnswer],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useDrafts(): DraftsValue {
  const value = useContext(Context);
  if (!value) throw new Error("Missing DraftsProvider");
  return value;
}

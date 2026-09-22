import { useLocale } from "../context/LocaleContext";
import { message, feedback, type Feedback } from "../lib/locale";
import { useEffect, useRef, useState } from "react";
import { Check, Copy, Send } from "lucide-react";
import { apiFetch } from "../lib/api";
import { draftId } from "../lib/draft-id";
import {
  NOTE_MAX_BYTES,
  type SessionNote,
} from "../../../src/session-notes-types";
import {
  formatUserAnswer,
  type UserQuestionView,
} from "../../../src/user-questions-types";

export interface AnswerDraft {
  id: string;
  option_index?: number | null;
  note: string;
}
const button =
  "inline-flex items-center justify-center gap-1.5 rounded-md border border-zinc-200 dark:border-zinc-700 px-3 py-1.5 text-xs cursor-pointer hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed";

export function QuestionCard({
  question,
  sessionId,
  draft,
  onDraft,
  onSent,
  onChange,
}: {
  question: UserQuestionView;
  sessionId: string;
  draft: AnswerDraft | undefined;
  onDraft: (draft: AnswerDraft) => void;
  onSent: (id: string) => void;
  onChange: () => void;
}) {
  const { t, locale } = useLocale();

  const [error, setError] = useState<Feedback>("");
  const [notice, setNotice] = useState<Feedback>("");
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const choice = draft?.option_index;
  const note = draft?.note ?? "";
  const composed =
    choice === undefined ? "" : formatUserAnswer(question, choice, note);
  const byteLength = Math.max(
    new TextEncoder().encode(composed).length,
    new TextEncoder().encode(JSON.stringify(composed)).length,
  );
  const valid =
    choice !== undefined &&
    (choice !== null || !!note.trim()) &&
    byteLength <= NOTE_MAX_BYTES;
  const change = (next: Partial<AnswerDraft>) =>
    onDraft({ ...draft, note, id: draftId(), ...next });
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      if (mounted.current) setNotice(message("question.copied"));
    } catch {
      if (mounted.current) setError(message("question.copyFailed"));
    }
  };
  const submit = async () => {
    if (!draft || !valid || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    const submitted = draft;
    try {
      const saved = await apiFetch<SessionNote>(
        `/api/sessions/${encodeURIComponent(sessionId)}/questions/${encodeURIComponent(question.id)}/answer`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(submitted),
        },
      );
      onSent(submitted.id);
      onChange();
      if (mounted.current)
        setNotice(
          saved.status === "withdrawn"
            ? message("question.previousWithdrawn")
            : message("question.saved"),
        );
    } catch (e) {
      if (mounted.current)
        setError(message("question.submitFailed", String(e)));
      onChange();
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const withdraw = async () => {
    if (!question.answer || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      await apiFetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/notes/${encodeURIComponent(question.answer.noteId)}`,
        { method: "DELETE" },
      );
      onChange();
      if (mounted.current) setNotice(message("question.withdrawn"));
    } catch (e) {
      if (mounted.current) setError(String(e));
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <article
      data-question-id={question.id}
      className={`rounded-xl border p-4 space-y-3 ${question.pending ? "border-indigo-200 dark:border-indigo-900 bg-white dark:bg-zinc-900 shadow-xs" : "border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/50"}`}
    >
      <div className="flex justify-between items-center gap-2 text-[11px] text-zinc-500">
        <span>
          {t("question.fromAgent")}{" "}
          {new Date(question.createdAt).toLocaleString(locale)}
        </span>
        <span
          className={
            question.pending
              ? "text-indigo-600 dark:text-indigo-400 font-medium"
              : ""
          }
        >
          {question.pending ? t("question.pending") : t("question.answered")}
        </span>
      </div>
      <h3 className="text-sm font-semibold whitespace-pre-wrap break-words">
        {question.title}
      </h3>
      {question.pending ? (
        <>
          {question.delivery === "withdrawn" && (
            <p className="text-xs text-zinc-500">{t("question.selectAgain")}</p>
          )}
          <fieldset disabled={busy} className="space-y-2">
            <legend className="sr-only">
              {t("question.legend", question.title)}
            </legend>
            {[...question.options, t("question.none")].map((option, index) => {
              const value = index === question.options.length ? null : index;
              const selected = choice !== undefined && choice === value;
              return (
                <label
                  key={index}
                  className={`flex items-start gap-2.5 p-3 rounded-lg border cursor-pointer transition-colors ${selected ? "border-indigo-500 bg-indigo-50 dark:bg-indigo-950/40" : "border-zinc-200 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800"}`}
                >
                  <input
                    type="radio"
                    name={`answer-${question.id}`}
                    checked={selected}
                    onChange={() => change({ option_index: value })}
                    className="mt-0.5 shrink-0 accent-indigo-600"
                  />
                  <span className="text-sm whitespace-pre-wrap break-words min-w-0 flex-1">
                    {option}
                  </span>
                  {index === 0 && (
                    <span className="text-[10px] shrink-0 text-indigo-600 dark:text-indigo-400">
                      {t("question.recommended")}
                    </span>
                  )}
                </label>
              );
            })}
          </fieldset>
          <label
            className="block text-xs font-medium"
            htmlFor={`answer-note-${question.id}`}
          >
            {choice === null ? t("question.required") : t("question.optional")}
          </label>
          <textarea
            id={`answer-note-${question.id}`}
            rows={3}
            value={note}
            maxLength={NOTE_MAX_BYTES}
            disabled={busy}
            onChange={(e) => change({ note: e.target.value })}
            placeholder={t("question.placeholder")}
            className="w-full resize-y max-h-72 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />
          <div className="flex flex-wrap justify-between items-center gap-2">
            <span
              className={`text-[11px] ${byteLength > NOTE_MAX_BYTES ? "text-rose-500" : "text-zinc-500"}`}
            >
              {t(
                "question.bytes",
                byteLength.toLocaleString(locale),
                NOTE_MAX_BYTES.toLocaleString(locale),
              )}
            </span>
            <button
              className={`${button} bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 hover:bg-zinc-700 dark:hover:bg-zinc-200`}
              disabled={busy || !valid}
              onClick={() => void submit()}
            >
              <Send className="w-3 h-3" />
              {busy ? t("common.saving") : t("question.submit")}
            </button>
          </div>
        </>
      ) : (
        question.answer && (
          <>
            <div className="rounded-lg bg-white dark:bg-zinc-950 p-3 space-y-2 text-sm border border-zinc-200 dark:border-zinc-800">
              <p className="flex gap-2">
                <Check className="w-4 h-4 shrink-0 mt-0.5 text-emerald-600" />
                <span className="whitespace-pre-wrap break-words">
                  {question.answer.option_index === null
                    ? t("question.none")
                    : question.options[question.answer.option_index]}
                </span>
              </p>
              {question.answer.note && (
                <p className="whitespace-pre-wrap break-words text-zinc-600 dark:text-zinc-400">
                  {question.answer.note}
                </p>
              )}
            </div>
            <div className="flex flex-wrap justify-between items-center gap-2 text-xs text-zinc-500">
              <span>
                {question.delivery === "attached"
                  ? t("notes.attached")
                  : question.delivery === "pending"
                    ? t("question.queued")
                    : t("question.expired")}
              </span>
              <div className="flex gap-2">
                <button
                  className={button}
                  onClick={() =>
                    void copy(
                      formatUserAnswer(
                        question,
                        question.answer!.option_index,
                        question.answer!.note,
                      ),
                    )
                  }
                >
                  <Copy className="w-3 h-3" />
                  {t("question.copy")}
                </button>
                {question.delivery === "pending" && (
                  <button
                    className={button}
                    disabled={busy}
                    onClick={() => void withdraw()}
                  >
                    {t("question.withdraw")}
                  </button>
                )}
              </div>
            </div>
            {draft && (
              <div className="rounded-lg border border-amber-200 dark:border-amber-900 p-3 space-y-2">
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  {t("question.conflict")}
                </p>
                <pre className="text-xs whitespace-pre-wrap break-words max-h-40 overflow-auto">
                  {composed || note}
                </pre>
                <div className="flex gap-2">
                  <button
                    className={button}
                    onClick={() => void copy(composed || note)}
                  >
                    {t("question.copyDraft")}
                  </button>
                  <button className={button} onClick={() => onSent(draft.id)}>
                    {t("question.discard")}
                  </button>
                </div>
              </div>
            )}
          </>
        )
      )}
      {error && (
        <p
          role="alert"
          className="text-xs text-rose-600 dark:text-rose-400 break-words"
        >
          {feedback(error, t)}
        </p>
      )}
      {notice && (
        <p role="status" className="text-xs text-zinc-500">
          {feedback(notice, t)}
        </p>
      )}
    </article>
  );
}

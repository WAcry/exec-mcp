import { Check, MessageCircleQuestion, Undo2 } from "lucide-react";
import { useState } from "react";
import type { SessionNote } from "../../../../src/session-notes-types";
import {
  formatUserAnswer,
  type UserQuestionView,
} from "../../../../src/user-questions-types";
import { useDrafts } from "../../context/DraftsContext";
import { useLocale } from "../../context/LocaleContext";
import { apiFetch } from "../../lib/api";
import { errorText } from "../../lib/errors";
import { clockTime, fullTime } from "../../lib/format";
import { Button } from "../ui/Controls";
import { CopyButton } from "../ui/CopyButton";

export function QuestionEntry({
  question,
  sessionId,
  answerNote,
  carrierTime,
  attached = false,
  onAnswer,
  onLocate,
  onChanged,
}: {
  question: UserQuestionView;
  sessionId: string;
  answerNote?: SessionNote | undefined;
  carrierTime?: string | undefined;
  /** Rendered under the call that asked it, which already marks the time. */
  attached?: boolean;
  onAnswer(questionId: string): void;
  onLocate(callId: string): void;
  onChanged(): void;
}) {
  const { t, locale } = useLocale();
  const drafts = useDrafts();
  const draft = drafts.answers[sessionId]?.[question.id];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const answer = question.answer;
  const withdraw = async () => {
    if (!answer) return;
    setBusy(true);
    setError("");
    try {
      await apiFetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/notes/${encodeURIComponent(answer.noteId)}`,
        { method: "DELETE" },
      );
    } catch (caught) {
      setError(errorText(caught, t));
    } finally {
      setBusy(false);
      onChanged();
    }
  };
  const draftText =
    draft && draft.option_index !== undefined
      ? formatUserAnswer(question, draft.option_index, draft.note)
      : (draft?.note ?? "");
  // The dock below holds the full form; the timeline only marks where it was asked.
  if (attached && question.pending)
    return (
      <div className="grid grid-cols-[48px_20px_minmax(0,1fr)] gap-x-2 px-2 pb-2">
        <span />
        <span />
        <button
          type="button"
          onClick={() => onAnswer(question.id)}
          className="group/ask flex min-w-0 max-w-[44rem] items-center gap-2 rounded-lg border border-[color-mix(in_srgb,var(--warn)_40%,var(--line))] bg-surface px-3 py-2 text-left text-sm transition-colors hover:bg-hover"
        >
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn" />
          <span className="shrink-0 text-warn">{t("question.waiting")}</span>
          <span className="min-w-0 truncate text-ink-2">{question.title}</span>
          <span className="ml-auto shrink-0 text-xs font-medium text-ink group-hover/ask:underline">
            {t("question.answerNow")} ↓
          </span>
        </button>
      </div>
    );
  return (
    <div
      className={`grid grid-cols-[48px_20px_minmax(0,1fr)] gap-x-2 px-2 ${attached ? "pb-2" : "py-2"}`}
    >
      {attached ? (
        <>
          <span />
          <span />
        </>
      ) : (
        <>
          <time
            dateTime={question.createdAt}
            title={fullTime(question.createdAt, locale)}
            className="pt-3 text-right tabular text-2xs text-ink-3"
          >
            {clockTime(question.createdAt, locale)}
          </time>
          <span className="relative z-10 flex h-11 items-center justify-center">
            <span className="rounded-full bg-bg p-[3px]">
              <MessageCircleQuestion
                className={`h-3.5 w-3.5 ${question.pending ? "text-warn" : "text-ink-3"}`}
                strokeWidth={2}
              />
            </span>
          </span>
        </>
      )}
      <div
        data-question={question.id}
        className={`min-w-0 max-w-[44rem] rounded-xl border bg-surface px-4 py-3 ${question.pending ? "border-[color-mix(in_srgb,var(--warn)_45%,var(--line))]" : "border-line"}`}
      >
        {(!attached || question.pending) && (
          <p
            className={`mb-1 text-2xs font-medium ${question.pending ? "text-warn" : "text-ink-3"}`}
          >
            {question.pending
              ? t("question.askedPending")
              : t("question.asked")}
          </p>
        )}
        <p className="text-base whitespace-pre-wrap text-ink">
          {question.title}
        </p>
        {question.pending ? (
          <div className="mt-3 flex items-center gap-3">
            <Button
              tone="primary"
              size="sm"
              onClick={() => onAnswer(question.id)}
            >
              {t("question.answerNow")}
            </Button>
            {question.delivery === "withdrawn" && (
              <span className="text-xs text-ink-3">
                {t("question.selectAgain")}
              </span>
            )}
          </div>
        ) : (
          answer && (
            <>
              <ol className="mt-2.5 space-y-1">
                {[...question.options, null].map((option, index) => {
                  const value = option === null ? null : index;
                  const chosen = answer.option_index === value;
                  if (option === null && !chosen) return null;
                  return (
                    <li
                      key={index}
                      className={`flex items-start gap-2 text-sm ${chosen ? "text-ink" : "text-ink-3"}`}
                    >
                      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
                        {chosen ? (
                          <Check
                            className="h-3.5 w-3.5 text-ok"
                            strokeWidth={2.4}
                          />
                        ) : (
                          <span className="h-1 w-1 rounded-full bg-ink-4" />
                        )}
                      </span>
                      <span className="whitespace-pre-wrap">
                        {option ?? t("question.none")}
                      </span>
                    </li>
                  );
                })}
              </ol>
              {answer.note && (
                <div className="mt-2.5 flex justify-end">
                  <p className="max-w-[90%] rounded-2xl rounded-br-md bg-you px-3 py-1.5 text-sm whitespace-pre-wrap text-you-ink">
                    {answer.note}
                  </p>
                </div>
              )}
              <div className="mt-2.5 flex flex-wrap items-center gap-2 border-t border-line pt-2 text-2xs text-ink-3">
                {question.delivery === "attached" ? (
                  <button
                    type="button"
                    disabled={!answerNote?.callId}
                    onClick={() =>
                      answerNote?.callId && onLocate(answerNote.callId)
                    }
                    className="inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-hover hover:text-ink"
                  >
                    <Check className="h-3 w-3 text-ok" strokeWidth={2.2} />
                    {carrierTime
                      ? t("note.deliveredWith", clockTime(carrierTime, locale))
                      : t("note.delivered")}
                  </button>
                ) : question.delivery === "pending" ? (
                  <span>{t("question.queued")}</span>
                ) : (
                  <span>{t("question.expired")}</span>
                )}
                <span className="ml-auto flex items-center gap-1">
                  {question.delivery === "pending" && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void withdraw()}
                      className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-ink-2 hover:bg-hover hover:text-ink"
                    >
                      <Undo2 className="h-3 w-3" />
                      {t("question.withdraw")}
                    </button>
                  )}
                  <CopyButton
                    text={formatUserAnswer(
                      question,
                      answer.option_index,
                      answer.note,
                    )}
                    label={t("question.copy")}
                    className="h-5 w-5"
                  />
                </span>
              </div>
            </>
          )
        )}
        {draft && !question.pending && (
          <div className="mt-3 rounded-lg border border-line bg-sunken px-3 py-2.5">
            <p className="text-xs font-medium text-warn">
              {t("question.conflict")}
            </p>
            <pre className="mt-1.5 max-h-32 overflow-auto font-sans text-sm whitespace-pre-wrap text-ink-2">
              {draftText}
            </pre>
            <div className="mt-2 flex gap-2">
              <CopyButton
                text={draftText}
                label={t("question.copyDraft")}
                iconOnly={false}
              />
              <Button
                size="sm"
                tone="ghost"
                onClick={() =>
                  drafts.clearAnswer(sessionId, question.id, draft.id)
                }
              >
                {t("question.discard")}
              </Button>
            </div>
          </div>
        )}
        {error && <p className="mt-2 text-xs text-err">{error}</p>}
      </div>
    </div>
  );
}

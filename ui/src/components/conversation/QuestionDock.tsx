import {
  BellRing,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  NOTE_MAX_BYTES,
  type SessionNote,
} from "../../../../src/session-notes-types";
import {
  formatUserAnswer,
  type UserQuestionView,
} from "../../../../src/user-questions-types";
import { useDrafts, type AnswerDraft } from "../../context/DraftsContext";
import { useLive } from "../../context/LiveContext";
import { useLocale } from "../../context/LocaleContext";
import { apiFetch } from "../../lib/api";
import { errorFeedback } from "../../lib/errors";
import { draftId } from "../../lib/draft-id";
import { formatAgo, utf8Bytes } from "../../lib/format";
import { feedback, message, type Feedback } from "../../lib/locale";
import { useNow } from "../../lib/use-now";
import { Button, Kbd } from "../ui/Controls";
import { AutoTextarea } from "./AutoTextarea";

export function QuestionDock({
  sessionId,
  questions,
  focusId,
  onSubmitted,
}: {
  sessionId: string;
  questions: UserQuestionView[];
  /** Bumped by "Answer" buttons in the timeline to bring a question forward. */
  focusId: { id: string; at: number } | null;
  onSubmitted(message: Feedback): void;
}) {
  const { t, locale } = useLocale();
  const { notifications } = useLive();
  const drafts = useDrafts();
  const now = useNow(30_000);
  const pending = useMemo(
    () =>
      questions
        .filter((question) => question.pending)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [questions],
  );
  const [index, setIndex] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const [error, setError] = useState<Feedback>("");
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  const note = useRef<HTMLTextAreaElement>(null);

  const newest = pending.at(-1)?.id;
  useEffect(() => {
    setCollapsed(false);
  }, [newest]);
  useEffect(() => {
    if (!focusId) return;
    setCollapsed(false);
    const target = pending.findIndex((question) => question.id === focusId.id);
    if (target >= 0) setIndex(target);
    window.requestAnimationFrame(() =>
      root.current?.querySelector<HTMLElement>("[role=radio]")?.focus(),
    );
  }, [focusId, pending]);

  const current = pending[Math.min(index, pending.length - 1)];
  useEffect(() => {
    setError("");
  }, [current?.id]);
  if (!current) return null;

  const draft = drafts.answers[sessionId]?.[current.id];
  const choice = draft?.option_index;
  const text = draft?.note ?? "";
  const composed =
    choice === undefined ? "" : formatUserAnswer(current, choice, text);
  const bytes = Math.max(
    utf8Bytes(composed),
    utf8Bytes(JSON.stringify(composed)),
  );
  const valid =
    choice !== undefined &&
    (choice !== null || !!text.trim()) &&
    bytes <= NOTE_MAX_BYTES;
  const change = (next: Partial<AnswerDraft>) =>
    drafts.setAnswer(sessionId, current.id, {
      ...draft,
      note: text,
      ...next,
      id: draftId(),
    });
  const choose = (value: number | null) => {
    change({ option_index: value });
    window.requestAnimationFrame(() => {
      if (value === null) note.current?.focus();
    });
  };

  const submit = async () => {
    if (!draft || !valid || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    const submitted = draft;
    try {
      const saved = await apiFetch<SessionNote>(
        `/api/sessions/${encodeURIComponent(sessionId)}/questions/${encodeURIComponent(current.id)}/answer`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(submitted),
        },
      );
      drafts.clearAnswer(sessionId, current.id, submitted.id);
      onSubmitted(
        saved.status === "withdrawn"
          ? message("question.previousWithdrawn")
          : message("question.saved"),
      );
    } catch (caught) {
      setError(message("question.submitFailed", errorFeedback(caught)));
      onSubmitted("");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const options: (string | null)[] = [...current.options, null];
  if (collapsed)
    return (
      <button
        type="button"
        onClick={() => setCollapsed(false)}
        aria-expanded={false}
        className="rise-in flex w-full min-w-0 items-center gap-2 rounded-2xl border border-line bg-surface px-4 py-2.5 text-left text-sm shadow-(--dock-shadow) transition-colors hover:bg-hover"
      >
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn" />
        <span className="shrink-0 font-medium text-ink-2">
          {t("dock.title")}
        </span>
        <span className="min-w-0 truncate text-ink-3">{current.title}</span>
        {pending.length > 1 && (
          <span className="shrink-0 text-2xs tabular text-ink-3">
            {t(
              "dock.position",
              Math.min(index, pending.length - 1) + 1,
              pending.length,
            )}
          </span>
        )}
        <ChevronUp className="ml-auto h-4 w-4 shrink-0 text-ink-3" />
      </button>
    );
  return (
    <div
      ref={root}
      role="group"
      aria-label={t("dock.label")}
      onKeyDown={(event) => {
        if (event.target instanceof HTMLTextAreaElement) return;
        const digit = Number(event.key);
        if (Number.isInteger(digit) && digit >= 1 && digit <= options.length) {
          event.preventDefault();
          choose(digit === options.length ? null : digit - 1);
        }
      }}
      className="rise-in rounded-2xl border border-line bg-surface px-4 pt-3 pb-3.5 shadow-(--dock-shadow)"
    >
      <div className="flex items-center gap-2 text-xs">
        <span className="h-1.5 w-1.5 rounded-full bg-warn" />
        <span className="font-medium text-ink-2">{t("dock.title")}</span>
        <span className="text-ink-3">
          · {formatAgo(now - new Date(current.createdAt).getTime(), t)}
        </span>
        <span className="ml-auto" />
        {pending.length > 1 && (
          <span className="flex items-center gap-1 tabular text-ink-3">
            <button
              type="button"
              aria-label={t("common.previous")}
              disabled={index === 0}
              onClick={() => setIndex((value) => Math.max(0, value - 1))}
              className="flex h-6 w-6 items-center justify-center rounded-md hover:bg-hover hover:text-ink disabled:opacity-30"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            {t(
              "dock.position",
              Math.min(index, pending.length - 1) + 1,
              pending.length,
            )}
            <button
              type="button"
              aria-label={t("common.next")}
              disabled={index >= pending.length - 1}
              onClick={() =>
                setIndex((value) => Math.min(pending.length - 1, value + 1))
              }
              className="flex h-6 w-6 items-center justify-center rounded-md hover:bg-hover hover:text-ink disabled:opacity-30"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </span>
        )}
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          aria-label={t("dock.collapse")}
          title={t("dock.collapse")}
          className="-mr-1.5 flex h-6 w-6 items-center justify-center rounded-md text-ink-3 hover:bg-hover hover:text-ink"
        >
          <ChevronDown className="h-4 w-4" />
        </button>
      </div>
      <p className="mt-1.5 max-h-36 overflow-y-auto text-base font-medium whitespace-pre-wrap text-ink scroll-thin">
        {current.title}
      </p>
      {current.delivery === "withdrawn" && (
        <p className="mt-1 text-xs text-ink-3">{t("question.selectAgain")}</p>
      )}
      <div
        role="radiogroup"
        aria-label={t("question.legend", current.title)}
        className="mt-2.5 space-y-1"
      >
        {options.map((option, optionIndex) => {
          const value = option === null ? null : optionIndex;
          const selected = choice !== undefined && choice === value;
          return (
            <div
              key={optionIndex}
              role="radio"
              aria-checked={selected}
              tabIndex={
                selected || (choice === undefined && optionIndex === 0) ? 0 : -1
              }
              onClick={() => choose(value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  choose(value);
                } else if (
                  event.key === "ArrowDown" ||
                  event.key === "ArrowUp"
                ) {
                  event.preventDefault();
                  const radios = [
                    ...root.current!.querySelectorAll<HTMLElement>(
                      "[role=radio]",
                    ),
                  ];
                  const next =
                    radios[
                      (optionIndex +
                        (event.key === "ArrowDown" ? 1 : -1) +
                        radios.length) %
                        radios.length
                    ];
                  next?.focus();
                }
              }}
              className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-1.5 transition-colors duration-150 ${selected ? "border-ink bg-hover" : "border-line hover:border-line-strong hover:bg-hover"}`}
            >
              <span
                className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors ${selected ? "border-ink bg-ink" : "border-line-strong"}`}
              >
                {selected && (
                  <span className="h-1.5 w-1.5 rounded-full bg-surface" />
                )}
              </span>
              <span
                className={`min-w-0 flex-1 text-sm whitespace-pre-wrap ${option === null ? "text-ink-2" : "text-ink"}`}
              >
                {option ?? t("question.none")}
              </span>
              {optionIndex === 0 && (
                <span className="shrink-0 pt-px text-2xs text-ink-3">
                  {t("question.recommended")}
                </span>
              )}
              <span className="hidden sm:contents [@media(hover:none)]:hidden">
                <Kbd>{optionIndex + 1}</Kbd>
              </span>
            </div>
          );
        })}
      </div>
      <div className="reveal" data-open={choice !== undefined}>
        <div inert={choice === undefined}>
          <label className="mt-2.5 block">
            <span className="sr-only">
              {choice === null
                ? t("question.required")
                : t("question.optional")}
            </span>
            <AutoTextarea
              ref={note}
              value={text}
              maxRows={6}
              disabled={busy}
              onChange={(value) => change({ note: value })}
              onSubmit={() => void submit()}
              placeholder={
                choice === null
                  ? t("question.customPlaceholder")
                  : t("question.notePlaceholder")
              }
              className="w-full rounded-lg border border-line bg-sunken px-3 py-2 text-sm text-ink outline-none transition-colors focus:border-line-strong"
            />
          </label>
        </div>
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="min-w-0 flex-1 text-2xs text-ink-3">
          {bytes > NOTE_MAX_BYTES * 0.8 ? (
            <span className={bytes > NOTE_MAX_BYTES ? "text-err" : ""}>
              {t(
                "question.bytes",
                bytes.toLocaleString(locale),
                NOTE_MAX_BYTES.toLocaleString(locale),
              )}
            </span>
          ) : (
            t("dock.delivery")
          )}
        </span>
        {notifications.state === "default" && (
          <button
            type="button"
            onClick={() => void notifications.enable()}
            className="inline-flex items-center gap-1 text-2xs text-ink-2 hover:text-ink"
          >
            <BellRing className="h-3 w-3" />
            {t("dock.notify")}
          </button>
        )}
        <Button
          tone="primary"
          size="sm"
          disabled={busy || !valid}
          onClick={() => void submit()}
        >
          {busy ? t("common.saving") : t("question.submit")}
        </Button>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-xs text-err">
          {feedback(error, t)}
        </p>
      )}
    </div>
  );
}

import { ArrowUp } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  NOTE_MAX_BYTES,
  type SessionNote,
} from "../../../../src/session-notes-types";
import { newNoteDraft, useDrafts } from "../../context/DraftsContext";
import { useLocale } from "../../context/LocaleContext";
import { apiFetch } from "../../lib/api";
import { utf8Bytes } from "../../lib/format";
import { feedback, message, type Feedback } from "../../lib/locale";
import { isTyping } from "../../lib/use-media";
import { CopyButton } from "../ui/CopyButton";
import { AutoTextarea } from "./AutoTextarea";

/** How soon a note is likely to arrive, judged from the conversation's live state. */
export type DeliveryOutlook = "working" | "recent" | "idle" | "unavailable";

export function Composer({
  sessionId,
  outlook,
  onSent,
}: {
  sessionId: string;
  outlook: DeliveryOutlook;
  onSent(note: SessionNote, from: DOMRect): void;
}) {
  const { t, locale } = useLocale();
  const drafts = useDrafts();
  const draft = drafts.notes[sessionId];
  const text = draft?.text ?? "";
  const bytes = utf8Bytes(text);
  const input = useRef<HTMLTextAreaElement>(null);
  const [focused, setFocused] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<Feedback>("");
  const [notice, setNotice] = useState<Feedback>("");
  const inFlight = useRef(false);
  const disabled = outlook === "unavailable";

  useEffect(() => {
    const focus = () => {
      if (!disabled) input.current?.focus();
    };
    const key = (event: KeyboardEvent) => {
      if (disabled || event.defaultPrevented || isTyping(event.target)) return;
      if (event.key !== "c" || event.metaKey || event.ctrlKey || event.altKey)
        return;
      event.preventDefault();
      input.current?.focus();
    };
    window.addEventListener("keydown", key);
    window.addEventListener("exec:focus-composer", focus);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("exec:focus-composer", focus);
    };
  }, [disabled]);

  const send = async () => {
    if (!draft || !text.trim() || bytes > NOTE_MAX_BYTES || inFlight.current)
      return;
    const submitted = draft;
    const from = input.current?.getBoundingClientRect();
    inFlight.current = true;
    setSending(true);
    setError("");
    setNotice("");
    try {
      const saved = await apiFetch<SessionNote>(
        `/api/sessions/${encodeURIComponent(sessionId)}/notes`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(submitted),
        },
      );
      drafts.clearNote(sessionId, submitted.id);
      if (saved.status === "attached")
        setNotice(message("notes.alreadyAttached"));
      else if (saved.status === "withdrawn")
        setNotice(message("notes.alreadyWithdrawn"));
      if (from) onSent(saved, from);
    } catch (caught) {
      setError(message("notes.sendFailed", String(caught)));
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  };

  const ready = !!text.trim() && bytes <= NOTE_MAX_BYTES && !sending;
  return (
    <div>
      <div
        className={`rounded-2xl border bg-surface shadow-(--dock-shadow) transition-colors duration-150 ${focused ? "border-line-strong" : "border-line"} ${disabled ? "opacity-70" : ""}`}
      >
        <div className="flex items-end gap-2 py-2 pr-2 pl-4">
          <AutoTextarea
            ref={input}
            value={text}
            disabled={disabled || sending}
            enterSubmits
            maxRows={8}
            onChange={(value) => drafts.setNote(sessionId, newNoteDraft(value))}
            onSubmit={() => void send()}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            aria-label={t("composer.label")}
            placeholder={
              disabled ? t("composer.unavailable") : t("composer.placeholder")
            }
            className="min-h-9 flex-1 bg-transparent py-2 text-base text-ink outline-none disabled:cursor-not-allowed"
          />
          <button
            type="button"
            onClick={() => void send()}
            disabled={!ready || disabled}
            aria-label={t("composer.send")}
            title={t("composer.send")}
            className="mb-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ink text-bg transition-[background-color,opacity,transform] duration-150 enabled:hover:scale-[1.04] disabled:bg-line-strong disabled:text-ink-3"
          >
            <ArrowUp className="h-4 w-4" strokeWidth={2.4} />
          </button>
        </div>
      </div>
      <div className="mt-1.5 flex min-h-5 items-center gap-2 px-1 text-2xs text-ink-3">
        {error ? (
          <span role="alert" className="text-err">
            {feedback(error, t)}
          </span>
        ) : notice ? (
          <span role="status">{feedback(notice, t)}</span>
        ) : disabled ? (
          <span>{t("composer.unavailableHelp")}</span>
        ) : outlook === "working" ? (
          <span className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-ok" />
            {t("composer.working")}
          </span>
        ) : outlook === "recent" ? (
          <span>{t("composer.recent")}</span>
        ) : (
          <span className="flex min-w-0 items-center gap-1">
            <span className="min-w-0 truncate">{t("composer.idle")}</span>
            {text.trim() && (
              <CopyButton
                text={text}
                label={t("composer.copy")}
                iconOnly={false}
                className="h-5 px-1 text-2xs"
              />
            )}
          </span>
        )}
        <span className="ml-auto shrink-0 tabular">
          {bytes > NOTE_MAX_BYTES * 0.8 ? (
            <span className={bytes > NOTE_MAX_BYTES ? "text-err" : ""}>
              {bytes.toLocaleString(locale)} /{" "}
              {NOTE_MAX_BYTES.toLocaleString(locale)}
            </span>
          ) : (
            focused && !disabled && t("composer.keys")
          )}
        </span>
      </div>
    </div>
  );
}

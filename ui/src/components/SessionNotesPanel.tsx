import { useLocale } from "../context/LocaleContext";
import { message, feedback, type Feedback } from "../lib/locale";
import { useEffect, useRef, useState } from "react";
import { Copy, Send, X, Pencil, Check, MessageSquare } from "lucide-react";
import { apiFetch } from "../lib/api";
import { draftId } from "../lib/draft-id";
import { SessionQuestions } from "./SessionQuestions";
import type { AnswerDraft } from "./QuestionCard";
import {
  NOTE_LABEL_BYTES,
  NOTE_MAX_BYTES,
  type SessionNote,
  type SessionNotesPage,
} from "../../../src/session-notes-types";

export interface NoteDraft {
  id: string;
  text: string;
}
export function newNoteDraft(text: string): NoteDraft {
  return {
    id: draftId(),
    text,
  };
}
const bytes = (text: string) => new TextEncoder().encode(text).length;
const actionClass =
  "inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-zinc-200 dark:border-zinc-700 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer";

export function SessionNotesPanel({
  sessionId,
  draft,
  onDraft,
  onSent,
  onClose,
  onChange,
  revision,
  tab,
  onTabChange: setTab,
  answerDrafts,
  onAnswerDraft,
  onAnswerSent,
}: {
  sessionId: string;
  draft: NoteDraft | undefined;
  onDraft: (draft: NoteDraft) => void;
  onSent: (id: string) => void;
  onClose: () => void;
  onChange: () => void;
  revision: number;
  tab: "notes" | "questions";
  onTabChange: (tab: "notes" | "questions") => void;
  answerDrafts: Record<string, AnswerDraft>;
  onAnswerDraft: (questionId: string, draft: AnswerDraft) => void;
  onAnswerSent: (questionId: string, draftId: string) => void;
}) {
  const { t, locale } = useLocale();

  const [data, setData] = useState<SessionNotesPage | null>(null);
  const [error, setError] = useState<Feedback>("");
  const [notice, setNotice] = useState<Feedback>("");
  const [sending, setSending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [label, setLabel] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const input = useRef<HTMLTextAreaElement>(null);
  const pendingSend = useRef(false);
  const mounted = useRef(true);
  const base = `/api/sessions/${encodeURIComponent(sessionId)}`;
  const body = draft?.text ?? "";
  const bodyBytes = bytes(body);
  const questionChanged = () => {
    setRefresh((v) => v + 1);
    onChange();
  };

  useEffect(() => {
    mounted.current = true;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    input.current?.focus();
    return () => {
      mounted.current = false;
      document.body.style.overflow = overflow;
    };
  }, []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  useEffect(() => {
    let disposed = false;
    let controller: AbortController | undefined;
    const load = async () => {
      controller?.abort();
      const request = new AbortController();
      controller = request;
      try {
        const next = await apiFetch<SessionNotesPage>(
          `${base}/notes?page=${page}`,
          { signal: request.signal },
        );
        if (!disposed && !request.signal.aborted) {
          setData(next);
          if (next.page !== page) setPage(next.page);
        }
      } catch (e) {
        if (!disposed && !request.signal.aborted) setError(String(e));
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 5000);
    return () => {
      disposed = true;
      controller?.abort();
      window.clearInterval(timer);
    };
  }, [base, page, refresh, revision]);

  const send = async () => {
    if (
      !draft ||
      !body.trim() ||
      bodyBytes > NOTE_MAX_BYTES ||
      pendingSend.current
    )
      return;
    const submitted = draft;
    pendingSend.current = true;
    setSending(true);
    setError("");
    setNotice("");
    try {
      const saved = await apiFetch<SessionNote>(`${base}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(submitted),
      });
      onSent(submitted.id); // Parent checks the id, so a new draft or another conversation is never cleared.
      onChange();
      if (mounted.current) {
        setPage(1);
        setRefresh((v) => v + 1);
        setNotice(
          saved.status === "pending"
            ? message("notes.saved")
            : saved.status === "attached"
              ? message("notes.alreadyAttached")
              : message("notes.alreadyWithdrawn"),
        );
      }
    } catch (e) {
      if (mounted.current) setError(message("notes.sendFailed", String(e)));
    } finally {
      pendingSend.current = false;
      if (mounted.current) setSending(false);
    }
  };
  const rename = async () => {
    if (label === null || bytes(label) > NOTE_LABEL_BYTES || saving) return;
    setSaving(true);
    setError("");
    try {
      await apiFetch(base, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label }),
      });
      if (mounted.current) {
        setLabel(null);
        setRefresh((v) => v + 1);
      }
      onChange();
    } catch (e) {
      if (mounted.current) setError(String(e));
    } finally {
      if (mounted.current) setSaving(false);
    }
  };
  const withdraw = async (id: string) => {
    setError("");
    try {
      await apiFetch(`${base}/notes/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      onChange();
    } catch (e) {
      if (mounted.current) setError(String(e));
    } finally {
      if (mounted.current) setRefresh((v) => v + 1);
    }
  };
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      if (mounted.current) setNotice(message("notes.copied"));
    } catch {
      if (mounted.current) setError(message("notes.copyFailed"));
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/40 backdrop-blur-xs"
      onClick={onClose}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={t("notes.dialog")}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-xl h-full bg-white dark:bg-zinc-950 border-l border-zinc-200 dark:border-zinc-800 shadow-2xl flex flex-col text-zinc-900 dark:text-zinc-100"
      >
        <header className="px-5 py-4 border-b border-zinc-200 dark:border-zinc-800 space-y-2">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold flex items-center gap-2">
              <MessageSquare className="w-4 h-4" />
              {t("notes.title")}
            </h2>
            <button
              className={actionClass}
              aria-label={t("notes.close")}
              onClick={onClose}
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <p
            className="font-mono text-xs break-all select-all"
            data-session-hash={sessionId}
          >
            {sessionId}
          </p>
          {label === null ? (
            <div className="flex items-center gap-2">
              <span className="text-xs break-all">
                {data?.label || t("notes.noLabel")}
              </span>
              <button
                className={actionClass}
                disabled={!data}
                onClick={() => setLabel(data?.label ?? "")}
              >
                <Pencil className="w-3 h-3" />
                {t("notes.label")}
              </button>
            </div>
          ) : (
            <div className="flex gap-2 items-center">
              <input
                aria-label={t("notes.labelInput")}
                value={label}
                maxLength={256}
                onChange={(e) => setLabel(e.target.value)}
                placeholder={t("notes.labelPlaceholder")}
                className="min-w-0 flex-1 rounded-md border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1.5 text-xs"
              />
              <button
                className={actionClass}
                disabled={saving || bytes(label) > NOTE_LABEL_BYTES}
                onClick={() => void rename()}
                aria-label={t("notes.labelSave")}
              >
                <Check className="w-3 h-3" />
              </button>
              <button
                className={actionClass}
                onClick={() => setLabel(null)}
                aria-label={t("notes.labelCancel")}
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          )}
          <p className="text-xs text-zinc-500">{t("notes.delivery")}</p>
        </header>

        <div
          role="tablist"
          aria-label={t("notes.tabs")}
          className="flex gap-1 border-b border-zinc-200 dark:border-zinc-800 px-4"
        >
          <button
            role="tab"
            aria-selected={tab === "questions"}
            onClick={() => setTab("questions")}
            className={`px-3 py-3 text-xs cursor-pointer border-b-2 ${tab === "questions" ? "border-indigo-500 text-indigo-600 dark:text-indigo-400" : "border-transparent text-zinc-500"}`}
          >
            {t("notes.questions")}
            {data?.pendingQuestions
              ? t("notes.questionsPending", data.pendingQuestions)
              : ""}
          </button>
          <button
            role="tab"
            aria-selected={tab === "notes"}
            onClick={() => setTab("notes")}
            className={`px-3 py-3 text-xs cursor-pointer border-b-2 ${tab === "notes" ? "border-indigo-500 text-indigo-600 dark:text-indigo-400" : "border-transparent text-zinc-500"}`}
          >
            {t("notes.messages")}
            {data?.pendingCount
              ? t("notes.messagesPending", data.pendingCount)
              : ""}
          </button>
        </div>
        {tab === "questions" && (
          <>
            {error && (
              <p
                role="alert"
                className="px-5 pt-3 text-xs text-rose-600 break-words"
              >
                {feedback(error, t)}
              </p>
            )}
            <SessionQuestions
              sessionId={sessionId}
              drafts={answerDrafts}
              onDraft={onAnswerDraft}
              onSent={onAnswerSent}
              onChange={questionChanged}
              revision={revision + refresh}
            />
          </>
        )}
        {tab === "notes" && (
          <>
            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
              <div className="flex items-center justify-between text-xs text-zinc-500">
                <span>{t("notes.history")}</span>
                <span>{t("notes.pendingCount", data?.pendingCount ?? 0)}</span>
              </div>
              {!data ? (
                <p className="text-xs text-zinc-500">{t("common.loading")}</p>
              ) : data.items.length === 0 ? (
                <p className="text-xs text-zinc-500 py-10 text-center">
                  {t("notes.empty")}
                </p>
              ) : (
                data.items.map((note) => (
                  <article
                    key={note.id}
                    data-note-id={note.id}
                    className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 px-3 py-3 space-y-2"
                  >
                    <div className="flex justify-between flex-wrap gap-1 text-[11px] text-zinc-500">
                      <span>
                        #{note.sequence} ·{" "}
                        {new Date(note.createdAt).toLocaleString(locale)}
                      </span>
                      <span>
                        {note.status === "pending"
                          ? t("notes.pending")
                          : note.status === "attached"
                            ? t("notes.attached")
                            : t("notes.withdrawn")}
                      </span>
                    </div>
                    <p className="text-sm whitespace-pre-wrap break-words max-h-64 overflow-auto">
                      {note.text}
                    </p>
                    {note.callId && (
                      <p className="text-[10px] font-mono text-zinc-500 break-all">
                        {t("notes.call")}
                        {note.callId}
                      </p>
                    )}
                    <div className="flex gap-2">
                      <button
                        className={actionClass}
                        onClick={() => void copy(note.text)}
                      >
                        <Copy className="w-3 h-3" />
                        {t("common.copy")}
                      </button>
                      {note.status === "pending" && (
                        <button
                          className={actionClass}
                          onClick={() => void withdraw(note.id)}
                        >
                          {t("notes.withdraw")}
                        </button>
                      )}
                    </div>
                  </article>
                ))
              )}
              {data && data.totalPages > 1 && (
                <div className="flex justify-between gap-2 text-xs items-center">
                  <button
                    className={actionClass}
                    disabled={page <= 1}
                    onClick={() => setPage((v) => v - 1)}
                  >
                    {t("notes.newer")}
                  </button>
                  <span>
                    {page} / {data.totalPages}
                  </span>
                  <button
                    className={actionClass}
                    disabled={page >= data.totalPages}
                    onClick={() => setPage((v) => v + 1)}
                  >
                    {t("notes.older")}
                  </button>
                </div>
              )}
            </div>

            <footer className="border-t border-zinc-200 dark:border-zinc-800 px-5 py-4 space-y-2">
              {error && (
                <p
                  role="alert"
                  className="text-xs text-rose-600 dark:text-rose-400 break-words"
                >
                  {feedback(error, t)}
                </p>
              )}
              {notice && (
                <p
                  role="status"
                  className="text-xs text-zinc-600 dark:text-zinc-400"
                >
                  {feedback(notice, t)}
                </p>
              )}
              <label htmlFor="note-body" className="text-xs font-medium">
                {t("notes.send")}
              </label>
              <textarea
                ref={input}
                id="note-body"
                value={body}
                onChange={(e) => onDraft(newNoteDraft(e.target.value))}
                maxLength={NOTE_MAX_BYTES}
                disabled={sending}
                rows={4}
                placeholder={t("notes.placeholder")}
                className="w-full resize-y max-h-60 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-zinc-500"
              />
              <div className="flex items-center justify-between">
                <span
                  className={`text-[11px] font-mono ${bodyBytes > NOTE_MAX_BYTES ? "text-rose-500" : "text-zinc-500"}`}
                >
                  {bodyBytes.toLocaleString(locale)} /{" "}
                  {NOTE_MAX_BYTES.toLocaleString(locale)}{" "}
                  {t("common.utf8Bytes")}
                </span>
                <button
                  className={actionClass}
                  disabled={
                    !data ||
                    sending ||
                    !body.trim() ||
                    bodyBytes > NOTE_MAX_BYTES
                  }
                  onClick={() => void send()}
                >
                  <Send className="w-3 h-3" />
                  {sending ? t("common.saving") : t("notes.send")}
                </button>
              </div>
              <p className="text-[11px] leading-relaxed text-zinc-500">
                {t("notes.retention")}
              </p>
            </footer>
          </>
        )}
      </section>
    </div>
  );
}

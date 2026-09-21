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
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
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
      if (mounted.current) setNotice("已复制，可粘贴到原对话。");
    } catch {
      if (mounted.current) setError("复制失败，请手动选择答复文本。");
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
            ? "这份答复已撤回，可以重新作答。"
            : "答复已保存，将随本对话的工具响应附带。",
        );
    } catch (e) {
      if (mounted.current)
        setError(`提交未确认：${String(e)}。草稿已保留；同一提交重试会去重。`);
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
      if (mounted.current) setNotice("答复已撤回，可以重新作答。");
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
          Agent 提问 · {new Date(question.createdAt).toLocaleString()}
        </span>
        <span
          className={
            question.pending
              ? "text-indigo-600 dark:text-indigo-400 font-medium"
              : ""
          }
        >
          {question.pending ? "待回答" : "已回答"}
        </span>
      </div>
      <h3 className="text-sm font-semibold whitespace-pre-wrap break-words">
        {question.title}
      </h3>
      {question.pending ? (
        <>
          {question.delivery === "withdrawn" && (
            <p className="text-xs text-zinc-500">
              上一份答复已撤回，请重新选择。
            </p>
          )}
          <fieldset disabled={busy} className="space-y-2">
            <legend className="sr-only">{question.title}：选择答案</legend>
            {[...question.options, "以上都不是"].map((option, index) => {
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
                      推荐
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
            {choice === null ? "你的回答（必填）" : "补充说明（可选）"}
          </label>
          <textarea
            id={`answer-note-${question.id}`}
            rows={3}
            value={note}
            maxLength={NOTE_MAX_BYTES}
            disabled={busy}
            onChange={(e) => change({ note: e.target.value })}
            placeholder="例如：采用这个方案，但先不要迁移现有数据。"
            className="w-full resize-y max-h-72 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />
          <div className="flex flex-wrap justify-between items-center gap-2">
            <span
              className={`text-[11px] ${byteLength > NOTE_MAX_BYTES ? "text-rose-500" : "text-zinc-500"}`}
            >
              完整答复 {byteLength.toLocaleString()} /{" "}
              {NOTE_MAX_BYTES.toLocaleString()} 字节
            </span>
            <button
              className={`${button} bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 hover:bg-zinc-700 dark:hover:bg-zinc-200`}
              disabled={busy || !valid}
              onClick={() => void submit()}
            >
              <Send className="w-3 h-3" />
              {busy ? "保存中…" : "提交答复"}
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
                    ? "以上都不是"
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
                  ? "已附入工具响应"
                  : question.delivery === "pending"
                    ? "已保存，待附入工具响应"
                    : "答复记录已过期"}
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
                  复制答复
                </button>
                {question.delivery === "pending" && (
                  <button
                    className={button}
                    disabled={busy}
                    onClick={() => void withdraw()}
                  >
                    撤回答复
                  </button>
                )}
              </div>
            </div>
            {draft && (
              <div className="rounded-lg border border-amber-200 dark:border-amber-900 p-3 space-y-2">
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  此问题已有答复；你的未提交草稿仍保留，可以复制为补充消息。
                </p>
                <pre className="text-xs whitespace-pre-wrap break-words max-h-40 overflow-auto">
                  {composed || note}
                </pre>
                <div className="flex gap-2">
                  <button
                    className={button}
                    onClick={() => void copy(composed || note)}
                  >
                    复制草稿
                  </button>
                  <button className={button} onClick={() => onSent(draft.id)}>
                    丢弃草稿
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
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-xs text-zinc-500">
          {notice}
        </p>
      )}
    </article>
  );
}

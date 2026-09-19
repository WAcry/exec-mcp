import { useCallback, useEffect, useRef, useState } from "react";
import {
  Bell,
  BellOff,
  MessageSquare,
  Check,
  Copy,
  RefreshCw,
} from "lucide-react";
import { apiFetch } from "../lib/api";
import {
  useUserInput,
  USER_INPUT_OPEN,
  USER_INPUT_REFRESH,
} from "../context/UserInputContext";
import type {
  UserInputQuestion,
  UserInputRequest,
  UserInputList,
} from "../types";

export function answerPrompt(request: UserInputRequest): string {
  return (
    `以下是我对你先前问题的答复（请求 ${request.id}）：\n\n` +
    request.questions
      .filter((question) => question.answer)
      .map((question) => {
        const answer = question.answer!;
        return `问题：${question.title}\n我的选择：${answer.selected_option_label ?? "以上都不是／自定义回答"}\n补充说明：${answer.notes || "（无）"}\n答复事件：${answer.event_id}，版本 ${answer.revision}`;
      })
      .join("\n\n")
  );
}
function QuestionForm({
  request,
  question,
  onSaved,
  onDraftChange,
}: {
  request: UserInputRequest;
  question: UserInputQuestion;
  onSaved: () => void;
  onDraftChange: (dirty: boolean) => void;
}) {
  const [editing, setEditing] = useState(!question.answer);
  const [selected, setSelected] = useState<string | null | undefined>(
    question.answer
      ? question.answer.selected_option_id
      : question.options.length
        ? undefined
        : null,
  );
  const [notes, setNotes] = useState(question.answer?.notes ?? "");
  const [revision, setRevision] = useState(question.answer?.revision ?? 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const startEdit = () => {
    setSelected(
      question.answer
        ? question.answer.selected_option_id
        : question.options.length
          ? undefined
          : null,
    );
    setNotes(question.answer?.notes ?? "");
    setRevision(question.answer?.revision ?? 0);
    setError("");
    setEditing(true);
    setSubmitted(false);
    onDraftChange(false);
  };
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await apiFetch(`/api/user-input/${encodeURIComponent(request.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question_id: question.id,
          expected_revision: revision,
          selected_option_id: selected ?? null,
          notes,
        }),
      });
      setEditing(false);
      setSubmitted(true);
      onDraftChange(false);
      onSaved();
      window.dispatchEvent(new Event(USER_INPUT_REFRESH));
    } catch (error) {
      setError(error instanceof Error ? error.message : "保存失败，请重试。");
      // Refresh the saved revision while retaining this editor's choice and draft.
      onSaved();
    } finally {
      setBusy(false);
    }
  };
  const count = new TextEncoder().encode(notes).length;
  const answer = question.answer;
  return (
    <section className="space-y-3 border-t border-zinc-100 pt-4 dark:border-zinc-800">
      <h3 className="whitespace-pre-wrap break-words text-sm font-semibold">
        {question.title}
      </h3>
      {!editing ? (
        <div className="space-y-2 text-xs">
          <p className="text-emerald-700 dark:text-emerald-400">
            <Check className="mr-1 inline h-3.5 w-3.5" />
            {answer?.selected_option_label ??
              (answer ? "自定义回答" : "答复已保存")}
          </p>
          {answer?.notes && (
            <p className="whitespace-pre-wrap break-words rounded-lg bg-zinc-50 p-3 dark:bg-zinc-950">
              {answer.notes}
            </p>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2 text-zinc-500">
            <span>
              {answer?.delivery === "acknowledged"
                ? "Agent 已确认接收（不表示执行完成）"
                : answer?.delivery === "attempted"
                  ? "已尝试随工具响应投递，等待确认"
                  : "已保存，等待原 ChatGPT 对话继续调用工具"}
            </span>
            <button
              type="button"
              className="underline underline-offset-4"
              onClick={startEdit}
            >
              修改答复
            </button>
          </div>
        </div>
      ) : (
        <fieldset disabled={busy} className="space-y-3">
          <legend className="sr-only">{question.title}</legend>
          {!!question.options.length && (
            <div className="grid gap-2 sm:grid-cols-2">
              {question.options.map((option, index) => (
                <label
                  key={option.id}
                  className={`flex cursor-pointer items-start gap-2 rounded-lg border p-3 text-xs ${selected === option.id ? "border-zinc-700 bg-zinc-100 dark:border-zinc-300 dark:bg-zinc-800" : "border-zinc-200 dark:border-zinc-800"}`}
                >
                  <input
                    type="radio"
                    name={`${request.id}-${question.id}`}
                    value={option.id}
                    checked={selected === option.id}
                    onChange={() => {
                      setSelected(option.id);
                      onDraftChange(true);
                    }}
                    className="mt-0.5"
                  />
                  <span className="min-w-0 break-words">
                    {option.label}
                    {index === 0 && (
                      <span className="ml-2 text-[10px] text-zinc-500">
                        推荐
                      </span>
                    )}
                  </span>
                </label>
              ))}
              <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-zinc-200 p-3 text-xs dark:border-zinc-800">
                <input
                  type="radio"
                  name={`${request.id}-${question.id}`}
                  checked={selected === null}
                  onChange={() => {
                    setSelected(null);
                    onDraftChange(true);
                  }}
                />
                以上都不是，自定义回答
              </label>
            </div>
          )}
          <label className="block space-y-1.5 text-xs text-zinc-600 dark:text-zinc-400">
            <span>
              {selected === null || !question.options.length
                ? "你的回答"
                : "补充说明（可选，可与选项一起提交）"}
            </span>
            <textarea
              value={notes}
              onChange={(event) => {
                setNotes(event.target.value);
                onDraftChange(true);
              }}
              rows={3}
              className="w-full resize-y rounded-lg border border-zinc-200 bg-white p-3 text-zinc-900 focus:outline-2 focus:outline-zinc-400 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100"
            />
          </label>
          <div className="flex items-center justify-between gap-2">
            <span
              className={`text-[10px] ${count > 6000 ? "text-rose-600" : "text-zinc-400"}`}
            >
              {count} / 6000 字节
            </span>
            <div className="flex gap-3 text-xs">
              {answer && (
                <button
                  type="button"
                  onClick={() => {
                    setEditing(false);
                    onDraftChange(false);
                    onSaved();
                  }}
                >
                  取消修改
                </button>
              )}
              <button
                type="button"
                onClick={() => void save()}
                disabled={
                  busy ||
                  selected === undefined ||
                  (selected === null && !notes.trim()) ||
                  count > 6000
                }
                className="rounded-lg bg-zinc-900 px-3 py-2 font-semibold text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900"
              >
                {busy ? "保存中…" : "提交答复"}
              </button>
            </div>
          </div>
          {error && (
            <p role="alert" className="text-xs text-rose-600">
              {error}
              {answer && (
                <button
                  type="button"
                  onClick={startEdit}
                  className="ml-2 underline"
                >
                  载入已保存的新版本
                </button>
              )}
            </p>
          )}
        </fieldset>
      )}
      {submitted && (
        <span className="sr-only" role="status">
          答复已保存
        </span>
      )}
    </section>
  );
}
function RequestCard({
  request,
  onSaved,
  onDraftChange,
}: {
  request: UserInputRequest;
  onSaved: () => void;
  onDraftChange: (questionId: string, dirty: boolean) => void;
}) {
  const [copyState, setCopyState] = useState("");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(answerPrompt(request));
      setCopyState("已复制");
    } catch {
      setCopyState("复制不可用，请展开后手动复制");
    }
  };
  return (
    <article
      id={request.id}
      className="space-y-4 rounded-xl border border-zinc-200 bg-white p-4 shadow-xs dark:border-zinc-800 dark:bg-zinc-900/50"
    >
      <header className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="min-w-0">
          <span className="font-mono font-semibold">{request.request_key}</span>
          <p className="mt-1 break-all text-[10px] text-zinc-400">
            对话 {request.session_id} ·{" "}
            {new Date(request.created_at).toLocaleString()}
          </p>
        </div>
        <span
          className={
            request.status === "pending"
              ? "text-amber-700 dark:text-amber-400"
              : "text-zinc-500"
          }
        >
          {request.status === "pending" ? "待回答" : "已回答"}
        </span>
      </header>
      {request.questions.map((question) => (
        <QuestionForm
          key={question.id}
          request={request}
          question={question}
          onSaved={onSaved}
          onDraftChange={(dirty) => onDraftChange(question.id, dirty)}
        />
      ))}
      {request.questions.some((question) => question.answer) && (
        <div className="border-t border-zinc-100 pt-3 dark:border-zinc-800">
          <button
            type="button"
            onClick={() => void copy()}
            className="inline-flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400"
          >
            <Copy className="h-3.5 w-3.5" />
            {copyState || "复制答复到原 ChatGPT 对话"}
          </button>
          <details className="mt-2 text-xs text-zinc-500">
            <summary className="cursor-pointer">
              ChatGPT 已停止调用？展开并粘贴答复
            </summary>
            <pre className="mt-2 whitespace-pre-wrap break-words rounded bg-zinc-50 p-3 text-[11px] dark:bg-zinc-950">
              {answerPrompt(request)}
            </pre>
          </details>
        </div>
      )}
    </article>
  );
}
export function UserInputView() {
  const inbox = useUserInput();
  const [data, setData] = useState<UserInputList | null>(null);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("all");
  const [session, setSession] = useState("");
  const [error, setError] = useState("");
  const refreshVersion = useRef(0);
  const drafts = useRef(new Set<string>());
  const displayed = useRef<UserInputRequest[]>([]);
  const refresh = useCallback(async () => {
    const version = ++refreshVersion.current;
    try {
      const query = new URLSearchParams({
        page: String(page),
        status,
        sessionId: session,
      });
      const result = await apiFetch<UserInputList>(`/api/user-input?${query}`);
      if (version !== refreshVersion.current) return;
      // A concurrent answer can remove a card from the pending filter. Keep its
      // dirty editor mounted, with the latest saved revision, until save/cancel.
      const missingDrafts = displayed.current.filter(
        (request) =>
          !result.items.some((item) => item.id === request.id) &&
          [...drafts.current].some((id) => id.startsWith(`${request.id}/`)),
      );
      const retained = await Promise.all(
        missingDrafts.map((request) =>
          apiFetch<UserInputRequest>(
            `/api/user-input/${encodeURIComponent(request.id)}`,
          ).catch(() => request),
        ),
      );
      if (version !== refreshVersion.current) return;
      displayed.current = [...retained, ...result.items];
      setData({ ...result, items: displayed.current });
      setPage(result.page);
      setError("");
    } catch (error) {
      if (version === refreshVersion.current) setError(String(error));
    }
  }, [page, status, session]);
  useEffect(() => {
    void refresh();
    const listener = () => {
      void refresh();
    };
    window.addEventListener(USER_INPUT_REFRESH, listener);
    const open = () => {
      setPage(1);
      setStatus("pending");
      setSession("");
      void refresh();
    };
    window.addEventListener(USER_INPUT_OPEN, open);
    const timer = window.setInterval(listener, 15_000);
    return () => {
      refreshVersion.current++;
      window.removeEventListener(USER_INPUT_REFRESH, listener);
      window.removeEventListener(USER_INPUT_OPEN, open);
      window.clearInterval(timer);
    };
  }, [refresh]);
  return (
    <div className="space-y-4">
      <section className="space-y-3 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900/50">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 text-sm font-bold">
            <MessageSquare className="h-4 w-4" />
            异步问答{" "}
            <span className="text-xs font-normal text-zinc-500">
              {inbox.pending} 组待答
            </span>
          </h2>
          <div className="flex gap-3 text-xs">
            <button
              type="button"
              onClick={() => void inbox.setNotifications()}
              disabled={
                inbox.permission === "unsupported" ||
                inbox.permission === "denied"
              }
              className="inline-flex items-center gap-1.5 disabled:opacity-50"
            >
              {inbox.notify && inbox.permission === "granted" ? (
                <Bell className="h-3.5 w-3.5" />
              ) : (
                <BellOff className="h-3.5 w-3.5" />
              )}
              {inbox.permission === "denied"
                ? "系统通知已被浏览器拒绝"
                : inbox.permission === "unsupported"
                  ? "此地址仅支持页面提醒"
                  : inbox.permission === "granted" && inbox.notify
                    ? "关闭系统通知"
                    : "启用系统通知"}
            </button>
            <button
              type="button"
              onClick={() => void refresh()}
              className="inline-flex items-center gap-1.5"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              刷新
            </button>
          </div>
        </div>
        <p className="text-xs leading-relaxed text-zinc-500">
          提交后保存到本机，随后续 exec / wait 返回原对话；不会主动唤醒
          ChatGPT。系统通知需要浏览器授权且保持控制台页面打开。推荐项不会自动选中或提交。
        </p>
        <div className="flex flex-wrap gap-2">
          <select
            aria-label="问答状态"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
            className="rounded-lg border border-zinc-200 bg-transparent px-2 py-1.5 text-xs dark:border-zinc-700"
          >
            <option value="all">全部问题</option>
            <option value="pending">待回答</option>
            <option value="answered">已回答</option>
          </select>
          <input
            aria-label="按对话摘要筛选"
            placeholder="按对话摘要筛选"
            value={session}
            onChange={(e) => {
              setSession(e.target.value);
              setPage(1);
            }}
            className="min-w-0 flex-1 rounded-lg border border-zinc-200 bg-transparent px-3 py-1.5 text-xs dark:border-zinc-700"
          />
        </div>
      </section>
      {error && (
        <p role="alert" className="text-xs text-rose-600">
          {error}
        </p>
      )}
      {data && !data.enabled && (
        <p className="rounded-xl border border-zinc-200 p-5 text-xs text-zinc-500 dark:border-zinc-800">
          此实例尚未启用持久问答；请通过 CLI 启动并启用 Web UI。
        </p>
      )}
      {data?.enabled && data.items.length === 0 && (
        <p className="p-8 text-center text-xs text-zinc-400">
          此筛选下没有问题。Agent 提交异步问题后会出现在这里。
        </p>
      )}
      {data?.items.map((request) => (
        <RequestCard
          key={request.id}
          request={request}
          onSaved={() => {
            void refresh();
            void inbox.refresh();
          }}
          onDraftChange={(questionId, dirty) => {
            const id = `${request.id}/${questionId}`;
            if (dirty) drafts.current.add(id);
            else drafts.current.delete(id);
          }}
        />
      ))}
      {!!data?.total && (
        <div className="flex justify-center gap-4 text-xs text-zinc-500">
          <button
            disabled={page <= 1}
            onClick={() => setPage(page - 1)}
            className="disabled:opacity-30"
          >
            上一页
          </button>
          <span>
            {page} / {Math.ceil(data.total / data.pageSize)}
          </span>
          <button
            disabled={page * data.pageSize >= data.total}
            onClick={() => setPage(page + 1)}
            className="disabled:opacity-30"
          >
            下一页
          </button>
        </div>
      )}
    </div>
  );
}

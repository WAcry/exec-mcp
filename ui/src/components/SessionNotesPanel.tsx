import { useEffect, useRef, useState } from "react";
import { Copy, Send, X, Pencil, Check, MessageSquare } from "lucide-react";
import { apiFetch } from "../lib/api";
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
  // getRandomValues also works on HTTP LAN origins where randomUUID may be unavailable.
  return {
    id: [...crypto.getRandomValues(new Uint8Array(16))]
      .map((v) => v.toString(16).padStart(2, "0"))
      .join(""),
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
}: {
  sessionId: string;
  draft: NoteDraft | undefined;
  onDraft: (draft: NoteDraft) => void;
  onSent: (id: string) => void;
  onClose: () => void;
  onChange: () => void;
  revision: number;
}) {
  const [data, setData] = useState<SessionNotesPage | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
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
            ? "已保存，等待本对话的工具响应。"
            : saved.status === "attached"
              ? "该消息已附入工具响应。"
              : "该消息已撤回；再次发送请创建新消息。",
        );
      }
    } catch (e) {
      if (mounted.current)
        setError(`发送未确认：${String(e)}。草稿已保留；相同内容重试会去重。`);
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
      if (mounted.current) setNotice("已复制，可粘贴到原 ChatGPT 对话。");
    } catch {
      if (mounted.current) setError("复制失败，请手动选择消息文本。");
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
        aria-label="会话补充消息"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-xl h-full bg-white dark:bg-zinc-950 border-l border-zinc-200 dark:border-zinc-800 shadow-2xl flex flex-col text-zinc-900 dark:text-zinc-100"
      >
        <header className="px-5 py-4 border-b border-zinc-200 dark:border-zinc-800 space-y-2">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold flex items-center gap-2">
              <MessageSquare className="w-4 h-4" />
              会话补充消息
            </h2>
            <button
              className={actionClass}
              aria-label="关闭补充消息"
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
                {data?.label || "未设置备注名"}
              </span>
              <button
                className={actionClass}
                disabled={!data}
                onClick={() => setLabel(data?.label ?? "")}
              >
                <Pencil className="w-3 h-3" />
                备注名
              </button>
            </div>
          ) : (
            <div className="flex gap-2 items-center">
              <input
                aria-label="会话备注名"
                value={label}
                maxLength={256}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="只在本机显示，留空恢复哈希"
                className="min-w-0 flex-1 rounded-md border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1.5 text-xs"
              />
              <button
                className={actionClass}
                disabled={saving || bytes(label) > NOTE_LABEL_BYTES}
                onClick={() => void rename()}
                aria-label="保存备注名"
              >
                <Check className="w-3 h-3" />
              </button>
              <button
                className={actionClass}
                onClick={() => setLabel(null)}
                aria-label="取消编辑备注名"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          )}
          <p className="text-xs text-zinc-500">
            只发给此对话；随工具自然返回附带，不打断正在执行的命令。
          </p>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
          <div className="flex items-center justify-between text-xs text-zinc-500">
            <span>消息记录</span>
            <span>{data?.pendingCount ?? 0} 条待附带</span>
          </div>
          {!data ? (
            <p className="text-xs text-zinc-500">正在读取…</p>
          ) : data.items.length === 0 ? (
            <p className="text-xs text-zinc-500 py-10 text-center">
              补充上下文、约束或改变主意，直接写在这里。
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
                    {new Date(note.createdAt).toLocaleString()}
                  </span>
                  <span>
                    {note.status === "pending"
                      ? "待附带"
                      : note.status === "attached"
                        ? "已附入工具响应"
                        : "已撤回"}
                  </span>
                </div>
                <p className="text-sm whitespace-pre-wrap break-words max-h-64 overflow-auto">
                  {note.text}
                </p>
                {note.callId && (
                  <p className="text-[10px] font-mono text-zinc-500 break-all">
                    响应记录：{note.callId}
                  </p>
                )}
                <div className="flex gap-2">
                  <button
                    className={actionClass}
                    onClick={() => void copy(note.text)}
                  >
                    <Copy className="w-3 h-3" />
                    复制
                  </button>
                  {note.status === "pending" && (
                    <button
                      className={actionClass}
                      onClick={() => void withdraw(note.id)}
                    >
                      撤回
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
                较新
              </button>
              <span>
                {page} / {data.totalPages}
              </span>
              <button
                className={actionClass}
                disabled={page >= data.totalPages}
                onClick={() => setPage((v) => v + 1)}
              >
                更早
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
              {error}
            </p>
          )}
          {notice && (
            <p
              role="status"
              className="text-xs text-zinc-600 dark:text-zinc-400"
            >
              {notice}
            </p>
          )}
          <label htmlFor="note-body" className="text-xs font-medium">
            发送补充
          </label>
          <textarea
            ref={input}
            id="note-body"
            value={body}
            onChange={(e) => onDraft(newNoteDraft(e.target.value))}
            maxLength={NOTE_MAX_BYTES}
            disabled={sending}
            rows={4}
            placeholder="例如：先保留现有配置；测试完成后再修改默认值。"
            className="w-full resize-y max-h-60 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-zinc-500"
          />
          <div className="flex items-center justify-between">
            <span
              className={`text-[11px] font-mono ${bodyBytes > NOTE_MAX_BYTES ? "text-rose-500" : "text-zinc-500"}`}
            >
              {bodyBytes.toLocaleString()} / {NOTE_MAX_BYTES.toLocaleString()}{" "}
              UTF-8 字节
            </span>
            <button
              className={actionClass}
              disabled={
                !data || sending || !body.trim() || bodyBytes > NOTE_MAX_BYTES
              }
              onClick={() => void send()}
            >
              <Send className="w-3 h-3" />
              {sending ? "保存中…" : "发送补充"}
            </button>
          </div>
          <p className="text-[11px] leading-relaxed text-zinc-500">
            按顺序利用响应剩余额度，长消息可能继续排队；已附带不代表已读。临时保留
            72 小时，程序退出后丢失。可随时复制到原对话。
          </p>
        </footer>
      </section>
    </div>
  );
}

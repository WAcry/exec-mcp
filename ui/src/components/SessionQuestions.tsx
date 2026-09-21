import { useEffect, useRef, useState } from "react";
import { MessageCircleQuestion } from "lucide-react";
import { apiFetch } from "../lib/api";
import { QuestionCard, type AnswerDraft } from "./QuestionCard";
import type {
  UserQuestionsPage,
  UserQuestionView,
} from "../../../src/user-questions-types";

export function SessionQuestions({
  sessionId,
  drafts,
  onDraft,
  onSent,
  onChange,
  revision,
}: {
  sessionId: string;
  drafts: Record<string, AnswerDraft>;
  onDraft: (questionId: string, draft: AnswerDraft) => void;
  onSent: (questionId: string, draftId: string) => void;
  onChange: () => void;
  revision: number;
}) {
  const [data, setData] = useState<UserQuestionsPage | null>(null);
  const [page, setPage] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState("");
  const cached = useRef(new Map<string, UserQuestionView>());
  const currentDrafts = useRef(drafts);
  currentDrafts.current = drafts;
  useEffect(() => {
    let disposed = false;
    let controller: AbortController | undefined;
    const load = async () => {
      controller?.abort();
      controller = new AbortController();
      const request = controller;
      try {
        const value = await apiFetch<UserQuestionsPage>(
          `/api/sessions/${encodeURIComponent(sessionId)}/questions?page=${page}`,
          { signal: request.signal },
        );
        if (!disposed && !request.signal.aborted) {
          for (const [id] of cached.current)
            if (!currentDrafts.current[id]) cached.current.delete(id);
          for (const q of value.items) cached.current.set(q.id, q);
          setData(value);
          setError("");
          if (value.page !== page) setPage(value.page);
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
  }, [sessionId, page, refresh, revision]);
  const changed = () => {
    setRefresh((v) => v + 1);
    onChange();
  };
  const displayed = data
    ? [
        ...data.items,
        ...[...cached.current.values()].filter(
          (q) => drafts[q.id] && !data.items.some((item) => item.id === q.id),
        ),
      ]
    : [];
  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-4">
      <div className="text-xs text-zinc-500 flex flex-wrap items-center justify-between gap-2">
        <span>
          {data?.pendingCount ?? 0} 个待回答 · 共 {data?.total ?? 0} 个问题
        </span>
        <span>未答优先；每题独立提交，选择和补充一起发送</span>
      </div>
      {error && (
        <p role="alert" className="text-xs text-rose-600 break-words">
          {error}
        </p>
      )}
      {!data ? (
        <p className="text-xs text-zinc-500">正在读取…</p>
      ) : displayed.length === 0 ? (
        <div className="py-12 text-center text-zinc-500 space-y-3">
          <MessageCircleQuestion className="w-8 h-8 mx-auto text-zinc-400" />
          <p className="text-sm">本会话暂时没有问题</p>
          <p className="text-xs">
            Agent 提交的问题会显示在这里；也可主动发送补充消息。
          </p>
        </div>
      ) : (
        displayed.map((question) => (
          <QuestionCard
            key={question.id}
            question={question}
            sessionId={sessionId}
            draft={drafts[question.id]}
            onDraft={(draft) => onDraft(question.id, draft)}
            onSent={(id) => onSent(question.id, id)}
            onChange={changed}
          />
        ))
      )}
      {data && data.totalPages > 1 && (
        <div className="flex items-center justify-between text-xs">
          <button
            className="cursor-pointer disabled:opacity-40"
            disabled={page <= 1}
            onClick={() => setPage((v) => v - 1)}
          >
            上一页
          </button>
          <span>
            {page} / {data.totalPages}
          </span>
          <button
            className="cursor-pointer disabled:opacity-40"
            disabled={page >= data.totalPages}
            onClick={() => setPage((v) => v + 1)}
          >
            下一页
          </button>
        </div>
      )}
      <p className="text-[11px] text-zinc-500 leading-relaxed">
        答复作为用户补充随正常工具响应返回；已附带不代表已读。临时保留 72
        小时，程序退出后丢失。
      </p>
    </div>
  );
}

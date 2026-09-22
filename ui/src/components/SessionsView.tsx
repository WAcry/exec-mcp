import { useState, useEffect } from "react";
import type {
  SessionSummary,
  PaginatedResult,
  NativeSessionItem,
} from "../types";
import { apiFetch } from "../lib/api";
import {
  Layers,
  Search,
  ChevronLeft,
  ChevronRight,
  ArrowRight,
} from "lucide-react";

interface SessionsViewProps {
  sessionsData: PaginatedResult<SessionSummary> | null;
  onSelectSession: (sessionId: string) => void;
  onPageChange: (page: number) => void;
  onSearchChange: (search: string) => void;
  onMessageSession: (sessionId: string, tab?: "notes" | "questions") => void;
  pendingQuestionsOnly: boolean;
  onPendingQuestionsChange: (value: boolean) => void;
}

export function SessionsView({
  sessionsData,
  onSelectSession,
  onPageChange,
  onSearchChange,
  onMessageSession,
  pendingQuestionsOnly,
  onPendingQuestionsChange,
}: SessionsViewProps) {
  const [query, setQuery] = useState("");
  const [nativeMap, setNativeMap] = useState<Record<string, NativeSessionItem>>(
    {},
  );

  useEffect(() => {
    const refresh = () =>
      apiFetch<{ sessions: NativeSessionItem[] }>("/api/native-sessions")
        .then((res) => {
          const map: Record<string, NativeSessionItem> = {};
          for (const session of res.sessions) {
            if (session.scope) map[session.scope] = session;
          }
          setNativeMap(map);
        })
        .catch(() => {});
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, []);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    onSearchChange(query);
  };

  return (
    <div className="space-y-3.5">
      <div className="flex flex-wrap items-center justify-between gap-3 p-3 rounded-xl bg-white dark:bg-zinc-900/60 border border-zinc-200/80 dark:border-zinc-800/80 shadow-xs">
        <form onSubmit={handleSearch} className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400" />
          <input
            type="text"
            placeholder="搜索会话哈希、备注名或最近调用..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full pl-9 pr-3 py-1.5 text-xs bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-lg text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 focus:outline-none focus:border-zinc-400 dark:focus:border-zinc-600 focus:ring-1 focus:ring-zinc-400 dark:focus:ring-zinc-600 transition-colors"
          />
        </form>
        <label className="flex gap-2 items-center text-xs text-zinc-600 dark:text-zinc-400 cursor-pointer">
          <input
            type="checkbox"
            checked={pendingQuestionsOnly}
            onChange={(e) => onPendingQuestionsChange(e.target.checked)}
          />
          仅看待回答
        </label>
        <div className="text-xs text-zinc-500 font-mono whitespace-nowrap">
          共 {sessionsData?.total ?? 0} 个对话分组
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3.5">
        {!sessionsData || sessionsData.items.length === 0 ? (
          <div className="col-span-full p-12 text-center rounded-xl bg-white dark:bg-zinc-900/60 border border-zinc-200 dark:border-zinc-800 text-zinc-400 text-xs">
            {pendingQuestionsOnly ? (
              "没有待回答的问题。"
            ) : (
              <>
                暂未捕获到任何会话。当 ChatGPT 附带{" "}
                <code>_meta["openai/session"]</code>{" "}
                调用时，将按不可逆摘要归类建组。
              </>
            )}
          </div>
        ) : (
          sessionsData.items.map((session) => (
            <div
              key={session.id}
              data-session-id={session.id}
              onClick={() => onSelectSession(session.id)}
              className="p-4 rounded-xl bg-white dark:bg-zinc-900/50 border border-zinc-200/80 dark:border-zinc-800/80 shadow-xs hover:border-zinc-400 dark:hover:border-zinc-600 transition-all cursor-pointer flex flex-col justify-between group"
            >
              <div>
                <div className="flex items-start justify-between gap-2 mb-2.5">
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="p-1.5 rounded-lg bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 shrink-0">
                      <Layers className="w-3.5 h-3.5" />
                    </div>
                    <h3
                      className="font-mono text-xs font-bold text-zinc-900 dark:text-zinc-100 truncate"
                      title={session.label || session.id}
                    >
                      {session.label || session.id}
                    </h3>
                  </div>
                  <span className="text-[10px] text-zinc-500 whitespace-nowrap">
                    {(nativeMap[session.id]?.activeCellCount ?? 0) > 0
                      ? "有执行待收尾"
                      : "可继续使用"}
                  </span>
                </div>

                {session.label && (
                  <p
                    className="font-mono text-[10px] text-zinc-500 truncate mb-2"
                    title={session.id}
                  >
                    {session.id}
                  </p>
                )}

                {nativeMap[session.id] && !nativeMap[session.id]!.retired && (
                  <div className="mb-2.5 px-2 py-1 rounded-md bg-zinc-100 dark:bg-zinc-800/80 border border-zinc-200 dark:border-zinc-700/80 text-[11px] font-mono flex items-center justify-between text-zinc-700 dark:text-zinc-300">
                    <span className="flex items-center gap-1.5">
                      <span
                        className={`w-1.5 h-1.5 rounded-full ${
                          nativeMap[session.id]!.users > 0
                            ? "bg-emerald-500 animate-pulse"
                            : "bg-zinc-400"
                        }`}
                      />
                      <span>
                        原生会话:{" "}
                        {nativeMap[session.id]!.users > 0 ? "占用中" : "空闲"}
                      </span>
                    </span>
                    <span className="text-zinc-500 dark:text-zinc-400">
                      {nativeMap[session.id]!.activeCellCount} 个未收尾 cell
                    </span>
                  </div>
                )}

                <div className="space-y-1.5 mb-3 text-xs">
                  <div className="flex items-center justify-between text-zinc-500">
                    <span>当前保留调用</span>
                    <span className="font-mono font-semibold text-zinc-900 dark:text-zinc-100">
                      {session.callCount} 次
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-zinc-500">
                    <span>首次接入</span>
                    <span className="font-mono text-[11px]">
                      {new Date(session.firstSeen).toLocaleDateString("zh-CN")}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-zinc-500">
                    <span>最后活动</span>
                    <span className="font-mono text-[11px]">
                      {new Date(session.lastActive).toLocaleTimeString("zh-CN")}
                    </span>
                  </div>
                </div>

                {session.lastCall && (
                  <div className="p-2 rounded-lg bg-zinc-50 dark:bg-zinc-950 border border-zinc-100 dark:border-zinc-800/80 text-[11px] text-zinc-600 dark:text-zinc-400">
                    <div className="flex items-center justify-between text-[10px] text-zinc-400 mb-0.5">
                      <span className="font-mono font-medium">
                        {session.lastCall.tool}
                      </span>
                      <span>{session.lastCall.durationMs ?? 0}ms</span>
                    </div>
                    <p className="font-mono truncate">
                      {session.lastCall.preview}
                    </p>
                  </div>
                )}
                {!!session.pendingQuestions && (
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      onMessageSession(session.id, "questions");
                    }}
                    className="w-full mt-3 rounded-lg border border-indigo-200 dark:border-indigo-900 bg-indigo-50 dark:bg-indigo-950/30 p-3 text-left cursor-pointer"
                  >
                    <span className="block text-xs font-semibold text-indigo-700 dark:text-indigo-300">
                      回答 {session.pendingQuestions} 个问题 →
                    </span>
                    <span className="block truncate text-xs mt-1 text-zinc-600 dark:text-zinc-400">
                      {session.questionPreview}
                    </span>
                  </button>
                )}
              </div>

              <div className="mt-3 pt-2.5 border-t border-zinc-100 dark:border-zinc-800/80 flex items-center justify-between text-xs text-zinc-500 group-hover:text-zinc-900 dark:group-hover:text-zinc-100 font-medium">
                <span className="flex items-center gap-1">
                  查看会话调用流
                  <ArrowRight className="w-3.5 h-3.5" />
                </span>
                <button
                  disabled={!session.canMessage}
                  onClick={(e) => {
                    e.stopPropagation();
                    onMessageSession(session.id);
                  }}
                  title={
                    session.canMessage
                      ? "给此对话发送补充或设置备注名"
                      : "缺少可用的对话标识"
                  }
                  className="px-2 py-1.5 rounded-md border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                >
                  发送补充
                  {session.pendingNotes ? ` · ${session.pendingNotes}` : ""}
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {sessionsData && sessionsData.totalPages > 1 && (
        <div className="flex items-center justify-between px-3.5 py-2.5 rounded-xl bg-white dark:bg-zinc-900/60 border border-zinc-200 dark:border-zinc-800 text-xs text-zinc-500">
          <div>
            第 {sessionsData.page} / {sessionsData.totalPages} 页
          </div>
          <div className="flex items-center gap-1.5">
            <button
              disabled={sessionsData.page <= 1}
              onClick={() => onPageChange(sessionsData.page - 1)}
              className="p-1 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 disabled:opacity-40 disabled:pointer-events-none cursor-pointer"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>
            <button
              disabled={sessionsData.page >= sessionsData.totalPages}
              onClick={() => onPageChange(sessionsData.page + 1)}
              className="p-1 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 disabled:opacity-40 disabled:pointer-events-none cursor-pointer"
            >
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

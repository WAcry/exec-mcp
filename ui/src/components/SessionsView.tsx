import { useLocale } from "../context/LocaleContext";
import { useState, useEffect } from "react";
import type {
  SessionSummary,
  PaginatedResult,
  NativeSessionItem,
} from "../types";
import { apiFetch } from "../lib/api";
import { Search, ChevronLeft, ChevronRight, ArrowRight } from "lucide-react";

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
  const { t, locale } = useLocale();

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
      <div className="panel flex flex-wrap items-center justify-between gap-3 p-3">
        <form onSubmit={handleSearch} className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400" />
          <input
            type="text"
            placeholder={t("sessions.search")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full pl-9 pr-3 py-1.5 text-xs bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-md text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 focus:outline-none focus:border-zinc-400 dark:focus:border-zinc-600 focus:ring-1 focus:ring-zinc-400 dark:focus:ring-zinc-600 transition-colors"
          />
        </form>
        <label className="flex gap-2 items-center text-xs text-zinc-600 dark:text-zinc-400 cursor-pointer">
          <input
            type="checkbox"
            checked={pendingQuestionsOnly}
            onChange={(e) => onPendingQuestionsChange(e.target.checked)}
            className="accent-zinc-900 dark:accent-zinc-100"
          />
          {t("sessions.pendingOnly")}
        </label>
        <div className="text-xs text-zinc-500 tabular-nums whitespace-nowrap">
          {t("sessions.count", sessionsData?.total ?? 0)}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3.5">
        {!sessionsData || sessionsData.items.length === 0 ? (
          <div className="panel col-span-full p-12 text-center text-zinc-400 text-xs">
            {pendingQuestionsOnly ? (
              t("sessions.noPending")
            ) : (
              <>{t("sessions.empty")}</>
            )}
          </div>
        ) : (
          sessionsData.items.map((session) => (
            <div
              key={session.id}
              data-session-id={session.id}
              onClick={() => onSelectSession(session.id)}
              className="panel p-4 hover:border-zinc-300 dark:hover:border-zinc-700 transition-colors cursor-pointer flex flex-col justify-between group"
            >
              <div>
                <div className="flex items-baseline justify-between gap-2 mb-3">
                  <div className="min-w-0">
                    <h3
                      className={`truncate text-zinc-900 dark:text-zinc-100 ${
                        session.label
                          ? "text-sm font-medium"
                          : "font-mono text-xs font-medium"
                      }`}
                      title={session.label || session.id}
                    >
                      {session.label || session.id}
                    </h3>
                    {session.label && (
                      <p
                        className="font-mono text-[11px] text-zinc-500 truncate mt-0.5"
                        title={session.id}
                      >
                        {session.id}
                      </p>
                    )}
                  </div>
                  <span className="text-[11px] text-zinc-500 whitespace-nowrap">
                    {(nativeMap[session.id]?.activeCellCount ?? 0) > 0
                      ? t("sessions.unfinished")
                      : t("sessions.usable")}
                  </span>
                </div>

                <div className="space-y-1.5 mb-3 text-xs text-zinc-500">
                  {nativeMap[session.id] && !nativeMap[session.id]!.retired && (
                    <div className="flex items-center justify-between gap-2">
                      <span>
                        {t("sessions.native")}{" "}
                        {nativeMap[session.id]!.users > 0 ? (
                          <span className="font-medium text-zinc-900 dark:text-zinc-100">
                            {t("common.busy")}
                          </span>
                        ) : (
                          t("common.idle")
                        )}
                      </span>
                      <span className="tabular-nums">
                        {t(
                          "sessions.cells",
                          nativeMap[session.id]!.activeCellCount,
                        )}
                      </span>
                    </div>
                  )}
                  <div className="flex items-center justify-between">
                    <span>{t("stats.calls")}</span>
                    <span className="tabular-nums font-medium text-zinc-900 dark:text-zinc-100">
                      {session.callCount.toLocaleString(locale)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>{t("sessions.firstSeen")}</span>
                    <span className="tabular-nums">
                      {new Date(session.firstSeen).toLocaleDateString(locale)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>{t("sessions.lastActive")}</span>
                    <span className="tabular-nums">
                      {new Date(session.lastActive).toLocaleTimeString(locale)}
                    </span>
                  </div>
                </div>

                {session.lastCall && (
                  <div className="px-2.5 py-2 rounded-md bg-zinc-50 dark:bg-zinc-950 border border-zinc-100 dark:border-zinc-800 text-[11px] text-zinc-600 dark:text-zinc-400">
                    <div className="flex items-center justify-between text-zinc-400 mb-0.5">
                      <span className="font-mono">{session.lastCall.tool}</span>
                      <span className="tabular-nums">
                        {session.lastCall.durationMs ?? 0} ms
                      </span>
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
                    className="w-full mt-3 rounded-md border border-zinc-300 dark:border-zinc-700 px-3 py-2.5 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
                  >
                    <span className="block text-xs font-semibold text-zinc-900 dark:text-zinc-100">
                      {t("sessions.answer", session.pendingQuestions)}
                    </span>
                    <span className="block truncate text-xs mt-1 text-zinc-500 dark:text-zinc-400">
                      {session.questionPreview}
                    </span>
                  </button>
                )}
              </div>

              <div className="mt-3 pt-2.5 border-t border-zinc-100 dark:border-zinc-800 flex items-center justify-between text-xs text-zinc-500 group-hover:text-zinc-900 dark:group-hover:text-zinc-100 font-medium">
                <span className="flex items-center gap-1">
                  {t("sessions.viewCalls")}
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
                      ? t("sessions.sendTitle")
                      : t("sessions.noScope")
                  }
                  className="px-2 py-1.5 rounded-md border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors"
                >
                  {t("notes.send")}
                  {session.pendingNotes ? ` · ${session.pendingNotes}` : ""}
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {sessionsData && sessionsData.totalPages > 1 && (
        <div className="panel flex items-center justify-between px-3.5 py-2.5 text-xs text-zinc-500 tabular-nums">
          <div>
            {t("sessions.page", sessionsData.page, sessionsData.totalPages)}
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

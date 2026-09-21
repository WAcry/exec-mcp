import { useState, useEffect, useCallback } from "react";
import { Header } from "./components/Header";
import { StatsOverview } from "./components/StatsOverview";
import { MemoryWatermark } from "./components/MemoryWatermark";
import { CallsView } from "./components/CallsView";
import { SessionsView } from "./components/SessionsView";
import { TerminalsView } from "./components/TerminalsView";
import { McpView } from "./components/McpView";
import { SkillsView } from "./components/SkillsView";
import { ArtifactsView } from "./components/ArtifactsView";
import { ConfigView } from "./components/ConfigView";
import { AuthModal } from "./components/AuthModal";
import { useAuth } from "./context/AuthContext";
import { apiFetch } from "./lib/api";
import type { CallSummary, PaginatedResult, SessionPage } from "./types";
import type { AnswerDraft } from "./components/QuestionCard";
import { ManagementProvider, useManagement } from "./context/ManagementContext";
import { RuntimeControl } from "./components/RuntimeControl";
import {
  SessionNotesPanel,
  type NoteDraft,
} from "./components/SessionNotesPanel";

export function App() {
  return (
    <ManagementProvider>
      <ConsoleApp />
    </ManagementProvider>
  );
}
function ConsoleApp() {
  const management = useManagement();
  const { isAuthenticated, isVerifying, systemStatus, refreshStatus } =
    useAuth();
  const [activeTab, setActiveTab] = useState("calls");
  const [online, setOnline] = useState(false);
  const [notesTarget, setNotesTarget] = useState<string | null>(null);
  const [noteDrafts, setNoteDrafts] = useState<Record<string, NoteDraft>>({});
  const [notesRevision, setNotesRevision] = useState(0);
  const [notesTab, setNotesTab] = useState<"notes" | "questions">("notes");
  const [answerDrafts, setAnswerDrafts] = useState<
    Record<string, Record<string, AnswerDraft>>
  >({});
  const openConversation = (
    id: string,
    tab: "notes" | "questions" = "notes",
  ) => {
    setNotesTab(tab);
    setNotesTarget(id);
  };

  // Calls state
  const [callsPage, setCallsPage] = useState(1);
  const [callsFilters, setCallsFilters] = useState<{
    status?: string;
    tool?: string;
    search?: string;
    sessionId?: string;
  }>({});
  const [callsData, setCallsData] =
    useState<PaginatedResult<CallSummary> | null>(null);

  // Sessions state
  const [sessionsPage, setSessionsPage] = useState(1);
  const [sessionsSearch, setSessionsSearch] = useState("");
  const [pendingQuestionsOnly, setPendingQuestionsOnly] = useState(false);
  const [sessionsData, setSessionsData] = useState<SessionPage | null>(null);

  const fetchCalls = useCallback(async () => {
    if (!isAuthenticated) return;
    try {
      const params = new URLSearchParams();
      params.set("page", String(callsPage));
      params.set("pageSize", "20");
      if (callsFilters.status && callsFilters.status !== "all") {
        params.set("status", callsFilters.status);
      }
      if (callsFilters.tool && callsFilters.tool !== "all") {
        params.set("tool", callsFilters.tool);
      }
      if (callsFilters.search) {
        params.set("search", callsFilters.search);
      }
      if (callsFilters.sessionId) {
        params.set("sessionId", callsFilters.sessionId);
      }

      const res = await apiFetch<PaginatedResult<CallSummary>>(
        `/api/calls?${params.toString()}`,
      );
      setCallsData(res);
      if (res.page !== callsPage) setCallsPage(res.page);
      setOnline(true);
    } catch {
      setOnline(false);
    }
  }, [callsPage, callsFilters, isAuthenticated]);

  const fetchSessions = useCallback(async () => {
    if (!isAuthenticated) return;
    try {
      const params = new URLSearchParams();
      params.set("page", String(sessionsPage));
      params.set("pageSize", "18");
      if (pendingQuestionsOnly) params.set("pendingQuestions", "true");
      if (sessionsSearch) {
        params.set("search", sessionsSearch);
      }
      const res = await apiFetch<SessionPage>(
        `/api/sessions?${params.toString()}`,
      );
      setSessionsData(res);
      if (res.page !== sessionsPage) setSessionsPage(res.page);
    } catch {
      /* ignore */
    }
  }, [sessionsPage, sessionsSearch, pendingQuestionsOnly, isAuthenticated]);

  // Initial load & Polling fallback
  useEffect(() => {
    if (!isAuthenticated) return;
    const refresh = () => {
      void Promise.all([fetchCalls(), fetchSessions(), refreshStatus()]);
    };
    refresh();
    const timer = window.setInterval(refresh, 15_000);
    return () => window.clearInterval(timer);
  }, [fetchCalls, fetchSessions, isAuthenticated, refreshStatus]);

  // Real-time Server-Sent Events (SSE) Stream
  useEffect(() => {
    if (!isAuthenticated) return;

    let eventSource: EventSource | null = null;
    let refreshTimer: number | undefined;
    let reconnectTimer: number | undefined;
    let disposed = false;
    const scheduleRefresh = () => {
      if (refreshTimer !== undefined) return;
      refreshTimer = window.setTimeout(() => {
        refreshTimer = undefined;
        void Promise.all([fetchCalls(), fetchSessions(), refreshStatus()]);
      }, 150);
    };
    const connectEvents = () => {
      if (disposed) return;
      try {
        eventSource?.close();
        eventSource = new EventSource("/api/events");
        eventSource.onopen = () => setOnline(true);
        eventSource.onerror = () => {
          setOnline(false);
          eventSource?.close();
          eventSource = null;
          void refreshStatus();
          if (reconnectTimer === undefined)
            reconnectTimer = window.setTimeout(() => {
              reconnectTimer = undefined;
              connectEvents();
            }, 2000);
        };
        eventSource.onmessage = (e) => {
          try {
            const data = JSON.parse(e.data);
            if (data.type?.startsWith("call:") || data.type === "session:notes")
              scheduleRefresh();
            if (data.type === "session:notes") setNotesRevision((v) => v + 1);
          } catch {
            /* ignore ping */
          }
        };
      } catch {
        reconnectTimer = window.setTimeout(connectEvents, 2000);
      }
    };
    connectEvents();

    return () => {
      disposed = true;
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      eventSource?.close();
    };
  }, [isAuthenticated, fetchCalls, fetchSessions, refreshStatus]);

  useEffect(() => {
    if (isAuthenticated) return;
    setCallsData(null);
    setSessionsData(null);
    setNotesTarget(null);
    setNoteDrafts({});
    setAnswerDrafts({});
  }, [isAuthenticated]);

  const handleClearHistory = async () => {
    if (!confirm("确定清空调用审计吗？会话备注和补充消息保留。")) return;
    try {
      await apiFetch("/api/calls", { method: "DELETE" });
      setCallsPage(1);
      await Promise.all([fetchCalls(), fetchSessions(), refreshStatus()]);
    } catch (err) {
      alert("清空失败: " + String(err));
    }
  };

  const handleSelectSession = (sessionId?: string) => {
    setCallsFilters((prev) => ({
      ...prev,
      sessionId,
    }));
    setActiveTab("calls");
    setCallsPage(1);
  };

  if (isVerifying) {
    return (
      <div className="min-h-screen bg-zinc-50 dark:bg-[#09090b] flex items-center justify-center text-xs text-zinc-500">
        正在检查 Web UI 访问权限…
      </div>
    );
  }
  if (!isAuthenticated) return <AuthModal />;

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-[#09090b] text-zinc-900 dark:text-zinc-100 flex flex-col font-sans transition-colors duration-150">
      <Header
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        online={online}
      />

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-5">
        <RuntimeControl />
        {!!sessionsData?.pendingQuestionsTotal && (
          <button
            onClick={() => {
              setActiveTab("sessions");
              setPendingQuestionsOnly(true);
              setSessionsSearch("");
              setSessionsPage(1);
            }}
            className="w-full mb-3 rounded-xl border border-indigo-200 dark:border-indigo-900 bg-indigo-50 dark:bg-indigo-950/30 px-4 py-3 text-left text-sm text-indigo-700 dark:text-indigo-300 cursor-pointer"
          >
            {sessionsData.pendingQuestionsTotal} 个问题待回答
            <span className="ml-2 text-xs opacity-80">查看所属会话 →</span>
          </button>
        )}
        <MemoryWatermark memory={systemStatus?.memory} />

        {systemStatus?.stats && <StatsOverview stats={systemStatus.stats} />}

        {activeTab === "calls" && callsFilters.sessionId && (
          <div className="mb-3 flex items-center justify-between gap-2 text-xs">
            <span className="font-mono text-zinc-500 truncate">
              会话：
              {sessionsData?.items.find((s) => s.id === callsFilters.sessionId)
                ?.label || callsFilters.sessionId}
            </span>
            <button
              disabled={callsFilters.sessionId === "unscoped"}
              onClick={() => openConversation(callsFilters.sessionId!)}
              className="shrink-0 px-3 py-1.5 rounded-md border border-zinc-200 dark:border-zinc-700 disabled:opacity-40 cursor-pointer"
            >
              发送补充
            </button>
          </div>
        )}

        {activeTab === "calls" && (
          <CallsView
            callsData={callsData}
            onPageChange={setCallsPage}
            onFilterChange={(f) => {
              setCallsFilters(f);
              setCallsPage(1);
            }}
            onClearHistory={handleClearHistory}
            selectedSessionId={callsFilters.sessionId}
            onSelectSession={handleSelectSession}
          />
        )}

        {activeTab === "sessions" && (
          <SessionsView
            sessionsData={sessionsData}
            onMessageSession={openConversation}
            pendingQuestionsOnly={pendingQuestionsOnly}
            onPendingQuestionsChange={(value) => {
              setPendingQuestionsOnly(value);
              setSessionsPage(1);
            }}
            onSelectSession={handleSelectSession}
            onPageChange={setSessionsPage}
            onSearchChange={(q) => {
              setSessionsSearch(q);
              setSessionsPage(1);
            }}
          />
        )}

        {activeTab === "terminals" && <TerminalsView />}
        {activeTab === "mcp" && <McpView key={management.data?.generation} />}

        {activeTab === "skills" && (
          <SkillsView key={management.data?.generation} />
        )}

        {activeTab === "artifacts" && <ArtifactsView />}

        {activeTab === "config" && (
          <ConfigView key={management.data?.generation} />
        )}
      </main>

      {notesTarget && (
        <SessionNotesPanel
          key={notesTarget}
          sessionId={notesTarget}
          draft={noteDrafts[notesTarget]}
          revision={notesRevision}
          initialTab={notesTab}
          answerDrafts={answerDrafts[notesTarget] ?? {}}
          onAnswerDraft={(questionId, draft) =>
            setAnswerDrafts((previous) => ({
              ...previous,
              [notesTarget]: { ...previous[notesTarget], [questionId]: draft },
            }))
          }
          onAnswerSent={(questionId, id) =>
            setAnswerDrafts((previous) => {
              if (previous[notesTarget]?.[questionId]?.id !== id)
                return previous;
              const next = { ...previous[notesTarget] };
              delete next[questionId];
              return { ...previous, [notesTarget]: next };
            })
          }
          onClose={() => setNotesTarget(null)}
          onChange={() => {
            void fetchSessions();
          }}
          onDraft={(draft) =>
            setNoteDrafts((previous) => ({ ...previous, [notesTarget]: draft }))
          }
          onSent={(id) =>
            setNoteDrafts((previous) => {
              if (previous[notesTarget]?.id !== id) return previous;
              const next = { ...previous };
              delete next[notesTarget];
              return next;
            })
          }
        />
      )}

      <footer className="border-t border-zinc-200/80 dark:border-zinc-800/80 py-5 text-center text-xs text-zinc-400 dark:text-zinc-500">
        <p>EXEC MCP • 本机工具代码执行与审计控制台</p>
      </footer>
    </div>
  );
}

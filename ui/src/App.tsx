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
import { CallRecord, PaginatedResult, SessionSummary } from "./types";

export function App() {
  const { isAuthenticated, isVerifying, systemStatus, refreshStatus } =
    useAuth();
  const [activeTab, setActiveTab] = useState("calls");
  const [online, setOnline] = useState(true);

  // Calls state
  const [callsPage, setCallsPage] = useState(1);
  const [callsFilters, setCallsFilters] = useState<{
    status?: string;
    tool?: string;
    search?: string;
    sessionId?: string;
  }>({});
  const [callsData, setCallsData] =
    useState<PaginatedResult<CallRecord> | null>(null);

  // Sessions state
  const [sessionsPage, setSessionsPage] = useState(1);
  const [sessionsSearch, setSessionsSearch] = useState("");
  const [sessionsData, setSessionsData] =
    useState<PaginatedResult<SessionSummary> | null>(null);

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

      const res = await apiFetch<PaginatedResult<CallRecord>>(
        `/api/calls?${params.toString()}`,
      );
      setCallsData(res);
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
      if (sessionsSearch) {
        params.set("search", sessionsSearch);
      }
      const res = await apiFetch<PaginatedResult<SessionSummary>>(
        `/api/sessions?${params.toString()}`,
      );
      setSessionsData(res);
    } catch {
      /* ignore */
    }
  }, [sessionsPage, sessionsSearch, isAuthenticated]);

  // Initial load & Polling fallback
  useEffect(() => {
    fetchCalls();
    fetchSessions();
  }, [fetchCalls, fetchSessions]);

  // Real-time Server-Sent Events (SSE) Stream
  useEffect(() => {
    if (!isAuthenticated) return;

    let eventSource: EventSource | null = null;
    try {
      eventSource = new EventSource("/api/events");
      eventSource.onopen = () => setOnline(true);
      eventSource.onerror = () => setOnline(false);
      eventSource.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          if (data.type?.startsWith("call:")) {
            fetchCalls();
            fetchSessions();
            refreshStatus();
          }
        } catch {
          /* ignore ping */
        }
      };
    } catch {
      /* ignore */
    }

    return () => {
      eventSource?.close();
    };
  }, [isAuthenticated, fetchCalls, fetchSessions, refreshStatus]);

  const handleClearHistory = async () => {
    if (!confirm("确定要清空所有调用审计流和会话记录吗？")) return;
    try {
      await apiFetch("/api/calls", { method: "DELETE" });
      fetchCalls();
      fetchSessions();
      refreshStatus();
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

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-[#09090b] text-zinc-900 dark:text-zinc-100 flex flex-col font-sans transition-colors duration-150">
      {!isAuthenticated && !isVerifying && <AuthModal />}

      <Header
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        online={online}
      />

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-5">
        <MemoryWatermark memory={systemStatus?.memory} />

        {systemStatus?.stats && <StatsOverview stats={systemStatus.stats} />}

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
            onSelectSession={handleSelectSession}
            onPageChange={setSessionsPage}
            onSearchChange={(q) => {
              setSessionsSearch(q);
              setSessionsPage(1);
            }}
          />
        )}

        {activeTab === "terminals" && <TerminalsView />}

        {activeTab === "mcp" && <McpView />}

        {activeTab === "skills" && <SkillsView />}

        {activeTab === "artifacts" && <ArtifactsView />}

        {activeTab === "config" && <ConfigView />}
      </main>

      <footer className="border-t border-zinc-200/80 dark:border-zinc-800/80 py-5 text-center text-xs text-zinc-400 dark:text-zinc-500">
        <p>EXEC MCP • 本机工具代码执行与审计控制台</p>
      </footer>
    </div>
  );
}

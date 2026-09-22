import { useLocale } from "../context/LocaleContext";
import { useState, useEffect } from "react";
import {
  TerminalSessionItem,
  NativeSessionItem,
  CodeModeMemoryStatus,
} from "../types";
import { apiFetch } from "../lib/api";
import type { Translate } from "../lib/locale";
import {
  Terminal,
  Clock,
  Eye,
  RefreshCw,
  Cpu,
  Layers,
  AlertTriangle,
  AlertCircle,
} from "lucide-react";

export function TerminalsView() {
  const { t, locale } = useLocale();

  const [viewMode, setViewMode] = useState<"terminals" | "native-sessions">(
    "terminals",
  );
  const [terminals, setTerminals] = useState<TerminalSessionItem[]>([]);
  const [nativeSessions, setNativeSessions] = useState<NativeSessionItem[]>([]);
  const [memoryStatus, setMemoryStatus] = useState<CodeModeMemoryStatus | null>(
    null,
  );
  const [loading, setLoading] = useState(true);

  const fetchData = async () => {
    try {
      const [termRes, nativeRes] = await Promise.all([
        apiFetch<{ sessions: TerminalSessionItem[] }>("/api/terminals"),
        apiFetch<{
          sessions: NativeSessionItem[];
          memory: CodeModeMemoryStatus;
        }>("/api/native-sessions"),
      ]);
      setTerminals(termRes.sessions);
      setNativeSessions(nativeRes.sessions);
      setMemoryStatus(nativeRes.memory);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    const timer = setInterval(fetchData, 3000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="space-y-3.5">
      {/* Top Header & Tab Switcher */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 p-3.5 rounded-xl bg-white dark:bg-zinc-900/60 border border-zinc-200/80 dark:border-zinc-800/80 shadow-xs">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-xs font-bold text-zinc-900 dark:text-zinc-100 flex items-center gap-1.5">
              <Terminal className="w-3.5 h-3.5 text-zinc-400" />
              {t("terminals.title")}
            </h2>
            <div className="flex items-center p-0.5 rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 text-xs">
              <button
                onClick={() => setViewMode("terminals")}
                className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors cursor-pointer ${
                  viewMode === "terminals"
                    ? "bg-white dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100 shadow-xs font-semibold"
                    : "text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
                }`}
              >
                {t("terminals.processes", terminals.length)}
              </button>
              <button
                onClick={() => setViewMode("native-sessions")}
                className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors cursor-pointer ${
                  viewMode === "native-sessions"
                    ? "bg-white dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100 shadow-xs font-semibold"
                    : "text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
                }`}
              >
                {t("terminals.sessions", nativeSessions.length)}
              </button>
            </div>
          </div>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
            {viewMode === "terminals"
              ? t("terminals.help")
              : t("terminals.nativeHelp")}
          </p>
        </div>

        <button
          onClick={fetchData}
          className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs bg-zinc-50 dark:bg-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-300 transition-colors cursor-pointer shrink-0"
        >
          <RefreshCw
            className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`}
          />
          {t("common.refresh")}
        </button>
      </div>

      {/* Terminal Processes View */}
      {viewMode === "terminals" && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3.5">
          {terminals.length === 0 ? (
            <div className="col-span-full p-12 text-center rounded-xl bg-white dark:bg-zinc-900/60 border border-zinc-200 dark:border-zinc-800 text-zinc-400 text-xs">
              {t("terminals.empty")}
            </div>
          ) : (
            terminals.map((s) => {
              const bufferKb = Math.round(s.bufferBytes / 1024);
              const capacityKb = Math.round(s.bufferCapacityBytes / 1024);
              const bufferPct = Math.min(
                100,
                Math.round(
                  (s.bufferBytes / Math.max(1, s.bufferCapacityBytes)) * 100,
                ),
              );
              const omittedMb = (s.omittedBytes / (1024 * 1024)).toFixed(1);

              return (
                <div
                  key={s.id}
                  className="p-4 rounded-xl bg-white dark:bg-zinc-900/50 border border-zinc-200/80 dark:border-zinc-800/80 shadow-xs space-y-3 flex flex-col justify-between"
                >
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <span
                        className="font-mono text-xs font-bold text-zinc-900 dark:text-zinc-100 truncate max-w-[200px]"
                        title={s.id}
                      >
                        {s.id}
                      </span>
                      <span className="text-[10px] font-mono uppercase px-1.5 py-0.2 rounded font-semibold bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 border border-zinc-200 dark:border-zinc-700">
                        {s.kind}
                      </span>
                    </div>

                    <div className="space-y-1 text-xs text-zinc-500 font-mono mb-3">
                      <div className="flex items-center justify-between">
                        <span className="flex items-center gap-1 text-zinc-400">
                          <Cpu className="w-3 h-3" /> PID
                        </span>
                        <span>{s.pid ?? t("common.unknown")}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="flex items-center gap-1 text-zinc-400">
                          <Eye className="w-3 h-3" />
                          {t("terminals.observers")}
                        </span>
                        <span>{s.observers.toLocaleString(locale)}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="flex items-center gap-1 text-zinc-400">
                          <Clock className="w-3 h-3" />
                          {t("terminals.touched")}
                        </span>
                        <span>
                          {new Date(s.touched).toLocaleTimeString(locale)}
                        </span>
                      </div>
                    </div>

                    {/* Buffer Usage Bar */}
                    <div className="p-2.5 rounded-lg bg-zinc-50 dark:bg-zinc-950/70 border border-zinc-100 dark:border-zinc-800 space-y-1.5">
                      <div className="flex items-center justify-between text-[11px] font-mono">
                        <span className="text-zinc-500">
                          {t("terminals.buffer")}
                        </span>
                        <span className="font-semibold text-zinc-800 dark:text-zinc-200">
                          {bufferKb} KiB / {capacityKb} KiB ({bufferPct}%)
                        </span>
                      </div>
                      <div className="w-full h-1.5 bg-zinc-200 dark:bg-zinc-800 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all duration-300 ${
                            bufferPct > 90
                              ? "bg-amber-500"
                              : "bg-zinc-600 dark:bg-zinc-400"
                          }`}
                          style={{ width: `${bufferPct}%` }}
                        />
                      </div>
                      {s.omittedBytes > 0 && (
                        <div className="text-[10px] text-amber-600 dark:text-amber-400 flex items-center gap-1 mt-1">
                          <AlertTriangle className="w-3 h-3 shrink-0" />
                          <span>{t("terminals.omitted", omittedMb)}</span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Lifecycle Footer */}
                  <div className="pt-2 border-t border-zinc-100 dark:border-zinc-800/80 text-[11px] text-zinc-500">
                    {s.exitCode === undefined ? (
                      <div className="flex items-center justify-between">
                        <span className="text-zinc-400">
                          {t("terminals.state")}
                        </span>
                        <span className="text-emerald-600 dark:text-emerald-400 font-medium flex items-center gap-1">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                          {t("terminals.running")}
                        </span>
                      </div>
                    ) : (
                      <div className="space-y-1">
                        <div className="flex items-center justify-between">
                          <span className="text-zinc-400">
                            {t("terminals.exitCode")}
                          </span>
                          <span className="font-mono font-semibold text-zinc-700 dark:text-zinc-300">
                            code: {s.exitCode}
                          </span>
                        </div>
                        <p className="text-[10px] text-zinc-400 dark:text-zinc-500 leading-tight">
                          {t("terminals.expiry")}
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      {/* Code Mode Native Sessions View */}
      {viewMode === "native-sessions" && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3.5">
          {nativeSessions.length === 0 ? (
            <div className="col-span-full p-12 text-center rounded-xl bg-white dark:bg-zinc-900/60 border border-zinc-200 dark:border-zinc-800 text-zinc-400 text-xs">
              {t("terminals.noNative")}
            </div>
          ) : (
            nativeSessions.map((s) => {
              const isIdle = s.users === 0;
              const isBusy = s.users > 0;
              const idleHours = memoryStatus?.idleRetentionHours ?? 72;

              return (
                <div
                  key={s.id}
                  className="p-4 rounded-xl bg-white dark:bg-zinc-900/50 border border-zinc-200/80 dark:border-zinc-800/80 shadow-xs space-y-3 flex flex-col justify-between"
                >
                  <div>
                    {/* Header: Scope & Status Badge */}
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 text-zinc-400 text-[10px] font-mono">
                          <Layers className="w-3 h-3" />
                          <span>{t("terminals.scope")}</span>
                        </div>
                        <h3
                          className="font-mono text-xs font-bold text-zinc-900 dark:text-zinc-100 truncate mt-0.5"
                          title={s.scope ?? t("terminals.unscoped")}
                        >
                          {s.scope ?? t("terminals.unscoped")}
                        </h3>
                      </div>

                      {s.retired ? (
                        <span className="text-[10px] font-semibold text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/50 border border-rose-200 dark:border-rose-900 px-1.5 py-0.2 rounded shrink-0">
                          {t("terminals.retired")}
                        </span>
                      ) : isBusy ? (
                        <span className="text-[10px] font-medium text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/60 border border-emerald-200 dark:border-emerald-800 px-1.5 py-0.2 rounded shrink-0 flex items-center gap-1">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                          {t("common.busy")}
                        </span>
                      ) : (
                        <span className="text-[10px] font-medium text-zinc-600 dark:text-zinc-400 bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 px-1.5 py-0.2 rounded shrink-0">
                          {t("common.idle")}
                        </span>
                      )}
                    </div>

                    {/* Metadata breakdown */}
                    <div className="space-y-1.5 text-xs text-zinc-500 font-mono mb-3">
                      <div className="flex items-center justify-between">
                        <span className="text-zinc-400">
                          {t("terminals.cells")}
                        </span>
                        <span className="font-semibold text-zinc-800 dark:text-zinc-200">
                          {s.activeCellCount.toLocaleString(locale)}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-zinc-400">
                          {t("terminals.users")}
                        </span>
                        <span>{s.users.toLocaleString(locale)}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-zinc-400">
                          {isIdle
                            ? t("terminals.idleTime")
                            : t("terminals.lastUsed")}
                        </span>
                        <span>
                          {isIdle
                            ? formatDuration(Date.now() - s.idleSince, t)
                            : Date.now() - s.lastUsed < 1000
                              ? t("duration.now")
                              : formatDuration(Date.now() - s.lastUsed, t) +
                                t("terminals.ago")}
                        </span>
                      </div>
                    </div>

                    {/* Cell IDs if any */}
                    {s.activeCellIds.length > 0 && (
                      <div className="p-2 rounded-lg bg-zinc-50 dark:bg-zinc-950/70 border border-zinc-100 dark:border-zinc-800 mb-2">
                        <span className="text-[10px] text-zinc-400 block mb-1">
                          {t("terminals.cellIds")}
                        </span>
                        <div className="flex flex-wrap gap-1">
                          {s.activeCellIds.map((cid) => (
                            <span
                              key={cid}
                              className="px-1.5 py-0.2 rounded text-[10px] font-mono bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300"
                            >
                              {cid}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Reclaim Prediction Hint */}
                  <div className="pt-2 border-t border-zinc-100 dark:border-zinc-800/80 text-[11px] text-zinc-500 leading-tight">
                    {s.retired === "memory" ? (
                      <span className="text-rose-600 dark:text-rose-400 flex items-start gap-1">
                        <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                        <span>{t("terminals.memoryRetired")}</span>
                      </span>
                    ) : s.retired ? (
                      <span className="text-zinc-400">
                        {t("terminals.finished")}
                      </span>
                    ) : isIdle ? (
                      s.isOldestIdle ? (
                        <span className="text-amber-700 dark:text-amber-400 flex items-start gap-1 font-sans">
                          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                          <span>{t("terminals.oldestIdle")}</span>
                        </span>
                      ) : (
                        <span className="text-zinc-500 font-sans">
                          {t("terminals.idlePolicy", idleHours)}
                        </span>
                      )
                    ) : s.isOldestActive ? (
                      <span className="text-zinc-600 dark:text-zinc-400 font-sans">
                        {t("terminals.oldestActive")}
                      </span>
                    ) : (
                      <span className="text-zinc-500 font-sans">
                        {t("terminals.activePolicy")}
                      </span>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

function formatDuration(ms: number, t: Translate): string {
  if (ms < 1000) return t("duration.now");
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return t("duration.seconds", seconds);
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t("duration.minutes", minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("duration.hours", hours);
  const days = Math.floor(hours / 24);
  return t("duration.days", days);
}

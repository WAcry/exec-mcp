import { useLocale } from "../context/LocaleContext";
import { useState, useEffect } from "react";
import {
  TerminalSessionItem,
  NativeSessionItem,
  CodeModeMemoryStatus,
} from "../types";
import { apiFetch } from "../lib/api";
import type { Translate } from "../lib/locale";
import { RefreshCw, AlertTriangle, AlertCircle } from "lucide-react";

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

  const segment = (active: boolean) =>
    `px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors cursor-pointer tabular-nums ${
      active
        ? "bg-white dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100 shadow-xs"
        : "text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
    }`;

  return (
    <div className="space-y-3.5">
      <div className="panel flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 p-4">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
              {t("terminals.title")}
            </h2>
            <div className="flex items-center p-0.5 rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 text-xs">
              <button
                onClick={() => setViewMode("terminals")}
                className={segment(viewMode === "terminals")}
              >
                {t("terminals.processes", terminals.length)}
              </button>
              <button
                onClick={() => setViewMode("native-sessions")}
                className={segment(viewMode === "native-sessions")}
              >
                {t("terminals.sessions", nativeSessions.length)}
              </button>
            </div>
          </div>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1.5">
            {viewMode === "terminals"
              ? t("terminals.help")
              : t("terminals.nativeHelp")}
          </p>
        </div>

        <button
          onClick={fetchData}
          className="flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs bg-zinc-50 dark:bg-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-300 transition-colors cursor-pointer shrink-0"
        >
          <RefreshCw
            className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`}
          />
          {t("common.refresh")}
        </button>
      </div>

      {viewMode === "terminals" && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3.5">
          {terminals.length === 0 ? (
            <div className="panel col-span-full p-12 text-center text-zinc-400 text-xs">
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
                  className="panel p-4 flex flex-col justify-between gap-3"
                >
                  <div>
                    <div className="flex items-baseline justify-between gap-2 mb-3">
                      <span
                        className="font-mono text-xs font-medium text-zinc-900 dark:text-zinc-100 truncate"
                        title={s.id}
                      >
                        {s.id}
                      </span>
                      <span className="font-mono text-[11px] text-zinc-500 shrink-0">
                        {s.kind}
                      </span>
                    </div>

                    <div className="space-y-1 text-xs text-zinc-500 mb-3">
                      <div className="flex items-center justify-between">
                        <span>PID</span>
                        <span className="tabular-nums text-zinc-700 dark:text-zinc-300">
                          {s.pid ?? t("common.unknown")}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span>{t("terminals.observers")}</span>
                        <span className="tabular-nums text-zinc-700 dark:text-zinc-300">
                          {s.observers.toLocaleString(locale)}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span>{t("terminals.touched")}</span>
                        <span className="tabular-nums text-zinc-700 dark:text-zinc-300">
                          {new Date(s.touched).toLocaleTimeString(locale)}
                        </span>
                      </div>
                    </div>

                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="text-zinc-500">
                          {t("terminals.buffer")}
                        </span>
                        <span className="tabular-nums text-zinc-700 dark:text-zinc-300">
                          {bufferKb} KiB / {capacityKb} KiB ({bufferPct}%)
                        </span>
                      </div>
                      <div className="w-full h-1.5 bg-zinc-100 dark:bg-zinc-800 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full ${
                            bufferPct > 90
                              ? "bg-amber-500"
                              : "bg-zinc-500 dark:bg-zinc-400"
                          }`}
                          style={{ width: `${bufferPct}%` }}
                        />
                      </div>
                      {s.omittedBytes > 0 && (
                        <div className="text-[11px] text-amber-700 dark:text-amber-400 flex items-center gap-1">
                          <AlertTriangle className="w-3 h-3 shrink-0" />
                          <span>{t("terminals.omitted", omittedMb)}</span>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="pt-2.5 border-t border-zinc-100 dark:border-zinc-800 text-[11px] text-zinc-500">
                    {s.exitCode === undefined ? (
                      <div className="flex items-center justify-between">
                        <span>{t("terminals.state")}</span>
                        <span className="font-medium text-zinc-900 dark:text-zinc-100">
                          {t("terminals.running")}
                        </span>
                      </div>
                    ) : (
                      <div className="space-y-1">
                        <div className="flex items-center justify-between">
                          <span>{t("terminals.exitCode")}</span>
                          <span className="font-mono font-medium text-zinc-700 dark:text-zinc-300">
                            code: {s.exitCode}
                          </span>
                        </div>
                        <p className="text-zinc-400 dark:text-zinc-500 leading-snug">
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

      {viewMode === "native-sessions" && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3.5">
          {nativeSessions.length === 0 ? (
            <div className="panel col-span-full p-12 text-center text-zinc-400 text-xs">
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
                  className="panel p-4 flex flex-col justify-between gap-3"
                >
                  <div>
                    <div className="flex items-start justify-between gap-2 mb-3">
                      <div className="min-w-0">
                        <div className="text-[11px] text-zinc-500">
                          {t("terminals.scope")}
                        </div>
                        <h3
                          className={`text-xs font-medium text-zinc-900 dark:text-zinc-100 truncate mt-0.5 ${s.scope ? "font-mono" : ""}`}
                          title={s.scope ?? t("terminals.unscoped")}
                        >
                          {s.scope ?? t("terminals.unscoped")}
                        </h3>
                      </div>

                      <span
                        className={`text-[11px] shrink-0 ${
                          !s.retired && isBusy
                            ? "font-medium text-zinc-900 dark:text-zinc-100"
                            : "text-zinc-500"
                        }`}
                      >
                        {s.retired
                          ? t("terminals.retired")
                          : isBusy
                            ? t("common.busy")
                            : t("common.idle")}
                      </span>
                    </div>

                    <div className="space-y-1.5 text-xs text-zinc-500 mb-3">
                      <div className="flex items-center justify-between">
                        <span>{t("terminals.cells")}</span>
                        <span className="tabular-nums font-medium text-zinc-900 dark:text-zinc-100">
                          {s.activeCellCount.toLocaleString(locale)}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span>{t("terminals.users")}</span>
                        <span className="tabular-nums text-zinc-700 dark:text-zinc-300">
                          {s.users.toLocaleString(locale)}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span>
                          {isIdle
                            ? t("terminals.idleTime")
                            : t("terminals.lastUsed")}
                        </span>
                        <span className="tabular-nums text-zinc-700 dark:text-zinc-300">
                          {isIdle
                            ? formatDuration(Date.now() - s.idleSince, t)
                            : Date.now() - s.lastUsed < 1000
                              ? t("duration.now")
                              : formatDuration(Date.now() - s.lastUsed, t) +
                                t("terminals.ago")}
                        </span>
                      </div>
                    </div>

                    {s.activeCellIds.length > 0 && (
                      <div>
                        <span className="text-[11px] text-zinc-500 block mb-1">
                          {t("terminals.cellIds")}
                        </span>
                        <div className="flex flex-wrap gap-1">
                          {s.activeCellIds.map((cid) => (
                            <span
                              key={cid}
                              className="px-1.5 rounded text-[11px] font-mono bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300"
                            >
                              {cid}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="pt-2.5 border-t border-zinc-100 dark:border-zinc-800 text-[11px] text-zinc-500 leading-snug">
                    {s.retired === "memory" ? (
                      <span className="text-rose-600 dark:text-rose-400 flex items-start gap-1">
                        <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                        <span>{t("terminals.memoryRetired")}</span>
                      </span>
                    ) : s.retired ? (
                      <span className="text-zinc-400">
                        {t("terminals.finished")}
                      </span>
                    ) : isIdle ? (
                      s.isOldestIdle ? (
                        <span className="text-amber-700 dark:text-amber-400 flex items-start gap-1">
                          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                          <span>{t("terminals.oldestIdle")}</span>
                        </span>
                      ) : (
                        <span>{t("terminals.idlePolicy", idleHours)}</span>
                      )
                    ) : s.isOldestActive ? (
                      <span className="text-zinc-600 dark:text-zinc-400">
                        {t("terminals.oldestActive")}
                      </span>
                    ) : (
                      <span>{t("terminals.activePolicy")}</span>
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

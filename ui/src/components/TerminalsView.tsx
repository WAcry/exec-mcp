import { useState, useEffect } from "react";
import {
  TerminalSessionItem,
  NativeSessionItem,
  CodeModeMemoryStatus,
} from "../types";
import { apiFetch } from "../lib/api";
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
              执行进程与原生会话
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
                活动终端进程 ({terminals.length})
              </button>
              <button
                onClick={() => setViewMode("native-sessions")}
                className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors cursor-pointer ${
                  viewMode === "native-sessions"
                    ? "bg-white dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100 shadow-xs font-semibold"
                    : "text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
                }`}
              >
                原生执行会话 ({nativeSessions.length})
              </button>
            </div>
          </div>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
            {viewMode === "terminals"
              ? "由 tools.exec_command 启动的命令进程；每个进程独立保留有界滚动日志，已退出进程超期自动释放。"
              : "Code Mode 共享宿主内的原生执行会话与 store；按 FIFO 管理内存压力与 72 小时空闲回收。"}
          </p>
        </div>

        <button
          onClick={fetchData}
          className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs bg-zinc-50 dark:bg-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-300 transition-colors cursor-pointer shrink-0"
        >
          <RefreshCw
            className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`}
          />
          刷新
        </button>
      </div>

      {/* Terminal Processes View */}
      {viewMode === "terminals" && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3.5">
          {terminals.length === 0 ? (
            <div className="col-span-full p-12 text-center rounded-xl bg-white dark:bg-zinc-900/60 border border-zinc-200 dark:border-zinc-800 text-zinc-400 text-xs">
              当前无活动的持久终端会话。命令执行完毕且缓冲区消费完成后，将自动回收。
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
                        <span>{s.pid ?? "未知"}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="flex items-center gap-1 text-zinc-400">
                          <Eye className="w-3 h-3" /> 观察者
                        </span>
                        <span>{s.observers} 个读取端</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="flex items-center gap-1 text-zinc-400">
                          <Clock className="w-3 h-3" /> 最后活跃
                        </span>
                        <span>
                          {new Date(s.touched).toLocaleTimeString("zh-CN")}
                        </span>
                      </div>
                    </div>

                    {/* Buffer Usage Bar */}
                    <div className="p-2.5 rounded-lg bg-zinc-50 dark:bg-zinc-950/70 border border-zinc-100 dark:border-zinc-800 space-y-1.5">
                      <div className="flex items-center justify-between text-[11px] font-mono">
                        <span className="text-zinc-500">未读缓冲</span>
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
                          <span>
                            中间已丢弃 {omittedMb} MiB（日志滚动截断）
                          </span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Lifecycle Footer */}
                  <div className="pt-2 border-t border-zinc-100 dark:border-zinc-800/80 text-[11px] text-zinc-500">
                    {s.exitCode === undefined ? (
                      <div className="flex items-center justify-between">
                        <span className="text-zinc-400">进程状态:</span>
                        <span className="text-emerald-600 dark:text-emerald-400 font-medium flex items-center gap-1">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                          运行中 · 捕获标准输出
                        </span>
                      </div>
                    ) : (
                      <div className="space-y-1">
                        <div className="flex items-center justify-between">
                          <span className="text-zinc-400">退出代码:</span>
                          <span className="font-mono font-semibold text-zinc-700 dark:text-zinc-300">
                            code: {s.exitCode}
                          </span>
                        </div>
                        <p className="text-[10px] text-zinc-400 dark:text-zinc-500 leading-tight">
                          已退出挂起：将在空闲期满后自动释放，不会杀仍在跑的进程
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
              当前暂无活跃的 Code Mode 原生执行会话。当 ChatGPT 发起{" "}
              <code>exec</code> 代码执行时，将按对话 Scope 自动复用或创建会话。
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
                          <span>对齐 OpenAI Session:</span>
                        </div>
                        <h3
                          className="font-mono text-xs font-bold text-zinc-900 dark:text-zinc-100 truncate mt-0.5"
                          title={s.scope ?? "（无 scope 单次会话）"}
                        >
                          {s.scope ?? "（无 scope 单次会话）"}
                        </h3>
                      </div>

                      {s.retired ? (
                        <span className="text-[10px] font-semibold text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/50 border border-rose-200 dark:border-rose-900 px-1.5 py-0.2 rounded shrink-0">
                          已回收
                        </span>
                      ) : isBusy ? (
                        <span className="text-[10px] font-medium text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/60 border border-emerald-200 dark:border-emerald-800 px-1.5 py-0.2 rounded shrink-0 flex items-center gap-1">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                          占用中
                        </span>
                      ) : (
                        <span className="text-[10px] font-medium text-zinc-600 dark:text-zinc-400 bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 px-1.5 py-0.2 rounded shrink-0">
                          空闲
                        </span>
                      )}
                    </div>

                    {/* Metadata breakdown */}
                    <div className="space-y-1.5 text-xs text-zinc-500 font-mono mb-3">
                      <div className="flex items-center justify-between">
                        <span className="text-zinc-400">未收尾 Cell</span>
                        <span className="font-semibold text-zinc-800 dark:text-zinc-200">
                          {s.activeCellCount} 个
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-zinc-400">活动租约 (users)</span>
                        <span>{s.users} 个</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-zinc-400">
                          {isIdle ? "已连续空闲" : "最近活跃"}
                        </span>
                        <span>
                          {isIdle
                            ? formatDuration(Date.now() - s.idleSince)
                            : formatDuration(Date.now() - s.lastUsed) + " 前"}
                        </span>
                      </div>
                    </div>

                    {/* Cell IDs if any */}
                    {s.activeCellIds.length > 0 && (
                      <div className="p-2 rounded-lg bg-zinc-50 dark:bg-zinc-950/70 border border-zinc-100 dark:border-zinc-800 mb-2">
                        <span className="text-[10px] text-zinc-400 block mb-1">
                          存活的 Cell ID (可 wait):
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
                        <span>
                          旧 session 因内存压力已回收，旧 cell 和 store 不再可用
                        </span>
                      </span>
                    ) : s.retired ? (
                      <span className="text-zinc-400">已正常结束释放</span>
                    ) : isIdle ? (
                      s.isOldestIdle ? (
                        <span className="text-amber-700 dark:text-amber-400 flex items-start gap-1 font-sans">
                          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                          <span>
                            空闲且最旧 → 若 host 内存超高水位，将最先被回收
                          </span>
                        </span>
                      ) : (
                        <span className="text-zinc-500 font-sans">
                          空闲中 · 内存超限时先按进入空闲时间 FIFO
                          回收；平时保留 {idleHours} 小时
                        </span>
                      )
                    ) : s.isOldestActive ? (
                      <span className="text-zinc-600 dark:text-zinc-400 font-sans">
                        占用中最久未用 → 仅当没有空闲会话且持续超高水位时才会动
                      </span>
                    ) : (
                      <span className="text-zinc-500 font-sans">
                        占用中 · 正在执行或持有未收尾 cell 租约，受空闲策略保护
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

function formatDuration(ms: number): string {
  if (ms < 1000) return "刚刚";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  const days = Math.floor(hours / 24);
  return `${days} 天`;
}

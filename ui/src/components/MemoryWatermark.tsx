import { CodeModeMemoryStatus } from "../types";
import { Cpu } from "lucide-react";

interface MemoryWatermarkProps {
  memory?: CodeModeMemoryStatus | undefined;
}

export function MemoryWatermark({ memory }: MemoryWatermarkProps) {
  if (!memory) return null;

  const highWaterMib = memory.highWaterMib;
  const highWaterLabel =
    highWaterMib >= 1024
      ? `${(highWaterMib / 1024).toFixed(highWaterMib % 1024 === 0 ? 0 : 1)} GiB`
      : `${highWaterMib} MiB`;

  const isSampled =
    memory.rssBytes !== undefined && memory.status !== "unsampled";
  const rssMib = isSampled ? Math.round(memory.rssBytes! / (1024 * 1024)) : 0;
  const percentage = isSampled
    ? Math.min(100, Math.round((rssMib / highWaterMib) * 100))
    : 0;

  const getStatusBadge = () => {
    switch (memory.status) {
      case "normal":
        return (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-medium bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 border border-zinc-200 dark:border-zinc-700 whitespace-nowrap">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            正常
          </span>
        );
      case "elevated":
        return (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-medium bg-amber-50 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800 whitespace-nowrap">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
            偏高（已过约 75% 目标）
          </span>
        );
      case "exceeded":
        return (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-medium bg-rose-50 dark:bg-rose-950/60 text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-800 whitespace-nowrap">
            <span className="w-1.5 h-1.5 rounded-full bg-rose-500 animate-pulse" />
            已超高水位，可能回收会话
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-medium bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 border border-zinc-200 dark:border-zinc-700 whitespace-nowrap">
            本次未采样
          </span>
        );
    }
  };

  return (
    <div className="mb-4 p-3.5 rounded-xl border border-zinc-200/80 dark:border-zinc-800/80 bg-white dark:bg-zinc-900/50 shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-3 text-xs">
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-lg bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 shrink-0">
            <Cpu className="w-3.5 h-3.5" />
          </div>
          <span className="font-semibold text-zinc-900 dark:text-zinc-100 whitespace-nowrap">
            Code Mode 内存
          </span>
        </div>

        <div className="flex items-center gap-2.5">
          <div className="flex items-baseline gap-1 font-mono">
            {isSampled ? (
              <>
                <span className="font-bold text-sm text-zinc-900 dark:text-zinc-100">
                  {rssMib} MiB
                </span>
                <span className="text-zinc-400">/</span>
                <span className="text-zinc-500">{highWaterLabel}</span>
                <span className="text-[11px] text-zinc-400 ml-1">
                  ({percentage}%)
                </span>
              </>
            ) : (
              <>
                <span className="font-bold text-xs text-zinc-600 dark:text-zinc-400">
                  本次未采样
                </span>
                <span className="text-zinc-400">/</span>
                <span className="text-zinc-500">{highWaterLabel}</span>
              </>
            )}
          </div>

          {isSampled && (
            <div className="w-20 h-1.5 bg-zinc-100 dark:bg-zinc-800 rounded-full overflow-hidden shrink-0">
              <div
                className={`h-full rounded-full transition-all duration-300 ${
                  percentage > 90
                    ? "bg-rose-500"
                    : percentage > 75
                      ? "bg-amber-500"
                      : "bg-zinc-600 dark:bg-zinc-400"
                }`}
                style={{ width: `${percentage}%` }}
              />
            </div>
          )}

          {getStatusBadge()}
        </div>
      </div>

      <div className="text-[11px] text-zinc-500 dark:text-zinc-400 flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-3 shrink-0 font-sans border-t sm:border-t-0 pt-2 sm:pt-0 border-zinc-100 dark:border-zinc-800">
        <span className="whitespace-nowrap">
          空闲保留{" "}
          <strong className="font-semibold text-zinc-700 dark:text-zinc-300">
            {memory.idleRetentionHours} 小时
          </strong>
        </span>
        <span className="hidden sm:inline text-zinc-300 dark:text-zinc-700">
          •
        </span>
        <span className="whitespace-nowrap">超限时先关空闲、再关最久未用</span>
      </div>
    </div>
  );
}

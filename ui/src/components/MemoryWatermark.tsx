import { useLocale } from "../context/LocaleContext";
import { CodeModeMemoryStatus } from "../types";

interface MemoryWatermarkProps {
  memory?: CodeModeMemoryStatus | undefined;
}

export function MemoryWatermark({ memory }: MemoryWatermarkProps) {
  const { t } = useLocale();

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

  const statusText =
    memory.status === "normal" ? (
      <span className="text-zinc-500 dark:text-zinc-400 whitespace-nowrap">
        {t("memory.normal")}
      </span>
    ) : memory.status === "elevated" ? (
      <span className="font-medium text-amber-700 dark:text-amber-400 whitespace-nowrap">
        {t("memory.elevated")}
      </span>
    ) : memory.status === "exceeded" ? (
      <span className="font-medium text-rose-600 dark:text-rose-400">
        {t("memory.exceeded")}
      </span>
    ) : null;

  return (
    <div className="panel mb-3 px-4 py-3 flex flex-col lg:flex-row lg:flex-wrap lg:items-center justify-between gap-x-6 gap-y-2 text-xs">
      <div className="min-w-0 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="font-medium text-zinc-900 dark:text-zinc-100 whitespace-nowrap">
          {t("memory.title")}
        </span>

        <span className="flex items-baseline gap-1 tabular-nums whitespace-nowrap">
          {isSampled ? (
            <>
              <span className="font-semibold text-zinc-900 dark:text-zinc-100">
                {rssMib} MiB
              </span>
              <span className="text-zinc-400">/</span>
              <span className="text-zinc-500">{highWaterLabel}</span>
              <span className="text-zinc-400 ml-1">({percentage}%)</span>
            </>
          ) : (
            <>
              <span className="text-zinc-500 dark:text-zinc-400">
                {t("memory.unsampled")}
              </span>
              <span className="text-zinc-400">/</span>
              <span className="text-zinc-500">{highWaterLabel}</span>
            </>
          )}
        </span>

        {isSampled && (
          <span className="w-20 h-1.5 bg-zinc-100 dark:bg-zinc-800 rounded-full overflow-hidden shrink-0">
            <span
              className={`block h-full rounded-full ${
                percentage > 90
                  ? "bg-rose-500"
                  : percentage > 75
                    ? "bg-amber-500"
                    : "bg-zinc-500 dark:bg-zinc-400"
              }`}
              style={{ width: `${percentage}%` }}
            />
          </span>
        )}

        {statusText}
      </div>

      <div className="min-w-0 text-zinc-500 dark:text-zinc-400 flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-1 sm:gap-3">
        <span className="whitespace-nowrap">
          {t("memory.retention")}{" "}
          <span className="font-medium text-zinc-700 dark:text-zinc-300">
            {memory.idleRetentionHours} {t("common.hours")}
          </span>
        </span>
        <span className="hidden sm:inline text-zinc-300 dark:text-zinc-700">
          ·
        </span>
        <span>{t("memory.order")}</span>
      </div>
    </div>
  );
}

import { useLocale } from "../context/LocaleContext";
import type { ActivityStats } from "../types";

interface StatsOverviewProps {
  stats: ActivityStats;
}

export function StatsOverview({ stats }: StatsOverviewProps) {
  const { t, locale } = useLocale();

  const items = [
    {
      label: t("stats.calls"),
      value: stats.totalCalls,
      unit: t("common.callsUnit"),
    },
    {
      label: t("stats.sessions"),
      value: stats.activeSessions,
      unit: t("common.itemsUnit"),
    },
    {
      label: t("stats.running"),
      value: stats.runningCalls,
      unit: t("common.itemsUnit"),
    },
    {
      label: t("stats.errors"),
      value: stats.errorCalls,
      unit: t("common.callsUnit"),
    },
    {
      label: t("stats.duration"),
      value: stats.avgDurationMs,
      unit: "ms",
    },
  ];

  return (
    <dl className="panel mb-6 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-x-6 gap-y-4 px-4 py-3.5">
      {items.map((item) => (
        <div key={item.label} className="min-w-0">
          <dt className="text-xs text-zinc-500 dark:text-zinc-400 truncate">
            {item.label}
          </dt>
          <dd className="mt-1 flex items-baseline gap-1">
            <span className="text-2xl font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
              {item.value.toLocaleString(locale)}
            </span>
            {item.unit && (
              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                {item.unit}
              </span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

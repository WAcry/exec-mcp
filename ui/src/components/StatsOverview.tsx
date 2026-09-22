import { useLocale } from "../context/LocaleContext";
import type { ActivityStats } from "../types";
import { Activity, Clock, AlertCircle, Layers, Zap } from "lucide-react";

interface StatsOverviewProps {
  stats: ActivityStats;
}

export function StatsOverview({ stats }: StatsOverviewProps) {
  const { t, locale } = useLocale();

  const cards = [
    {
      label: t("stats.calls"),
      value: stats.totalCalls,
      unit: t("common.callsUnit"),
      icon: Activity,
    },
    {
      label: t("stats.sessions"),
      value: stats.activeSessions,
      unit: t("common.itemsUnit"),
      icon: Layers,
    },
    {
      label: t("stats.running"),
      value: stats.runningCalls,
      unit: t("common.itemsUnit"),
      icon: Zap,
      active: stats.runningCalls > 0,
      activeColor: "bg-amber-500",
    },
    {
      label: t("stats.errors"),
      value: stats.errorCalls,
      unit: t("common.callsUnit"),
      icon: AlertCircle,
    },
    {
      label: t("stats.duration"),
      value: stats.avgDurationMs,
      unit: "ms",
      icon: Clock,
    },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-6">
      {cards.map((c, i) => {
        const Icon = c.icon;
        return (
          <div
            key={i}
            className="p-3.5 rounded-xl border border-zinc-200/80 dark:border-zinc-800/80 bg-white dark:bg-zinc-900/50 shadow-xs hover:border-zinc-300 dark:hover:border-zinc-700 transition-all flex flex-col justify-between"
          >
            <div className="flex items-center justify-between text-zinc-500 dark:text-zinc-400 mb-2">
              <span className="min-w-0 text-[11px] font-medium tracking-wide">
                {c.label}
              </span>
              <div className="flex items-center gap-1.5 shrink-0">
                {c.active && (
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${c.activeColor} ${c.activeColor === "bg-amber-500" ? "animate-pulse" : ""}`}
                  />
                )}
                <Icon className="w-3.5 h-3.5 text-zinc-400 dark:text-zinc-500" />
              </div>
            </div>
            <div className="flex items-baseline gap-1">
              <span className="text-xl sm:text-2xl font-bold font-mono tracking-tight text-zinc-900 dark:text-zinc-100">
                {c.value.toLocaleString(locale)}
              </span>
              <span className="text-xs text-zinc-400 dark:text-zinc-500 font-mono">
                {c.unit}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

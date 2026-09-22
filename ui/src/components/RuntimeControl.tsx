import { useLocale } from "../context/LocaleContext";
import { RotateCw } from "lucide-react";
import { useManagement } from "../context/ManagementContext";

export function RuntimeControl() {
  const { t } = useLocale();

  const { data, busy, error, restart } = useManagement();
  if (!data?.available) return null;
  return (
    <section className="mb-4 flex flex-col gap-2 rounded-xl border border-zinc-200 bg-white px-4 py-3 text-xs dark:border-zinc-800 dark:bg-zinc-900/50">
      <div className="flex items-center justify-between gap-3">
        <div className="text-zinc-500">
          <span
            className={
              data.pending
                ? "font-medium text-amber-700 dark:text-amber-400"
                : ""
            }
          >
            {data.state === "restarting"
              ? t("runtime.reloading")
              : data.pending
                ? t("runtime.pending")
                : t("runtime.applied")}
          </span>
          <span className="ml-3 hidden sm:inline">{t("runtime.help")}</span>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => void restart()}
          title={t("runtime.restartTitle")}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-zinc-200 px-3 py-1.5 font-medium hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          <RotateCw
            className={`h-3.5 w-3.5 ${data.state === "restarting" ? "animate-spin" : ""}`}
          />
          {data.state === "restarting"
            ? t("header.restarting")
            : t("runtime.restart")}
        </button>
      </div>
      {(error || data.error) && (
        <p
          role="alert"
          className="break-words text-rose-600 dark:text-rose-400"
        >
          {error || data.error}
          {t("runtime.retry")}
        </p>
      )}
      {data.settings?.web === false && data.pending && (
        <p className="text-amber-700 dark:text-amber-400">
          {t("runtime.webClosing")}
        </p>
      )}
    </section>
  );
}

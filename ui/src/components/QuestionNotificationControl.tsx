import { useLocale } from "../context/LocaleContext";
import { Bell, BellOff } from "lucide-react";
import type { useQuestionNotifications } from "../lib/use-question-notifications";

const messages = {
  default: "notification.default",
  enabled: "notification.enabled",
  paused: "notification.paused",
  denied: "notification.denied",
  insecure: "notification.insecure",
  unsupported: "notification.unsupported",
  error: "notification.error",
} as const;

export function QuestionNotificationControl({
  notifications,
}: {
  notifications: ReturnType<typeof useQuestionNotifications>;
}) {
  const { t } = useLocale();

  const { state, requesting, enable, pause, test } = notifications;
  const enabled = state === "enabled";
  const available = !["denied", "unsupported", "insecure"].includes(state);
  return (
    <details className="relative">
      <summary
        aria-label={t("notification.label")}
        title={t("notification.label")}
        className="list-none [&::-webkit-details-marker]:hidden cursor-pointer p-1.5 rounded-md text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
      >
        {enabled ? (
          <Bell className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
        ) : (
          <BellOff className="w-4 h-4" />
        )}
      </summary>
      <div className="fixed right-4 top-28 sm:absolute sm:right-0 sm:top-full mt-2 w-64 max-w-[85vw] rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-3 shadow-xl space-y-3 text-xs text-zinc-700 dark:text-zinc-300">
        <h2 className="font-semibold">{t("notification.label")}</h2>
        <p role="status">{t(messages[state])}</p>
        <div className="flex gap-2">
          {available && (
            <button
              disabled={requesting}
              onClick={() => (enabled ? pause() : void enable())}
              className="px-2.5 py-1.5 rounded-md bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 disabled:opacity-50 cursor-pointer"
            >
              {requesting
                ? t("notification.requesting")
                : enabled
                  ? t("notification.pause")
                  : state === "error"
                    ? t("notification.retry")
                    : t("notification.enable")}
            </button>
          )}
          {enabled && (
            <button
              onClick={test}
              className="px-2.5 py-1.5 rounded-md border border-zinc-200 dark:border-zinc-700 cursor-pointer"
            >
              {t("notification.test")}
            </button>
          )}
        </div>
        <p className="text-[11px] leading-relaxed text-zinc-500">
          {t("notification.help")}
        </p>
      </div>
    </details>
  );
}

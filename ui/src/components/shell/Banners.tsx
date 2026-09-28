import { RotateCw, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { useLive } from "../../context/LiveContext";
import { useLocale } from "../../context/LocaleContext";
import { useManagement } from "../../context/ManagementContext";
import { ConfirmButton } from "../ui/Controls";

function Travel() {
  return (
    <span className="absolute inset-x-0 bottom-0 block h-px overflow-hidden">
      <span className="travel absolute inset-y-0 left-0 w-1/3 bg-run" />
    </span>
  );
}

/** Shown only when configuration waits for a restart, restarts, or failed to. */
export function RuntimeBanner() {
  const { t } = useLocale();
  const { data, error, busy, restart } = useManagement();
  if (!data?.available) return null;
  const restarting = data.state === "restarting";
  const failure = error || data.error;
  if (!restarting && !data.pending && !failure) return null;
  return (
    <div
      role="status"
      className="relative flex min-h-10 shrink-0 items-center gap-3 border-b border-line bg-surface px-5 py-2 text-sm"
    >
      {restarting ? (
        <RotateCw className="h-4 w-4 shrink-0 animate-spin text-run" />
      ) : (
        <TriangleAlert
          className={`h-4 w-4 shrink-0 ${failure ? "text-err" : "text-warn"}`}
          strokeWidth={1.8}
        />
      )}
      <span className="min-w-0 flex-1 text-ink-2">
        {restarting
          ? t("runtime.reloading")
          : failure
            ? `${failure} ${t("runtime.retry")}`
            : data.settings?.web === false
              ? t("runtime.webClosing")
              : t("runtime.pending")}
      </span>
      {!restarting && (
        <ConfirmButton
          disabled={busy}
          onConfirm={restart}
          confirmLabel={t("runtime.confirmRestart")}
        >
          <RotateCw className="h-3.5 w-3.5" />
          {t("runtime.restart")}
        </ConfirmButton>
      )}
      {restarting && <Travel />}
    </div>
  );
}

/** Stays quiet during brief reconnects; appears once the stream has been down a moment. */
export function ConnectionBanner() {
  const { t } = useLocale();
  const { connection } = useLive();
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (connection !== "offline") {
      setVisible(false);
      return;
    }
    const timer = window.setTimeout(() => setVisible(true), 2500);
    return () => window.clearTimeout(timer);
  }, [connection]);
  if (!visible) return null;
  return (
    <div
      role="status"
      className="relative flex h-9 shrink-0 items-center gap-2 border-b border-line bg-surface px-5 text-sm text-ink-2"
    >
      <span className="h-1.5 w-1.5 rounded-full bg-err" />
      {t("connection.lost")}
      <Travel />
    </div>
  );
}

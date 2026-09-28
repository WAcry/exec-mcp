import { useLocale } from "../context/LocaleContext";
import { useState, useEffect } from "react";
import { ArtifactItem } from "../types";
import { apiFetch } from "../lib/api";
import { Trash2, RefreshCw } from "lucide-react";

export function ArtifactsView() {
  const { t, locale } = useLocale();

  const [artifacts, setArtifacts] = useState<ArtifactItem[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchArtifacts = async () => {
    try {
      const res = await apiFetch<{ artifacts: ArtifactItem[] }>(
        "/api/artifacts",
      );
      setArtifacts(res.artifacts);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchArtifacts();
    const timer = setInterval(fetchArtifacts, 4000);
    return () => clearInterval(timer);
  }, []);

  const handleRevoke = async (id: string) => {
    if (!confirm(t("artifacts.revokeConfirm"))) return;
    try {
      await apiFetch("/api/artifacts/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      fetchArtifacts();
    } catch (err) {
      alert(t("artifacts.revokeFailed") + String(err));
    }
  };

  return (
    <div className="space-y-3.5">
      <div className="panel flex items-center justify-between gap-3 p-4">
        <div>
          <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
            {t("artifacts.title")}
          </h2>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
            {t("artifacts.help")}
          </p>
        </div>
        <button
          onClick={fetchArtifacts}
          className="flex items-center gap-1 shrink-0 px-2.5 py-1.5 rounded-md text-xs bg-zinc-50 dark:bg-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-300 transition-colors cursor-pointer"
        >
          <RefreshCw
            className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`}
          />
          {t("common.refresh")}
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3.5">
        {artifacts.length === 0 ? (
          <div className="panel col-span-full p-12 text-center text-zinc-400 text-xs">
            {t("artifacts.empty")}
          </div>
        ) : (
          artifacts.map((item) => (
            <div key={item.id} className="panel p-4 flex flex-col">
              <div>
                <div className="flex items-start justify-between gap-2">
                  <h3
                    className="min-w-0 text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate"
                    title={item.name}
                  >
                    {item.name}
                  </h3>
                  <button
                    onClick={() => handleRevoke(item.id)}
                    className="p-1 -mr-1 text-zinc-400 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded transition-colors cursor-pointer"
                    title={t("artifacts.revoke")}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>

                <div className="mt-2.5 space-y-1 text-xs text-zinc-500">
                  <div className="flex items-center justify-between">
                    <span>{t("artifacts.size")}</span>
                    <span className="tabular-nums text-zinc-700 dark:text-zinc-300">
                      {(item.size / 1024).toFixed(1)} KB
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>{t("artifacts.mime")}</span>
                    <span className="font-mono text-zinc-700 dark:text-zinc-300">
                      {item.mime_type}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span>{t("artifacts.expiry")}</span>
                    <span className="tabular-nums text-zinc-700 dark:text-zinc-300">
                      {new Date(item.expires_at).toLocaleTimeString(locale)}
                    </span>
                  </div>
                </div>

                <p className="mt-3 pt-2.5 border-t border-zinc-100 dark:border-zinc-800 text-[11px] font-mono text-zinc-500 dark:text-zinc-400 break-all select-all">
                  {item.uri}
                </p>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

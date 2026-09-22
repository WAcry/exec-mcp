import { useLocale } from "../context/LocaleContext";
import { useState, useEffect } from "react";
import { ArtifactItem } from "../types";
import { apiFetch } from "../lib/api";
import { HardDrive, Trash2, Clock, FileText, RefreshCw } from "lucide-react";

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
      <div className="flex items-center justify-between p-3.5 rounded-xl bg-white dark:bg-zinc-900/60 border border-zinc-200/80 dark:border-zinc-800/80 shadow-xs">
        <div>
          <h2 className="text-xs font-bold text-zinc-900 dark:text-zinc-100 flex items-center gap-1.5">
            <HardDrive className="w-3.5 h-3.5 text-zinc-400" />
            {t("artifacts.title")}
          </h2>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
            {t("artifacts.help")}
          </p>
        </div>
        <button
          onClick={fetchArtifacts}
          className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs bg-zinc-50 dark:bg-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-300 transition-colors cursor-pointer"
        >
          <RefreshCw
            className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`}
          />
          {t("common.refresh")}
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3.5">
        {artifacts.length === 0 ? (
          <div className="col-span-full p-12 text-center rounded-xl bg-white dark:bg-zinc-900/60 border border-zinc-200 dark:border-zinc-800 text-zinc-400 text-xs">
            {t("artifacts.empty")}
          </div>
        ) : (
          artifacts.map((item) => (
            <div
              key={item.id}
              className="p-4 rounded-xl bg-white dark:bg-zinc-900/50 border border-zinc-200/80 dark:border-zinc-800/80 shadow-xs space-y-2.5 flex flex-col justify-between"
            >
              <div>
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <div className="p-1.5 rounded-lg bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300">
                      <FileText className="w-3.5 h-3.5" />
                    </div>
                    <h3 className="font-mono text-xs font-bold text-zinc-900 dark:text-zinc-100 truncate max-w-[180px]">
                      {item.name}
                    </h3>
                  </div>
                  <button
                    onClick={() => handleRevoke(item.id)}
                    className="p-1 text-zinc-400 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded transition-colors cursor-pointer"
                    title={t("artifacts.revoke")}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>

                <div className="mt-2.5 space-y-1 text-xs text-zinc-500 font-mono">
                  <div className="flex items-center justify-between">
                    <span className="text-zinc-400">{t("artifacts.size")}</span>
                    <span>{(item.size / 1024).toFixed(1)} KB</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-zinc-400">{t("artifacts.mime")}</span>
                    <span>{item.mime_type}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-zinc-400 flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      {t("artifacts.expiry")}
                    </span>
                    <span className="text-[11px]">
                      {new Date(item.expires_at).toLocaleTimeString(locale)}
                    </span>
                  </div>
                </div>

                <div className="mt-2.5 p-2 bg-zinc-50 dark:bg-zinc-950 rounded-lg border border-zinc-100 dark:border-zinc-800 text-[10px] font-mono text-zinc-500 dark:text-zinc-400 break-all select-all">
                  {item.uri}
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

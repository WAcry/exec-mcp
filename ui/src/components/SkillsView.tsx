import { useLocale } from "../context/LocaleContext";
import { useState, useEffect, useCallback } from "react";
import type { SkillsResponse } from "../types";
import { apiFetch } from "../lib/api";
import { useManagement } from "../context/ManagementContext";
import { ConfigToggle } from "./ConfigToggle";
import { AlertCircle, RefreshCw } from "lucide-react";

export function SkillsView() {
  const { t } = useLocale();

  const management = useManagement();
  const [data, setData] = useState<SkillsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [workdir, setWorkdir] = useState("");
  const [appliedWorkdir, setAppliedWorkdir] = useState("");
  const [error, setError] = useState("");

  const fetchSkills = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await apiFetch<SkillsResponse>(
        `/api/skills${appliedWorkdir ? `?workdir=${encodeURIComponent(appliedWorkdir)}` : ""}`,
      );
      setData(res);
    } catch (caught) {
      setError(String(caught));
    } finally {
      setLoading(false);
    }
  }, [appliedWorkdir]);

  useEffect(() => {
    fetchSkills();
  }, [fetchSkills, management.data?.revision, management.data?.generation]);

  const totalChars = data?.totalChars ?? 0;
  const maxChars = data?.maxChars ?? 40000;
  const pct = Math.min(100, Math.round((totalChars / maxChars) * 100));

  return (
    <div className="space-y-3.5">
      <div className="panel flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 p-4">
        <div>
          <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
            {t("nav.skills")}
          </h2>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
            {t("skills.help")}
          </p>
        </div>

        <div className="flex items-center gap-4 shrink-0">
          <div className="flex items-center gap-2 text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
            <span>{t("skills.budget")}</span>
            <div className="w-16 h-1.5 bg-zinc-100 dark:bg-zinc-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-zinc-500 dark:bg-zinc-400 rounded-full"
                style={{ width: `${pct}%` }}
              />
            </div>
            <span>{t("skills.characters", totalChars, maxChars, pct)}</span>
          </div>
          <button
            onClick={fetchSkills}
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs bg-zinc-50 dark:bg-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-300 transition-colors cursor-pointer"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`}
            />
            {t("common.refresh")}
          </button>
        </div>
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          setAppliedWorkdir(workdir.trim());
        }}
        className="flex gap-2"
      >
        <input
          aria-label={t("skills.directory")}
          value={workdir}
          onChange={(event) => setWorkdir(event.target.value)}
          placeholder={t("skills.placeholder")}
          className="min-w-0 flex-1 rounded-md border border-zinc-200 bg-white px-3 py-2 text-xs placeholder:text-zinc-400 focus:outline-none focus:border-zinc-400 focus:ring-1 focus:ring-zinc-400 dark:border-zinc-800 dark:bg-zinc-900 dark:focus:border-zinc-600 dark:focus:ring-zinc-600"
        />
        <button
          type="submit"
          disabled={loading}
          className="rounded-md border border-zinc-200 bg-white px-3 text-xs hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:bg-zinc-800 cursor-pointer transition-colors"
        >
          {t("skills.view")}
        </button>
      </form>
      {error && (
        <p role="alert" className="text-xs text-rose-600">
          {error}
        </p>
      )}

      {data?.warnings && data.warnings.length > 0 && (
        <div className="panel p-3 text-xs text-zinc-700 dark:text-zinc-300 space-y-1.5">
          <div className="font-semibold flex items-center gap-1.5 text-zinc-900 dark:text-zinc-100">
            <AlertCircle className="w-3.5 h-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
            {t("skills.warnings")}
          </div>
          <ul className="list-disc list-inside space-y-0.5 font-mono text-[11px]">
            {data.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3.5">
        {!data || data.skills.length === 0 ? (
          <div className="panel col-span-full p-12 text-center text-zinc-400 text-xs">
            {t("skills.empty")}
          </div>
        ) : (
          data.skills.map((skill) => (
            <div
              key={skill.path}
              className="panel p-4 space-y-3 flex flex-col justify-between"
            >
              <div>
                <div className="flex items-baseline gap-2 mb-1.5">
                  <h3 className="font-mono text-xs font-medium text-zinc-900 dark:text-zinc-100 truncate">
                    {skill.name}
                  </h3>
                  {!skill.implicit && (
                    <span className="ml-auto text-[11px] text-zinc-500 whitespace-nowrap">
                      {t("skills.explicit")}
                    </span>
                  )}
                </div>

                <p className="text-xs text-zinc-600 dark:text-zinc-400 leading-relaxed">
                  {skill.description || t("skills.explicitHelp")}
                </p>
                {management.data?.available && (
                  <div className="mt-3">
                    <ConfigToggle
                      label={t("skills.enable", skill.name)}
                      checked={skill.enabled !== false}
                      disabled={management.busy}
                      onChange={(enabled) =>
                        void management.toggle({
                          kind: "skill",
                          path: skill.path,
                          enabled,
                          ...(appliedWorkdir
                            ? { workdir: appliedWorkdir }
                            : {}),
                        })
                      }
                    />
                  </div>
                )}
              </div>

              {skill.path && (
                <div className="pt-2.5 border-t border-zinc-100 dark:border-zinc-800 flex text-[11px] text-zinc-400 dark:text-zinc-500 font-mono">
                  <span className="truncate select-all" title={skill.path}>
                    {skill.path}
                  </span>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

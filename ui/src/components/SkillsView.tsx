import { useLocale } from "../context/LocaleContext";
import { useState, useEffect, useCallback } from "react";
import type { SkillsResponse } from "../types";
import { apiFetch } from "../lib/api";
import { useManagement } from "../context/ManagementContext";
import { ConfigToggle } from "./ConfigToggle";
import {
  FileCode2,
  AlertCircle,
  RefreshCw,
  FolderTree,
  BookOpen,
} from "lucide-react";

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
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 p-3.5 rounded-xl bg-white dark:bg-zinc-900/60 border border-zinc-200/80 dark:border-zinc-800/80 shadow-xs">
        <div>
          <h2 className="text-xs font-bold text-zinc-900 dark:text-zinc-100 flex items-center gap-1.5">
            <FileCode2 className="w-3.5 h-3.5 text-zinc-400" />
            {t("nav.skills")}
          </h2>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
            {t("skills.help")}
          </p>
        </div>

        <div className="flex items-center gap-2.5 shrink-0">
          <div className="flex items-center gap-2 text-xs font-mono text-zinc-500 dark:text-zinc-400 bg-zinc-50 dark:bg-zinc-950 px-2.5 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-800">
            <span>{t("skills.budget")}</span>
            <div className="w-16 h-1.5 bg-zinc-200 dark:bg-zinc-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-zinc-600 dark:bg-zinc-400 rounded-full transition-all"
                style={{ width: `${pct}%` }}
              />
            </div>
            <span>{t("skills.characters", totalChars, maxChars, pct)}</span>
          </div>
          <button
            onClick={fetchSkills}
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs bg-zinc-50 dark:bg-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-300 transition-colors cursor-pointer"
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
          className="min-w-0 flex-1 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs dark:border-zinc-700 dark:bg-zinc-900"
        />
        <button
          type="submit"
          disabled={loading}
          className="rounded-lg border border-zinc-200 px-3 text-xs dark:border-zinc-700"
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
        <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/60 text-xs text-amber-800 dark:text-amber-300 space-y-1">
          <div className="font-semibold flex items-center gap-1.5">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
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
          <div className="col-span-full p-12 text-center rounded-xl bg-white dark:bg-zinc-900/60 border border-zinc-200 dark:border-zinc-800 text-zinc-400 text-xs">
            {t("skills.empty")}
          </div>
        ) : (
          data.skills.map((skill) => (
            <div
              key={skill.path}
              className="p-4 rounded-xl bg-white dark:bg-zinc-900/50 border border-zinc-200/80 dark:border-zinc-800/80 shadow-xs space-y-2.5 flex flex-col justify-between"
            >
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <div className="p-1.5 rounded-lg bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 shrink-0">
                    <BookOpen className="w-3.5 h-3.5" />
                  </div>
                  <h3 className="font-mono text-xs font-bold text-zinc-900 dark:text-zinc-100 truncate">
                    {skill.name}
                  </h3>
                  {!skill.implicit && (
                    <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded bg-amber-50 dark:bg-amber-950/50 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-900 whitespace-nowrap">
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
                <div className="pt-2 border-t border-zinc-100 dark:border-zinc-800/80 flex items-center gap-1.5 text-[11px] text-zinc-400 dark:text-zinc-500 font-mono truncate">
                  <FolderTree className="w-3 h-3 shrink-0" />
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

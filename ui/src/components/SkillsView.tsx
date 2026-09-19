import { useState, useEffect } from "react";
import { SkillsResponse } from "../types";
import { apiFetch } from "../lib/api";
import {
  FileCode2,
  AlertCircle,
  RefreshCw,
  FolderTree,
  BookOpen,
} from "lucide-react";

export function SkillsView() {
  const [data, setData] = useState<SkillsResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchSkills = async () => {
    try {
      const res = await apiFetch<SkillsResponse>("/api/skills");
      setData(res);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSkills();
  }, []);

  const totalChars = data?.totalChars ?? 0;
  const maxChars = data?.maxChars ?? 10000;
  const pct = Math.min(100, Math.round((totalChars / maxChars) * 100));

  return (
    <div className="space-y-3.5">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 p-3.5 rounded-xl bg-white dark:bg-zinc-900/60 border border-zinc-200/80 dark:border-zinc-800/80 shadow-xs">
        <div>
          <h2 className="text-xs font-bold text-zinc-900 dark:text-zinc-100 flex items-center gap-1.5">
            <FileCode2 className="w-3.5 h-3.5 text-zinc-400" />
            本机与项目 Skills 目录 (tools.list_skills)
          </h2>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
            单次发现目录，字符预算控制在约 10,000 tokens。全文由 ChatGPT
            按需通过系统命令读取。
          </p>
        </div>

        <div className="flex items-center gap-2.5 shrink-0">
          <div className="flex items-center gap-2 text-xs font-mono text-zinc-500 dark:text-zinc-400 bg-zinc-50 dark:bg-zinc-950 px-2.5 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-800">
            <span>预算:</span>
            <div className="w-16 h-1.5 bg-zinc-200 dark:bg-zinc-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-zinc-600 dark:bg-zinc-400 rounded-full transition-all"
                style={{ width: `${pct}%` }}
              />
            </div>
            <span>
              {totalChars}/{maxChars} 字符 ({pct}%)
            </span>
          </div>
          <button
            onClick={fetchSkills}
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs bg-zinc-50 dark:bg-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-300 transition-colors cursor-pointer"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`}
            />
            刷新
          </button>
        </div>
      </div>

      {data?.warnings && data.warnings.length > 0 && (
        <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/60 text-xs text-amber-800 dark:text-amber-300 space-y-1">
          <div className="font-semibold flex items-center gap-1.5">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
            Skills 扫描提示:
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
            未在当前环境或工作区发现任何 Skill 定义。支持{" "}
            <code>.cursor/skills/</code> 等标准规范路径。
          </div>
        ) : (
          data.skills.map((skill) => (
            <div
              key={skill.name}
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
                </div>

                <p className="text-xs text-zinc-600 dark:text-zinc-400 leading-relaxed">
                  {skill.description || "暂无描述信息"}
                </p>
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

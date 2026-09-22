import { useLocale } from "../context/LocaleContext";
import { useState, useEffect } from "react";
import type { McpServersResponse } from "../types";
import { apiFetch } from "../lib/api";
import { CodeBlock } from "./CodeBlock";
import { Wrench, Server, Search, ChevronRight, RefreshCw } from "lucide-react";
import { useManagement } from "../context/ManagementContext";
import { ConfigToggle } from "./ConfigToggle";

export function McpView() {
  const { t } = useLocale();

  const management = useManagement();
  const [data, setData] = useState<McpServersResponse | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [selectedTool, setSelectedTool] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    apiFetch<McpServersResponse>("/api/mcp-servers", {
      signal: controller.signal,
    })
      .then((value) => {
        if (!controller.signal.aborted) setData(value);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(String(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [management.data?.revision, management.data?.generation, refresh]);

  const query = searchQuery.trim().toLowerCase();
  const tools = (data?.tools ?? []).filter((tool) =>
    (tool.name + " " + tool.description).toLowerCase().includes(query),
  );

  return (
    <div className="space-y-4">
      {error && (
        <p role="alert" className="text-xs text-rose-600">
          {t("mcp.loadFailed")}
          {error}
        </p>
      )}
      {Object.entries(data?.errors ?? {}).map(([server, message]) => (
        <p
          key={server}
          role="alert"
          className="text-xs text-rose-600 break-words"
        >
          {server}：{message}
        </p>
      ))}
      {/* Downstream Server Configurations */}
      <div className="p-4 rounded-xl bg-white dark:bg-zinc-900/50 border border-zinc-200/80 dark:border-zinc-800/80 shadow-xs space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Server className="w-4 h-4 text-zinc-400" />
            <h3 className="text-xs font-bold text-zinc-900 dark:text-zinc-100">
              {t("mcp.title")}
            </h3>
          </div>
          <span className="text-[11px] font-mono px-2 py-0.5 rounded-md bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 border border-zinc-200 dark:border-zinc-700">
            {t("mcp.servers", data?.servers.length ?? 0)}
          </span>
        </div>

        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          {t("mcp.help")}
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-1">
          {!data || data.servers.length === 0 ? (
            <div className="col-span-full p-8 text-center border border-dashed border-zinc-200 dark:border-zinc-800 rounded-lg text-zinc-400 text-xs">
              {t("mcp.empty")}
            </div>
          ) : (
            data.servers.map((s) => (
              <div
                key={s.name}
                className="p-3.5 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-950/40 space-y-2"
              >
                <div className="flex items-center justify-between">
                  <span className="font-mono font-bold text-xs text-zinc-900 dark:text-zinc-100">
                    {s.name}
                  </span>
                  <span className="text-[10px] uppercase font-mono px-1.5 py-0.2 rounded font-semibold bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 border border-zinc-200 dark:border-zinc-700">
                    {s.transport}
                  </span>
                  {management.data?.available && (
                    <ConfigToggle
                      label={t("mcp.enable", s.name)}
                      checked={s.enabled !== false}
                      disabled={management.busy}
                      onChange={(enabled) =>
                        void management.toggle({
                          kind: "mcp",
                          name: s.name,
                          enabled,
                        })
                      }
                    />
                  )}
                </div>

                <div className="text-xs font-mono text-zinc-600 dark:text-zinc-400 break-all space-y-1">
                  {s.transport === "stdio" ? (
                    <div>
                      <span className="text-zinc-400 font-sans">
                        {t("mcp.command")}
                      </span>
                      {s.command ?? t("mcp.inactive")}
                      {s.argsCount ? t("mcp.args", s.argsCount) : ""}
                    </div>
                  ) : (
                    <div>
                      <span className="text-zinc-400 font-sans">URL: </span>
                      {s.url ?? t("mcp.inactive")}
                    </div>
                  )}
                  {s.cwd && (
                    <div>
                      <span className="text-zinc-400 font-sans">
                        {t("mcp.workdir")}{" "}
                      </span>
                      {s.cwd}
                    </div>
                  )}
                  {s.envKeys?.length ? (
                    <div>
                      <span className="text-zinc-400 font-sans">
                        {t("mcp.env")}{" "}
                      </span>
                      {s.envKeys.join(", ")}
                    </div>
                  ) : null}
                  {s.headerNames?.length ? (
                    <div>
                      <span className="text-zinc-400 font-sans">
                        {t("mcp.headers")}{" "}
                      </span>
                      {s.headerNames.join(", ")}
                    </div>
                  ) : null}
                </div>

                {s.enabledTools && (
                  <div className="pt-2 border-t border-zinc-200/60 dark:border-zinc-800/60 flex items-center gap-1.5 flex-wrap">
                    <span className="text-[10px] text-zinc-400">
                      {t("mcp.allowedTools")}
                    </span>
                    {s.enabledTools.map((t) => (
                      <span
                        key={t}
                        className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>

      {/* Available Tools Snapshot */}
      <div className="p-4 rounded-xl bg-white dark:bg-zinc-900/50 border border-zinc-200/80 dark:border-zinc-800/80 shadow-xs space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Wrench className="w-4 h-4 text-zinc-400" />
            <h3 className="text-xs font-bold text-zinc-900 dark:text-zinc-100">
              {t("mcp.toolsTitle")}
            </h3>
          </div>
          <span className="text-xs font-mono text-zinc-400">
            {tools.length} / {data?.tools.length ?? 0} {t("mcp.toolsUnit")}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <Search className="w-4 h-4 shrink-0 text-zinc-400" />
          <input
            aria-label={t("mcp.filter")}
            placeholder={t("mcp.filterPlaceholder")}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="min-w-0 flex-1 px-3 py-1.5 text-xs bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-lg"
          />
          <button
            type="button"
            disabled={loading}
            onClick={() => setRefresh((value) => value + 1)}
            className="flex items-center gap-1 shrink-0 px-2 py-1.5 text-xs border border-zinc-200 dark:border-zinc-700 rounded-lg disabled:opacity-50 cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            {loading ? t("common.reading") : t("mcp.refresh")}
          </button>
        </div>

        <div className="divide-y divide-zinc-100 dark:divide-zinc-800/60">
          {!data || data.tools.length === 0 ? (
            <div className="py-6 text-center text-zinc-400 text-xs">
              {loading ? t("mcp.loading") : t("mcp.noTools")}
            </div>
          ) : tools.length === 0 ? (
            <div className="py-6 text-center text-zinc-400 text-xs">
              {t("mcp.noMatches")}
            </div>
          ) : (
            tools.map((t) => (
              <div key={t.name} className="py-2.5 flex flex-col gap-1">
                <button
                  type="button"
                  aria-expanded={selectedTool === t.name}
                  onClick={() =>
                    setSelectedTool(selectedTool === t.name ? null : t.name)
                  }
                  className="flex items-center justify-between gap-2 text-left cursor-pointer group"
                >
                  <span className="font-mono text-xs font-bold text-zinc-800 dark:text-zinc-200 group-hover:underline break-all">
                    tools.{t.name}
                  </span>
                  <ChevronRight
                    className={`w-3.5 h-3.5 text-zinc-400 transition-transform ${
                      selectedTool === t.name ? "rotate-90" : ""
                    }`}
                  />
                </button>
                <p className="text-xs text-zinc-600 dark:text-zinc-400 break-words">
                  {t.description.split("\n")[0]}
                </p>
                {selectedTool === t.name && (
                  <div className="mt-2">
                    <CodeBlock
                      code={t.description}
                      language="text"
                      maxHeight="max-h-96"
                    />
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

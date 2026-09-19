import { useState, useEffect } from "react";
import type { McpServersResponse } from "../types";
import { apiFetch } from "../lib/api";
import { CodeBlock } from "./CodeBlock";
import { Wrench, Server, Search, ChevronRight } from "lucide-react";
import { useManagement } from "../context/ManagementContext";
import { ConfigToggle } from "./ConfigToggle";

export function McpView() {
  const management = useManagement();
  const [data, setData] = useState<McpServersResponse | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResult, setSearchResult] = useState<unknown | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [selectedTool, setSelectedTool] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<McpServersResponse>("/api/mcp-servers")
      .then(setData)
      .catch(console.error);
  }, [management.data?.revision, management.data?.generation]);

  const handleTestSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;
    setIsSearching(true);
    try {
      const res = await apiFetch("/api/mcp-servers/test-search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: searchQuery }),
      });
      setSearchResult(res);
    } catch (err) {
      console.error(err);
    } finally {
      setIsSearching(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Downstream Server Configurations */}
      <div className="p-4 rounded-xl bg-white dark:bg-zinc-900/50 border border-zinc-200/80 dark:border-zinc-800/80 shadow-xs space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Server className="w-4 h-4 text-zinc-400" />
            <h3 className="text-xs font-bold text-zinc-900 dark:text-zinc-100">
              已挂载的下游 MCP 服务
            </h3>
          </div>
          <span className="text-[11px] font-mono px-2 py-0.5 rounded-md bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 border border-zinc-200 dark:border-zinc-700">
            {data?.servers.length ?? 0} 个服务
          </span>
        </div>

        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          所有启用的下游在服务就绪前完成连接与工具加载；检索只查询本地目录，不负责解锁工具。
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-1">
          {!data || data.servers.length === 0 ? (
            <div className="col-span-full p-8 text-center border border-dashed border-zinc-200 dark:border-zinc-800 rounded-lg text-zinc-400 text-xs">
              尚未在 <code>config.toml</code> 的 <code>[mcp_servers]</code>{" "}
              中配置外部服务。
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
                      label={`启用 MCP ${s.name}`}
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
                      <span className="text-zinc-400 font-sans">命令: </span>
                      {s.command ?? "当前未加载"}
                      {s.argsCount ? `（${s.argsCount} 个参数，值已隐藏）` : ""}
                    </div>
                  ) : (
                    <div>
                      <span className="text-zinc-400 font-sans">URL: </span>
                      {s.url ?? "当前未加载"}
                    </div>
                  )}
                  {s.cwd && (
                    <div>
                      <span className="text-zinc-400 font-sans">
                        工作目录:{" "}
                      </span>
                      {s.cwd}
                    </div>
                  )}
                  {s.envKeys?.length ? (
                    <div>
                      <span className="text-zinc-400 font-sans">
                        环境变量键:{" "}
                      </span>
                      {s.envKeys.join(", ")}
                    </div>
                  ) : null}
                  {s.headerNames?.length ? (
                    <div>
                      <span className="text-zinc-400 font-sans">
                        HTTP Header 键:{" "}
                      </span>
                      {s.headerNames.join(", ")}
                    </div>
                  ) : null}
                </div>

                {s.enabledTools && (
                  <div className="pt-2 border-t border-zinc-200/60 dark:border-zinc-800/60 flex items-center gap-1.5 flex-wrap">
                    <span className="text-[10px] text-zinc-400">指定工具:</span>
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

      {/* BM25 Tool Search Diagnostic Simulator */}
      <div className="p-4 rounded-xl bg-white dark:bg-zinc-900/50 border border-zinc-200/80 dark:border-zinc-800/80 shadow-xs space-y-3">
        <div className="flex items-center gap-2">
          <Search className="w-4 h-4 text-zinc-400" />
          <h3 className="text-xs font-bold text-zinc-900 dark:text-zinc-100">
            BM25 检索探针 (tools.tool_search)
          </h3>
        </div>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          模拟 ChatGPT 在 Code Mode 中调用{" "}
          <code>tools.tool_search(&#123; query &#125;)</code>{" "}
          时返回的命中工具与说明。
        </p>

        <form onSubmit={handleTestSearch} className="flex gap-2">
          <input
            type="text"
            placeholder="输入检索词（例如: database, search, query, git, file...）"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="flex-1 px-3 py-1.5 text-xs bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-lg text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 focus:outline-none focus:border-zinc-400 dark:focus:border-zinc-600 focus:ring-1 focus:ring-zinc-400 dark:focus:ring-zinc-600 transition-colors"
          />
          <button
            type="submit"
            disabled={isSearching || !searchQuery.trim()}
            className="px-3.5 py-1.5 bg-zinc-900 hover:bg-zinc-800 text-white dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200 rounded-lg text-xs font-medium transition-colors disabled:opacity-50 cursor-pointer"
          >
            {isSearching ? "检索中..." : "执行检索"}
          </button>
        </form>

        {searchResult !== null && (
          <div className="mt-3 space-y-1.5">
            <span className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider">
              检索命中结果:
            </span>
            <CodeBlock
              code={JSON.stringify(searchResult, null, 2) ?? "null"}
              language="json"
              maxHeight="max-h-64"
            />
          </div>
        )}
      </div>

      {/* Available Tools Snapshot */}
      <div className="p-4 rounded-xl bg-white dark:bg-zinc-900/50 border border-zinc-200/80 dark:border-zinc-800/80 shadow-xs space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Wrench className="w-4 h-4 text-zinc-400" />
            <h3 className="text-xs font-bold text-zinc-900 dark:text-zinc-100">
              已加载的下游工具（下一次 exec 的目录）
            </h3>
          </div>
          <span className="text-xs font-mono text-zinc-400">
            {data?.tools.length ?? 0} 个可调用工具
          </span>
        </div>

        <div className="divide-y divide-zinc-100 dark:divide-zinc-800/60">
          {!data || data.tools.length === 0 ? (
            <div className="py-6 text-center text-zinc-400 text-xs">
              当前没有下游工具；请检查启用的服务是否提供工具，以及 enabled_tools
              的目录选择。
            </div>
          ) : (
            data.tools.map((t) => (
              <div key={t.name} className="py-2.5 flex flex-col gap-1">
                <div
                  onClick={() =>
                    setSelectedTool(selectedTool === t.name ? null : t.name)
                  }
                  className="flex items-center justify-between cursor-pointer group"
                >
                  <span className="font-mono text-xs font-bold text-zinc-800 dark:text-zinc-200 group-hover:underline">
                    tools.{t.name}
                  </span>
                  <ChevronRight
                    className={`w-3.5 h-3.5 text-zinc-400 transition-transform ${
                      selectedTool === t.name ? "rotate-90" : ""
                    }`}
                  />
                </div>
                <p className="text-xs text-zinc-600 dark:text-zinc-400">
                  {t.description}
                </p>
                {selectedTool === t.name && t.inputSchema && (
                  <div className="mt-2">
                    <CodeBlock
                      code={JSON.stringify(t.inputSchema, null, 2)}
                      language="json"
                      maxHeight="max-h-48"
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

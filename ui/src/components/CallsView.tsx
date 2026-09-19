import { useState } from "react";
import { CallRecord, PaginatedResult } from "../types";
import { CallDetailModal } from "./CallDetailModal";
import {
  Search,
  CheckCircle2,
  AlertCircle,
  Loader2,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  Layers,
  Trash2,
} from "lucide-react";

interface CallsViewProps {
  callsData: PaginatedResult<CallRecord> | null;
  onPageChange: (page: number) => void;
  onFilterChange: (filters: {
    status?: string;
    tool?: string;
    search?: string;
    sessionId?: string;
  }) => void;
  onClearHistory: () => Promise<void>;
  selectedSessionId?: string;
  onSelectSession?: (id?: string) => void;
}

export function CallsView({
  callsData,
  onPageChange,
  onFilterChange,
  onClearHistory,
  selectedSessionId,
  onSelectSession,
}: CallsViewProps) {
  const [selectedCall, setSelectedCall] = useState<CallRecord | null>(null);
  const [searchInput, setSearchInput] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [toolFilter, setToolFilter] = useState("all");

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onFilterChange({
      search: searchInput,
      status: statusFilter,
      tool: toolFilter,
      sessionId: selectedSessionId,
    });
  };

  const handleStatusChange = (val: string) => {
    setStatusFilter(val);
    onFilterChange({
      search: searchInput,
      status: val,
      tool: toolFilter,
      sessionId: selectedSessionId,
    });
  };

  const handleToolChange = (val: string) => {
    setToolFilter(val);
    onFilterChange({
      search: searchInput,
      status: statusFilter,
      tool: val,
      sessionId: selectedSessionId,
    });
  };

  return (
    <div className="space-y-3.5">
      {/* Search & Filter Bar */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2.5 p-3 rounded-xl bg-white dark:bg-zinc-900/60 border border-zinc-200/80 dark:border-zinc-800/80 shadow-xs">
        <form onSubmit={handleSearchSubmit} className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400" />
          <input
            type="text"
            placeholder="搜索调用 ID、源代码关键词、执行命令、报错..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="w-full pl-9 pr-3 py-1.5 text-xs bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-lg text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 focus:outline-none focus:border-zinc-400 dark:focus:border-zinc-600 focus:ring-1 focus:ring-zinc-400 dark:focus:ring-zinc-600 transition-colors"
          />
        </form>

        <div className="flex items-center gap-2 shrink-0">
          {selectedSessionId && (
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-mono bg-zinc-100 dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200 border border-zinc-300/80 dark:border-zinc-700 whitespace-nowrap">
              <Layers className="w-3.5 h-3.5" />
              <span>{selectedSessionId}</span>
              <button
                onClick={() => onSelectSession?.(undefined)}
                className="hover:text-zinc-900 dark:hover:text-white ml-0.5 font-bold cursor-pointer"
                title="清除筛选"
              >
                ×
              </button>
            </div>
          )}

          <select
            value={statusFilter}
            onChange={(e) => handleStatusChange(e.target.value)}
            className="text-xs bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-lg px-2.5 py-1.5 text-zinc-700 dark:text-zinc-300 focus:outline-none cursor-pointer"
          >
            <option value="all">所有状态</option>
            <option value="completed">已完成</option>
            <option value="running">运行中</option>
            <option value="error">错误</option>
          </select>

          <select
            value={toolFilter}
            onChange={(e) => handleToolChange(e.target.value)}
            className="text-xs bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-lg px-2.5 py-1.5 text-zinc-700 dark:text-zinc-300 focus:outline-none cursor-pointer"
          >
            <option value="all">所有入口</option>
            <option value="exec">exec</option>
            <option value="wait">wait</option>
          </select>

          <button
            onClick={onClearHistory}
            className="p-1.5 text-zinc-400 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-lg transition-colors cursor-pointer"
            title="清空历史"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Calls Table */}
      <div className="overflow-hidden rounded-xl bg-white dark:bg-zinc-900/60 border border-zinc-200/80 dark:border-zinc-800/80 shadow-xs">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-zinc-200 dark:border-zinc-800/80 bg-zinc-50/70 dark:bg-zinc-950/60 text-zinc-500 dark:text-zinc-400 font-medium whitespace-nowrap">
                <th className="py-2.5 px-3.5 font-medium">状态 / 入口</th>
                <th className="py-2.5 px-3.5 font-medium">
                  摘要预览 / 源码首行
                </th>
                <th className="py-2.5 px-3.5 font-medium">会话 (Session)</th>
                <th className="py-2.5 px-3.5 font-medium">子调用</th>
                <th className="py-2.5 px-3.5 font-medium">耗时</th>
                <th className="py-2.5 px-3.5 font-medium">发生时间</th>
                <th className="py-2.5 px-3.5 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800/60 font-mono">
              {!callsData || callsData.items.length === 0 ? (
                <tr>
                  <td
                    colSpan={7}
                    className="py-12 text-center text-zinc-400 dark:text-zinc-500 font-sans"
                  >
                    暂无匹配的调用记录。当 ChatGPT 发起 MCP
                    调用时，将在此处实时刷新。
                  </td>
                </tr>
              ) : (
                callsData.items.map((call) => (
                  <tr
                    key={call.id}
                    onClick={() => setSelectedCall(call)}
                    className="hover:bg-zinc-50/80 dark:hover:bg-zinc-800/40 transition-colors cursor-pointer group"
                  >
                    <td className="py-2.5 px-3.5 whitespace-nowrap">
                      <div className="flex items-center gap-1.5">
                        <StatusIcon status={call.status} />
                        <span className="px-1.5 py-0.2 rounded text-[10px] font-bold uppercase font-mono bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 border border-zinc-200 dark:border-zinc-700">
                          {call.tool}
                        </span>
                      </div>
                    </td>
                    <td className="py-2.5 px-3.5 max-w-xs sm:max-w-md truncate text-zinc-800 dark:text-zinc-200 font-mono text-[11px]">
                      {call.tool === "exec" ? (
                        call.args.source ? (
                          <span className="truncate block">
                            {call.args.source.split("\n")[0]?.trim()}
                          </span>
                        ) : (
                          <span className="text-zinc-400 italic">
                            （无代码输入）
                          </span>
                        )
                      ) : (
                        <span>wait({call.args.cell_id})</span>
                      )}
                    </td>
                    <td className="py-2.5 px-3.5 whitespace-nowrap text-zinc-500 dark:text-zinc-400 text-[11px]">
                      <span
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelectSession?.(call.sessionId);
                        }}
                        className="hover:underline hover:text-zinc-900 dark:hover:text-zinc-100"
                      >
                        {call.sessionId}
                      </span>
                    </td>
                    <td className="py-2.5 px-3.5 whitespace-nowrap text-zinc-600 dark:text-zinc-300">
                      {call.subcalls.length > 0 ? (
                        <span className="px-1.5 py-0.2 rounded bg-zinc-100 dark:bg-zinc-800 text-[10px] font-mono text-zinc-600 dark:text-zinc-400 border border-zinc-200/60 dark:border-zinc-700/60">
                          {call.subcalls.length} 次
                        </span>
                      ) : (
                        <span className="text-zinc-400">-</span>
                      )}
                    </td>
                    <td className="py-2.5 px-3.5 whitespace-nowrap text-zinc-500 text-[11px]">
                      {call.durationMs !== undefined
                        ? `${call.durationMs}ms`
                        : "..."}
                    </td>
                    <td className="py-2.5 px-3.5 whitespace-nowrap text-zinc-400 text-[11px]">
                      {new Date(call.startedAt).toLocaleTimeString("zh-CN")}
                    </td>
                    <td className="py-2.5 px-3.5 text-right whitespace-nowrap">
                      <span className="text-zinc-500 group-hover:text-zinc-900 dark:group-hover:text-zinc-100 group-hover:underline text-[11px] font-sans">
                        详情 →
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination Bar */}
        {callsData && callsData.totalPages > 1 && (
          <div className="flex items-center justify-between px-3.5 py-2.5 border-t border-zinc-200 dark:border-zinc-800/80 bg-zinc-50/50 dark:bg-zinc-950/40 text-xs text-zinc-500">
            <div>
              共 {callsData.total} 条，当前第 {callsData.page} /{" "}
              {callsData.totalPages} 页
            </div>
            <div className="flex items-center gap-1.5">
              <button
                disabled={callsData.page <= 1}
                onClick={() => onPageChange(callsData.page - 1)}
                className="p-1 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 disabled:opacity-40 disabled:pointer-events-none cursor-pointer"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
              </button>
              <button
                disabled={callsData.page >= callsData.totalPages}
                onClick={() => onPageChange(callsData.page + 1)}
                className="p-1 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 disabled:opacity-40 disabled:pointer-events-none cursor-pointer"
              >
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}
      </div>

      {selectedCall && (
        <CallDetailModal
          call={selectedCall}
          onClose={() => setSelectedCall(null)}
        />
      )}
    </div>
  );
}

function StatusIcon({ status }: { status: CallRecord["status"] }) {
  if (status === "running") {
    return <Loader2 className="w-3.5 h-3.5 text-amber-500 animate-spin" />;
  }
  if (status === "completed") {
    return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />;
  }
  if (status === "yielding") {
    return <ArrowRight className="w-3.5 h-3.5 text-zinc-400" />;
  }
  return <AlertCircle className="w-3.5 h-3.5 text-rose-500" />;
}

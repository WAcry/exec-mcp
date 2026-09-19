import { RotateCw } from "lucide-react";
import { useManagement } from "../context/ManagementContext";

export function RuntimeControl() {
  const { data, busy, error, restart } = useManagement();
  if (!data?.available) return null;
  return (
    <section className="mb-4 flex flex-col gap-2 rounded-xl border border-zinc-200 bg-white px-4 py-3 text-xs dark:border-zinc-800 dark:bg-zinc-900/50">
      <div className="flex items-center justify-between gap-3">
        <div className="text-zinc-500">
          <span
            className={
              data.pending
                ? "font-medium text-amber-700 dark:text-amber-400"
                : ""
            }
          >
            {data.state === "restarting"
              ? "正在重新加载执行服务…"
              : data.pending
                ? "配置已保存，重启后生效"
                : "运行配置已生效"}
          </span>
          <span className="ml-3 hidden sm:inline">
            重启将清空临时会话、终端和内存，重新加载 MCP / Skills。
          </span>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => void restart()}
          title="停止当前执行并重新加载配置；会话存储、终端及导出链接会失效"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-zinc-200 px-3 py-1.5 font-medium hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
        >
          <RotateCw
            className={`h-3.5 w-3.5 ${data.state === "restarting" ? "animate-spin" : ""}`}
          />
          {data.state === "restarting" ? "重启中" : "重启执行服务"}
        </button>
      </div>
      {(error || data.error) && (
        <p
          role="alert"
          className="break-words text-rose-600 dark:text-rose-400"
        >
          {error || data.error} 修正后可再次重启。
        </p>
      )}
      {data.settings?.web === false && data.pending && (
        <p className="text-amber-700 dark:text-amber-400">
          本次重启将关闭 Web UI；再次启用需编辑配置并从终端启动。
        </p>
      )}
    </section>
  );
}

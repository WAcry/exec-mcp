import { Bell, BellOff } from "lucide-react";
import type { useQuestionNotifications } from "../lib/use-question-notifications";

const messages = {
  default: "允许后，新问题到达时通过浏览器提醒。",
  enabled: "已启用。点击通知可打开对应会话的问题。",
  paused: "已暂停此浏览器的提问通知。",
  denied: "浏览器已禁止通知；可在地址栏的网站权限中改为允许。",
  insecure:
    "当前地址不支持系统通知；请在本机 localhost/127.0.0.1 或 HTTPS 下使用。",
  unsupported: "此浏览器不支持页面系统通知，仍可查看页面待答提示。",
  error: "通知未能显示；请检查浏览器及系统通知设置后重试。",
};

export function QuestionNotificationControl({
  notifications,
}: {
  notifications: ReturnType<typeof useQuestionNotifications>;
}) {
  const { state, requesting, enable, pause, test } = notifications;
  const enabled = state === "enabled";
  const available = !["denied", "unsupported", "insecure"].includes(state);
  return (
    <details className="relative">
      <summary
        aria-label="提问系统通知"
        title="提问系统通知"
        className="list-none [&::-webkit-details-marker]:hidden cursor-pointer p-1.5 rounded-md text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
      >
        {enabled ? (
          <Bell className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
        ) : (
          <BellOff className="w-4 h-4" />
        )}
      </summary>
      <div className="absolute right-0 top-full mt-2 w-64 max-w-[85vw] rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-3 shadow-xl space-y-3 text-xs text-zinc-700 dark:text-zinc-300">
        <h2 className="font-semibold">提问系统通知</h2>
        <p role="status">{messages[state]}</p>
        <div className="flex gap-2">
          {available && (
            <button
              disabled={requesting}
              onClick={() => (enabled ? pause() : void enable())}
              className="px-2.5 py-1.5 rounded-md bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 disabled:opacity-50 cursor-pointer"
            >
              {requesting
                ? "等待授权…"
                : enabled
                  ? "暂停通知"
                  : state === "error"
                    ? "重试通知"
                    : "启用通知"}
            </button>
          )}
          {enabled && (
            <button
              onClick={test}
              className="px-2.5 py-1.5 rounded-md border border-zinc-200 dark:border-zinc-700 cursor-pointer"
            >
              测试通知
            </button>
          )}
        </div>
        <p className="text-[11px] leading-relaxed text-zinc-500">
          保持页面打开并连接。通知仅显示会话标识和数量，不显示题目或答复。关闭网页后不提供后台推送；系统勿扰模式可能隐藏提醒。
        </p>
      </div>
    </details>
  );
}

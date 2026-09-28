import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useLive, useLiveEvents } from "../../context/LiveContext";
import { useLocale } from "../../context/LocaleContext";
import { useTheme } from "../../context/ThemeContext";
import { plainMessage } from "../../lib/format";
import type { Navigate, Route } from "../../lib/router";
import { conversationTint } from "../../lib/sigil";
import type { SessionSummary } from "../../types";
import { Sigil } from "../ui/Sigil";

const VISIBLE_MS = 15_000;

interface Toast {
  key: string;
  sessionId: string;
}

function MessageToast({
  toast,
  summary,
  onOpen,
  onClose,
}: {
  toast: Toast;
  summary: SessionSummary | undefined;
  onOpen(): void;
  onClose(): void;
}) {
  const { t } = useLocale();
  const { resolvedTheme } = useTheme();
  const tint = conversationTint(toast.sessionId, resolvedTheme === "dark");
  const hovered = useRef(false);
  const close = useRef(onClose);
  close.current = onClose;
  // Time only counts while someone can see it, so a message that arrives
  // while the tab is in the background is still there on return.
  useEffect(() => {
    let shown = 0;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible" || hovered.current) return;
      shown += 1000;
      if (shown >= VISIBLE_MS) close.current();
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <div
      role="status"
      onMouseEnter={() => (hovered.current = true)}
      onMouseLeave={() => (hovered.current = false)}
      className="rise-in pointer-events-auto rounded-2xl border bg-surface p-3 shadow-(--pop-shadow)"
      style={{ borderColor: tint.border }}
    >
      <div className="flex items-start gap-2.5">
        <Sigil id={toast.sessionId} size={22} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs">
            <span className="font-semibold" style={{ color: tint.accent }}>
              ChatGPT
            </span>
            <span className="text-ink-3">
              {" · "}
              {summary?.label || t("conversation.untitled")}
            </span>
          </p>
          <p className="mt-0.5 line-clamp-3 text-sm text-ink [overflow-wrap:anywhere]">
            {plainMessage(summary?.messagePreview ?? "") ||
              t("agentMessage.label")}
          </p>
          <button
            type="button"
            onClick={onOpen}
            className="mt-2 rounded-md bg-ink px-2.5 py-1 text-xs font-medium text-bg hover:bg-[color-mix(in_srgb,var(--ink)_86%,var(--bg))]"
          >
            {t("agentMessage.view")}
          </button>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("common.close")}
          className="-mt-0.5 -mr-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-3 hover:bg-hover hover:text-ink"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

/** New messages surface wherever the operator is, unless that conversation is already open. */
export function MessageToasts({
  route,
  navigate,
}: {
  route: Route;
  navigate: Navigate;
}) {
  const live = useLive();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const current = useRef(route);
  current.current = route;
  useLiveEvents((event) => {
    if (event.type !== "session:notes" || !event.agentMessage) return;
    const open = current.current;
    if (
      open.name === "conversation" &&
      open.id === event.sessionId &&
      document.visibilityState === "visible"
    )
      return;
    const toast = { key: event.agentMessage.id, sessionId: event.sessionId };
    setToasts((previous) =>
      [
        toast,
        ...previous.filter((item) => item.sessionId !== event.sessionId),
      ].slice(0, 3),
    );
  });
  useEffect(() => {
    setToasts((previous) =>
      previous.filter((toast) => {
        const open =
          route.name === "conversation" && route.id === toast.sessionId;
        const summary = live.sessions?.find(
          (item) => item.id === toast.sessionId,
        );
        return !open && (!summary || (summary.unreadMessages ?? 0) > 0);
      }),
    );
  }, [route, live.sessions]);
  if (!toasts.length) return null;
  return (
    <div className="pointer-events-none fixed top-15 right-3 z-50 flex w-[min(360px,calc(100vw-24px))] flex-col gap-2">
      {toasts.map((toast) => (
        <MessageToast
          key={toast.key}
          toast={toast}
          summary={live.sessions?.find((item) => item.id === toast.sessionId)}
          onOpen={() => navigate({ name: "conversation", id: toast.sessionId })}
          onClose={() =>
            setToasts((previous) =>
              previous.filter((item) => item.key !== toast.key),
            )
          }
        />
      ))}
    </div>
  );
}

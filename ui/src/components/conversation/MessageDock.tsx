import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { AgentMessage } from "../../../../src/session-notes-types";
import { useLocale } from "../../context/LocaleContext";
import { useTheme } from "../../context/ThemeContext";
import { formatAgo, plainMessage } from "../../lib/format";
import { plural } from "../../lib/locale";
import { conversationTint } from "../../lib/sigil";
import { useNow } from "../../lib/use-now";
import { Button } from "../ui/Controls";
import { MessageText } from "../ui/MessageText";
import { Sigil } from "../ui/Sigil";

/** Unread messages stay pinned above the composer until the operator dismisses them. */
export function MessageDock({
  sessionId,
  messages,
  yieldToQuestion,
  onRead,
  onLocate,
}: {
  sessionId: string;
  /** Unread messages, oldest first. */
  messages: AgentMessage[];
  /** A pending question needs the space; start as a single line. */
  yieldToQuestion: boolean;
  onRead(ids: string[]): void;
  onLocate(message: AgentMessage): void;
}) {
  const { t } = useLocale();
  const { resolvedTheme } = useTheme();
  const now = useNow(30_000);
  const tint = conversationTint(sessionId, resolvedTheme === "dark");
  const newest = messages.at(-1)?.id;
  const [index, setIndex] = useState(0);
  const [collapsed, setCollapsed] = useState(yieldToQuestion);
  useEffect(() => {
    setIndex(0);
    setCollapsed(yieldToQuestion);
  }, [newest, yieldToQuestion]);
  if (!messages.length) return null;
  const ordered = [...messages].reverse();
  const position = Math.min(index, ordered.length - 1);
  const current = ordered[position]!;
  const count = plural(
    t,
    messages.length,
    "agentMessage.unreadOne",
    "agentMessage.unreadMany",
  );

  if (collapsed)
    return (
      <button
        type="button"
        onClick={() => setCollapsed(false)}
        aria-expanded={false}
        className="rise-in flex w-full min-w-0 items-center gap-2 rounded-2xl border bg-surface px-4 py-2.5 text-left text-sm shadow-(--dock-shadow) transition-colors hover:bg-hover"
        style={{ borderColor: tint.border }}
      >
        <Sigil id={sessionId} size={14} />
        <span className="shrink-0 font-medium" style={{ color: tint.accent }}>
          ChatGPT
        </span>
        <span className="min-w-0 flex-1 truncate text-ink-2">
          {plainMessage(current.text)}
        </span>
        <span className="shrink-0 text-2xs tabular text-run">{count}</span>
        <ChevronUp className="h-4 w-4 shrink-0 text-ink-3" />
      </button>
    );

  return (
    <section
      aria-label={t("agentMessage.dock")}
      className="rise-in rounded-2xl border px-4 pt-3 pb-3 shadow-(--dock-shadow)"
      style={{
        borderColor: tint.border,
        backgroundImage: `linear-gradient(${tint.wash}, ${tint.wash})`,
        backgroundColor: "var(--surface)",
      }}
    >
      <div className="flex items-center gap-2 text-xs">
        <Sigil id={sessionId} size={14} />
        <span className="font-semibold" style={{ color: tint.accent }}>
          ChatGPT
        </span>
        <span className="text-ink-2">{t("agentMessage.sent")}</span>
        <span className="text-ink-3">
          · {formatAgo(now - new Date(current.createdAt).getTime(), t)}
        </span>
        <span className="ml-auto" />
        {ordered.length > 1 && (
          <span className="flex items-center gap-1 tabular text-ink-3">
            <button
              type="button"
              aria-label={t("agentMessage.newer")}
              disabled={position === 0}
              onClick={() => setIndex(Math.max(0, position - 1))}
              className="flex h-6 w-6 items-center justify-center rounded-md hover:bg-hover hover:text-ink disabled:opacity-30"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            {t("dock.position", position + 1, ordered.length)}
            <button
              type="button"
              aria-label={t("agentMessage.older")}
              disabled={position >= ordered.length - 1}
              onClick={() =>
                setIndex(Math.min(ordered.length - 1, position + 1))
              }
              className="flex h-6 w-6 items-center justify-center rounded-md hover:bg-hover hover:text-ink disabled:opacity-30"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </span>
        )}
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          aria-label={t("agentMessage.collapse")}
          title={t("agentMessage.collapse")}
          className="-mr-1.5 flex h-6 w-6 items-center justify-center rounded-md text-ink-3 hover:bg-hover hover:text-ink"
        >
          <ChevronDown className="h-4 w-4" />
        </button>
      </div>
      <div className="mt-1.5 max-h-44 overflow-y-auto text-base leading-relaxed text-ink scroll-thin">
        <MessageText text={current.text} />
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => onLocate(current)}
          className="rounded-md px-1.5 py-1 text-2xs text-ink-3 hover:bg-hover hover:text-ink"
        >
          {t("agentMessage.locate")}
        </button>
        <span className="flex-1" />
        {ordered.length > 1 && (
          <Button
            size="sm"
            tone="ghost"
            onClick={() => onRead(messages.map((message) => message.id))}
          >
            {t("agentMessage.dismissAll")}
          </Button>
        )}
        <Button size="sm" tone="primary" onClick={() => onRead([current.id])}>
          <Check className="h-3.5 w-3.5" strokeWidth={2.4} />
          {t("agentMessage.dismiss")}
        </Button>
      </div>
    </section>
  );
}

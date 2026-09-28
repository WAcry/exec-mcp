import { Check } from "lucide-react";
import type { AgentMessage } from "../../../../src/session-notes-types";
import { useLocale } from "../../context/LocaleContext";
import { useTheme } from "../../context/ThemeContext";
import { clockTime, fullTime } from "../../lib/format";
import { conversationTint } from "../../lib/sigil";
import { CopyButton } from "../ui/CopyButton";
import { MessageText } from "../ui/MessageText";
import { Sigil } from "../ui/Sigil";

/** ChatGPT speaking to the operator: left-aligned, in the conversation's color. */
export function AgentMessageEntry({
  message,
  sessionId,
  attached = false,
  onRead,
}: {
  message: AgentMessage;
  sessionId: string;
  /** Rendered under the call that sent it, which already marks the time. */
  attached?: boolean;
  onRead(ids: string[]): void;
}) {
  const { t, locale } = useLocale();
  const { resolvedTheme } = useTheme();
  const tint = conversationTint(sessionId, resolvedTheme === "dark");
  const unread = !message.readAt;
  return (
    <article
      id={`message-${message.id}`}
      data-agent-message={message.id}
      aria-label={t("agentMessage.label")}
      className={`grid grid-cols-[48px_20px_minmax(0,1fr)] gap-x-2 rounded-lg px-2 ${attached ? "pb-2" : "py-2"}`}
    >
      {attached ? (
        <>
          <span />
          <span />
        </>
      ) : (
        <>
          <time
            dateTime={message.createdAt}
            title={fullTime(message.createdAt, locale)}
            className="pt-3 text-right text-2xs tabular text-ink-3"
          >
            {clockTime(message.createdAt, locale)}
          </time>
          <span className="relative z-10 flex h-11 items-center justify-center">
            <span className="rounded-full bg-bg p-[2px]">
              <Sigil id={sessionId} size={16} />
            </span>
          </span>
        </>
      )}
      <div
        className="min-w-0 max-w-[44rem] rounded-2xl rounded-tl-md border px-4 py-3"
        style={{ borderColor: tint.border, backgroundColor: tint.wash }}
      >
        <div className="flex items-center gap-2 text-2xs">
          <span className="font-semibold" style={{ color: tint.accent }}>
            ChatGPT
          </span>
          {!attached && (
            <span className="text-ink-3">{t("agentMessage.sent")}</span>
          )}
          {attached && (
            <time
              dateTime={message.createdAt}
              title={fullTime(message.createdAt, locale)}
              className="tabular text-ink-3"
            >
              · {clockTime(message.createdAt, locale)}
            </time>
          )}
          {unread && (
            <span className="ml-auto flex items-center gap-1 font-medium text-run">
              <span className="h-1.5 w-1.5 rounded-full bg-run" />
              {t("agentMessage.unread")}
            </span>
          )}
        </div>
        <div className="mt-1 max-h-[28rem] overflow-y-auto text-base leading-relaxed text-ink scroll-thin">
          <MessageText text={message.text} />
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1 text-2xs text-ink-3">
          <CopyButton
            text={message.text}
            label={t("agentMessage.copy")}
            className="h-6 w-6"
          />
          {unread && (
            <button
              type="button"
              onClick={() => onRead([message.id])}
              className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-1 font-medium text-ink-2 hover:bg-hover hover:text-ink"
            >
              <Check className="h-3 w-3" strokeWidth={2.4} />
              {t("agentMessage.dismiss")}
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

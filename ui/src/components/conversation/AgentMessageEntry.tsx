import { CornerDownLeft, MessageSquare } from "lucide-react";
import type { AgentMessage } from "../../../../src/session-notes-types";
import { useLocale } from "../../context/LocaleContext";
import { clockTime, fullTime } from "../../lib/format";
import { CopyButton } from "../ui/CopyButton";

/** Plain text from ChatGPT, kept separate from the operator's message bubbles. */
export function AgentMessageEntry({
  message,
  onLocate,
}: {
  message: AgentMessage;
  onLocate?: ((id: string) => void) | undefined;
}) {
  const { t, locale } = useLocale();
  return (
    <article
      data-agent-message={message.id}
      aria-label={t("agentMessage.label")}
      className="rise-in grid grid-cols-[48px_20px_minmax(0,1fr)] gap-x-2 px-2 py-3"
    >
      <time
        dateTime={message.createdAt}
        title={fullTime(message.createdAt, locale)}
        className="pt-0.5 text-right text-2xs tabular text-ink-3"
      >
        {clockTime(message.createdAt, locale)}
      </time>
      <span className="relative z-10 flex h-5 items-center justify-center bg-bg text-ink-2">
        <MessageSquare className="h-3.5 w-3.5" strokeWidth={1.8} />
      </span>
      <div className="min-w-0 max-w-3xl pl-1">
        <div className="mb-1.5 text-xs font-medium text-ink-2">ChatGPT</div>
        <div className="max-h-[32rem] overflow-y-auto text-base leading-relaxed whitespace-pre-wrap text-ink [overflow-wrap:anywhere] scroll-thin">
          {message.text}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-2xs text-ink-3">
          <button
            type="button"
            onClick={() =>
              window.dispatchEvent(new Event("exec:focus-composer"))
            }
            className="inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-hover hover:text-ink"
          >
            <CornerDownLeft className="h-3 w-3" />
            {t("agentMessage.reply")}
          </button>
          <CopyButton
            text={message.text}
            label={t("note.copy")}
            className="h-5 w-5"
          />
          {message.callId && onLocate && (
            <button
              type="button"
              onClick={() => onLocate(message.callId!)}
              className="rounded px-1 py-0.5 hover:bg-hover hover:text-ink"
            >
              {t("agentMessage.source")}
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

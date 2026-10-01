import { Check, Clock3, Undo2 } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import type { SessionNote } from "../../../../src/session-notes-types";
import { useLocale } from "../../context/LocaleContext";
import { apiFetch } from "../../lib/api";
import { errorText } from "../../lib/errors";
import { clockTime, fullTime } from "../../lib/format";
import { CopyButton } from "../ui/CopyButton";

export interface Flight {
  id: string;
  rect: DOMRect;
}

/** A just-sent note glides from the composer into its place in the timeline. */
function useFlight(
  element: React.RefObject<HTMLElement | null>,
  id: string,
  flight: Flight | null,
  landed: (id: string) => void,
) {
  useLayoutEffect(() => {
    const node = element.current;
    if (!node || flight?.id !== id) return;
    landed(id);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    // Bubbles are right-aligned, so the message rises from the composer's send side.
    const target = node.getBoundingClientRect();
    const dx = Math.min(0, flight.rect.right - 40 - target.right);
    const dy = flight.rect.top - target.top;
    node.style.transformOrigin = "100% 100%";
    node.animate(
      [
        {
          transform: `translate(${dx}px, ${dy}px) scale(0.92)`,
          opacity: 0,
        },
        { opacity: 1, offset: 0.35 },
        { transform: "none", opacity: 1 },
      ],
      { duration: 460, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
    );
  }, [element, id, flight, landed]);
}

export function NoteEntry({
  note,
  sessionId,
  carrierTime,
  highlighted,
  flight,
  onLanded,
  onLocate,
  onHover,
  onChanged,
}: {
  note: SessionNote;
  sessionId: string;
  carrierTime?: string | undefined;
  highlighted: boolean;
  flight: Flight | null;
  onLanded(id: string): void;
  onLocate(callId: string): void;
  onHover(key: string | null): void;
  onChanged(): void;
}) {
  const { t, locale } = useLocale();
  const bubble = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useFlight(bubble, note.id, flight, onLanded);
  const withdrawn = note.status === "withdrawn";
  const withdraw = async () => {
    setBusy(true);
    setError("");
    try {
      await apiFetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/notes/${encodeURIComponent(note.id)}`,
        { method: "DELETE" },
      );
    } catch (caught) {
      setError(errorText(caught, t));
    } finally {
      setBusy(false);
      onChanged();
    }
  };
  return (
    <div
      className="grid grid-cols-[48px_20px_minmax(0,1fr)] gap-x-2 px-2 py-2"
      onMouseEnter={() => note.callId && onHover(`call:${note.callId}`)}
      onMouseLeave={() => onHover(null)}
    >
      <time
        dateTime={note.createdAt}
        title={fullTime(note.createdAt, locale)}
        className="pt-2 text-right tabular text-2xs text-ink-3"
      >
        {clockTime(note.createdAt, locale)}
      </time>
      <span className="relative z-10 flex h-9 items-center justify-center">
        <span className="rounded-full bg-bg p-[3px]">
          <span className="block h-2 w-2 rounded-full border-[1.5px] border-ink-2" />
        </span>
      </span>
      <div className="group/note flex min-w-0 flex-col items-end">
        <div
          ref={bubble}
          className={`max-w-[min(38rem,86%)] rounded-2xl rounded-br-md px-3.5 py-2 text-base whitespace-pre-wrap [overflow-wrap:anywhere] transition-shadow duration-200 ${withdrawn ? "bg-hover text-ink-3 line-through decoration-ink-4" : "bg-you text-you-ink"} ${highlighted ? "shadow-[0_0_0_3px_color-mix(in_srgb,var(--run)_28%,transparent)]" : ""}`}
        >
          {note.text}
        </div>
        <div className="mt-1 flex items-center gap-1 text-2xs text-ink-3">
          {note.status === "pending" && (
            <>
              <Clock3 className="h-3 w-3" strokeWidth={2} />
              <span>{t("note.queued")}</span>
              <button
                type="button"
                disabled={busy}
                onClick={() => void withdraw()}
                className="ml-1.5 inline-flex items-center gap-1 rounded px-1 py-0.5 text-ink-2 hover:bg-hover hover:text-ink"
              >
                <Undo2 className="h-3 w-3" />
                {t("note.withdraw")}
              </button>
            </>
          )}
          {note.status === "attached" && (
            <button
              type="button"
              disabled={!note.callId}
              onClick={() => note.callId && onLocate(note.callId)}
              className="inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-hover hover:text-ink"
            >
              <Check className="h-3 w-3 text-ok" strokeWidth={2.2} />
              {carrierTime
                ? t("note.deliveredWith", clockTime(carrierTime, locale))
                : t("note.delivered")}
            </button>
          )}
          {withdrawn && <span>{t("note.withdrawn")}</span>}
          <CopyButton
            text={note.text}
            label={t("note.copy")}
            className="h-5 w-5 opacity-0 group-hover/note:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
          />
        </div>
        {error && <p className="mt-1 text-2xs text-err">{error}</p>}
      </div>
    </div>
  );
}

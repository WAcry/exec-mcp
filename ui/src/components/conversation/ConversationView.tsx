import { ArrowDown } from "lucide-react";
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  AgentMessage,
  SessionNote,
} from "../../../../src/session-notes-types";
import { useLive } from "../../context/LiveContext";
import { useLocale } from "../../context/LocaleContext";
import { apiFetch } from "../../lib/api";
import { errorFeedback } from "../../lib/errors";
import {
  conversationState,
  RECENT_ACTIVITY_MS,
  UNSCOPED,
} from "../../lib/conversation";
import { dayKey, dayLabel } from "../../lib/format";
import {
  feedback,
  message as feedbackMessage,
  plural,
  type Feedback,
} from "../../lib/locale";
import type { Navigate } from "../../lib/router";
import { useCalls } from "../../lib/use-calls";
import { isTyping } from "../../lib/use-media";
import { useMessages } from "../../lib/use-messages";
import { useNow } from "../../lib/use-now";
import type { CallListItem } from "../../types";
import { Button, Loading } from "../ui/Controls";
import { AgentMessageEntry } from "./AgentMessageEntry";
import { Composer, type DeliveryOutlook } from "./Composer";
import { ConversationHeader, type TimelineFilter } from "./ConversationHeader";
import { buildEntries, buildLinks, hoverKey, type Entry } from "./entries";
import { MessageDock } from "./MessageDock";
import { NoteEntry, type Flight } from "./NoteEntry";
import { QuestionDock } from "./QuestionDock";
import { QuestionEntry } from "./QuestionEntry";
import { StepRow } from "./StepRow";

const BOTTOM_SLACK = 80;

function flash(node: HTMLElement) {
  node.scrollIntoView({ block: "center", behavior: "smooth" });
  node.classList.remove("locate");
  void node.offsetWidth;
  node.classList.add("locate");
}

export function ConversationView({
  id,
  focusCall,
  navigate,
  wide,
}: {
  id: string;
  focusCall?: string;
  navigate: Navigate;
  wide: boolean;
}) {
  const live = useLive();
  const { t, locale } = useLocale();
  const now = useNow(30_000);
  const summary = live.sessions?.find((item) => item.id === id);
  const native = live.native[id];
  const unscoped = id === UNSCOPED;
  const [filter, setFilter] = useState<TimelineFilter>("all");
  const [search, setSearch] = useState("");
  const calls = useCalls({
    sessionId: id,
    ...(filter === "error" ? { status: "error" } : {}),
    ...(search ? { search } : {}),
  });
  const messages = useMessages(unscoped ? undefined : id);
  const filtered = filter !== "all" || !!search;
  // Dismissals show immediately; the next refresh brings the server's readAt.
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const agentMessages = useMemo(
    () =>
      messages.agentMessages.map((item) =>
        !item.readAt && dismissed.has(item.id)
          ? { ...item, readAt: item.createdAt }
          : item,
      ),
    [messages.agentMessages, dismissed],
  );
  const unread = useMemo(
    () => agentMessages.filter((item) => !item.readAt),
    [agentMessages],
  );

  const entries = useMemo(
    () =>
      buildEntries(
        calls.items.values(),
        messages.notes,
        messages.questions,
        !filtered,
        agentMessages,
      ),
    [calls.items, messages.notes, messages.questions, agentMessages, filtered],
  );
  const links = useMemo(
    () => buildLinks(calls.items.values(), messages.notes),
    [calls.items, messages.notes],
  );
  const state = conversationState(
    {
      lastCall: summary?.lastCall,
      pendingQuestions: summary?.pendingQuestions ?? messages.pendingQuestions,
    },
    native,
  );

  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(focusCall ? [focusCall] : []),
  );
  const [hover, setHover] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(focusCall ?? null);
  const [flight, setFlight] = useState<Flight | null>(null);
  const [dockFocus, setDockFocus] = useState<{ id: string; at: number } | null>(
    null,
  );
  const [toast, setToast] = useState<Feedback>("");
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [unseen, setUnseen] = useState(0);
  const counted = useRef(0);
  const initialized = useRef(false);
  const prepend = useRef(0);

  const toggle = useCallback((callId: string) => {
    setActive(callId);
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(callId)) next.delete(callId);
      else next.add(callId);
      return next;
    });
  }, []);
  useEffect(() => {
    if (!focusCall) return;
    setExpanded((previous) =>
      previous.has(focusCall) ? previous : new Set(previous).add(focusCall),
    );
  }, [focusCall]);
  // The most recently opened call is linkable from the address bar.
  useEffect(() => {
    const last = [...expanded].at(-1);
    navigate(
      last
        ? { name: "conversation", id, call: last }
        : { name: "conversation", id },
      { replace: true },
    );
  }, [expanded, id, navigate]);

  const locate = useCallback((callId: string) => {
    const node = document.getElementById(`call-${callId}`);
    if (!node) return;
    flash(node);
    setActive(callId);
  }, []);

  const [seeking, setSeeking] = useState<string | null>(null);
  const locateMessage = useCallback((target: AgentMessage) => {
    const node = document.getElementById(`message-${target.id}`);
    if (node) return flash(node);
    setFilter("all");
    setSearch("");
    setSeeking(target.id);
  }, []);
  useEffect(() => {
    if (!seeking) return;
    const node = document.getElementById(`message-${seeking}`);
    if (!node) return;
    setSeeking(null);
    flash(node);
  }, [seeking, entries]);

  const scrollToBottom = useCallback((smooth: boolean) => {
    const node = scroller.current;
    if (!node) return;
    node.scrollTo({
      top: node.scrollHeight,
      behavior: smooth ? "smooth" : "auto",
    });
    setUnseen(0);
  }, []);

  const loaded = calls.loaded && (unscoped || messages.loaded);
  useLayoutEffect(() => {
    const node = scroller.current;
    if (!node || !loaded) return;
    const count = entries.length;
    if (!initialized.current) {
      initialized.current = true;
      if (focusCall && document.getElementById(`call-${focusCall}`))
        window.requestAnimationFrame(() => locate(focusCall));
      else node.scrollTop = node.scrollHeight;
    } else if (prepend.current) {
      node.scrollTop += node.scrollHeight - prepend.current;
      prepend.current = 0;
    } else if (count > counted.current) {
      if (atBottom.current) scrollToBottom(true);
      else setUnseen((value) => value + count - counted.current);
    }
    counted.current = count;
  }, [entries.length, loaded, focusCall, locate, scrollToBottom]);

  // Growing rows (a running script, an expanded detail) and docks that change
  // height keep a bottom-pinned view pinned.
  useEffect(() => {
    const node = content.current;
    const viewport = scroller.current;
    if (!node || !viewport) return;
    const observer = new ResizeObserver(() => {
      if (atBottom.current && initialized.current)
        viewport.scrollTop = viewport.scrollHeight;
    });
    observer.observe(node);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 4200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const callIds = useMemo(
    () =>
      entries.flatMap((entry) =>
        entry.kind === "call" ? [entry.call.id] : [],
      ),
    [entries],
  );
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isTyping(event.target)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "j" || event.key === "k") {
        event.preventDefault();
        const index = active ? callIds.indexOf(active) : callIds.length;
        const next =
          callIds[
            Math.max(
              0,
              Math.min(
                callIds.length - 1,
                index + (event.key === "j" ? 1 : -1),
              ),
            )
          ];
        if (next) {
          setActive(next);
          document
            .getElementById(`call-${next}`)
            ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
        }
      } else if (event.key === "Enter" && active && callIds.includes(active)) {
        const target = event.target as HTMLElement;
        if (target.closest("button, a, [role=radio], [role=button]")) return;
        event.preventDefault();
        toggle(active);
      } else if (event.key === "f") {
        event.preventDefault();
        window.dispatchEvent(new Event("exec:focus-timeline-search"));
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [active, callIds, toggle]);

  const onSent = useCallback(
    (note: SessionNote, from: DOMRect) => {
      atBottom.current = true;
      setFlight({ id: note.id, rect: from });
      messages.refresh();
      live.refresh();
    },
    [messages, live],
  );
  const landed = useCallback((noteId: string) => {
    setFlight((current) => (current?.id === noteId ? null : current));
    window.requestAnimationFrame(() => {
      const node = scroller.current;
      if (node) node.scrollTop = node.scrollHeight;
    });
  }, []);

  const recent =
    !!summary &&
    now - new Date(summary.lastActive).getTime() < RECENT_ACTIVITY_MS;
  const outlook: DeliveryOutlook =
    unscoped || (messages.loaded && !messages.available)
      ? "unavailable"
      : state.working || state.background
        ? "working"
        : recent
          ? "recent"
          : "idle";
  const processes = (live.terminals ?? []).filter(
    (item) => item.owner === id && item.exitCode === undefined,
  );
  const notesById = useMemo(
    () => new Map(messages.notes.map((note) => [note.id, note])),
    [messages.notes],
  );
  const changed = useCallback(() => {
    messages.refresh();
    live.refresh();
  }, [messages, live]);
  const readMessages = useCallback(
    async (ids: string[]) => {
      setDismissed((previous) => new Set([...previous, ...ids]));
      try {
        await apiFetch(
          `/api/sessions/${encodeURIComponent(id)}/messages/read`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ids }),
          },
        );
      } catch (error) {
        setDismissed((previous) => {
          const next = new Set(previous);
          for (const item of ids) next.delete(item);
          return next;
        });
        setToast(
          feedbackMessage("agentMessage.readFailed", errorFeedback(error)),
        );
      }
      changed();
    },
    [id, changed],
  );

  let previousDay = 0;

  return (
    <section className="flex h-full min-h-0 flex-col">
      <ConversationHeader
        id={id}
        summary={summary}
        label={messages.label || summary?.label || ""}
        editable={!unscoped && messages.available}
        state={state}
        cells={native?.activeCellCount ?? 0}
        processes={processes}
        filter={filter}
        onFilter={setFilter}
        search={search}
        onSearch={setSearch}
        wide={wide}
        onBack={() => navigate({ name: "home" })}
        onRenamed={changed}
      />
      <div
        ref={scroller}
        onScroll={(event) => {
          const node = event.currentTarget;
          atBottom.current =
            node.scrollHeight - node.scrollTop - node.clientHeight <
            BOTTOM_SLACK;
          if (atBottom.current && unseen) setUnseen(0);
        }}
        className="relative min-h-0 flex-1 overflow-y-auto scroll-thin"
      >
        <div
          ref={content}
          className="relative mx-auto max-w-[960px] px-2 pt-3 pb-8 sm:px-4"
        >
          {entries.length > 0 && (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute top-6 bottom-10 left-[82px] w-px bg-line sm:left-[90px]"
            />
          )}
          {(calls.hasEarlier || (!filtered && messages.hasEarlierNotes)) && (
            <div className="flex justify-center pb-2">
              <Button
                size="sm"
                tone="ghost"
                disabled={calls.loadingEarlier}
                onClick={() => {
                  prepend.current = scroller.current?.scrollHeight ?? 0;
                  if (calls.hasEarlier) void calls.loadEarlier();
                  if (!filtered) messages.loadEarlierNotes();
                }}
              >
                {calls.loadingEarlier
                  ? t("common.loading")
                  : !calls.hasEarlier
                    ? t("timeline.earlierMessages")
                    : plural(
                        t,
                        calls.total - calls.items.size,
                        "timeline.earlierOne",
                        "timeline.earlier",
                      )}
              </Button>
            </div>
          )}
          {!loaded ? (
            <div className="px-10">
              <Loading />
            </div>
          ) : entries.length === 0 ? (
            <p className="px-6 py-16 text-center text-sm text-ink-3">
              {filtered ? t("timeline.noMatches") : t("timeline.empty")}
            </p>
          ) : (
            entries.map((entry) => {
              const day = dayKey(entry.at);
              const separator =
                day !== previousDay ? (
                  <div className="grid grid-cols-[48px_20px_minmax(0,1fr)] gap-x-2 px-2 pt-3 pb-1">
                    <span />
                    <span className="relative z-10 flex items-center justify-center">
                      <span className="h-1.5 w-1.5 rounded-full bg-line-strong ring-4 ring-bg" />
                    </span>
                    <span className="text-2xs font-medium text-ink-3">
                      {dayLabel(entry.at, now, locale, t)}
                    </span>
                  </div>
                ) : null;
              previousDay = day;
              return (
                <Fragment key={entry.key}>
                  {separator}
                  <EntryView
                    entry={entry}
                    sessionId={id}
                    links={links}
                    notesById={notesById}
                    calls={calls.items}
                    expanded={expanded}
                    active={active}
                    hover={hover}
                    flight={flight}
                    onToggle={toggle}
                    onHover={setHover}
                    onLocate={locate}
                    onLanded={landed}
                    onAnswer={(questionId) =>
                      setDockFocus({ id: questionId, at: Date.now() })
                    }
                    onChanged={changed}
                    onReadMessages={readMessages}
                  />
                </Fragment>
              );
            })
          )}
        </div>
      </div>

      <div className="relative shrink-0 px-3 pb-3 sm:px-6 sm:pb-4">
        {unseen > 0 && (
          <div className="pointer-events-none absolute -top-12 inset-x-0 flex justify-center">
            <button
              type="button"
              onClick={() => scrollToBottom(true)}
              className="rise-in pointer-events-auto inline-flex h-8 items-center gap-1.5 rounded-full border border-line bg-surface px-3 text-xs font-medium text-ink shadow-(--pop-shadow) hover:bg-hover"
            >
              <ArrowDown className="h-3.5 w-3.5" />
              {t("timeline.newEntries", unseen)}
            </button>
          </div>
        )}
        <div className="mx-auto max-w-[920px] space-y-2">
          {toast && (
            <p
              role="status"
              className="fade-in px-1 text-center text-xs text-ink-2"
            >
              {feedback(toast, t)}
            </p>
          )}
          {!unscoped && (
            <MessageDock
              sessionId={id}
              messages={unread}
              yieldToQuestion={messages.pendingQuestions > 0}
              onRead={(ids) => void readMessages(ids)}
              onLocate={locateMessage}
            />
          )}
          {!unscoped && (
            <QuestionDock
              sessionId={id}
              questions={messages.questions}
              focusId={dockFocus}
              onSubmitted={(value) => {
                if (value) setToast(value);
                changed();
              }}
            />
          )}
          <Composer sessionId={id} outlook={outlook} onSent={onSent} />
        </div>
      </div>
    </section>
  );
}

function EntryView({
  entry,
  sessionId,
  links,
  notesById,
  calls,
  expanded,
  active,
  hover,
  flight,
  onToggle,
  onHover,
  onLocate,
  onLanded,
  onAnswer,
  onChanged,
  onReadMessages,
}: {
  entry: Entry;
  sessionId: string;
  links: ReturnType<typeof buildLinks>;
  notesById: Map<string, SessionNote>;
  calls: Map<string, CallListItem>;
  expanded: Set<string>;
  active: string | null;
  hover: string | null;
  flight: Flight | null;
  onToggle(id: string): void;
  onHover(key: string | null): void;
  onLocate(id: string): void;
  onLanded(id: string): void;
  onAnswer(id: string): void;
  onChanged(): void;
  onReadMessages(ids: string[]): Promise<void>;
}) {
  const read = (ids: string[]) => void onReadMessages(ids);
  if (entry.kind === "agent")
    return (
      <AgentMessageEntry
        message={entry.message}
        sessionId={sessionId}
        onRead={read}
      />
    );
  if (entry.kind === "call") {
    const call = entry.call;
    const carried = links.carried.get(call.id);
    const highlighted =
      !!hover && (hover === hoverKey(call) || hover === `call:${call.id}`);
    return (
      <>
        <StepRow
          call={call}
          expanded={expanded.has(call.id)}
          active={active === call.id}
          highlighted={highlighted}
          origin={links.origin.get(call.id)}
          continuations={links.continuations.get(call.id)}
          carried={carried}
          asked={entry.questions.length}
          messaged={entry.messages.length}
          onToggle={onToggle}
          onHover={onHover}
          onLocate={onLocate}
        />
        {entry.messages.map((item) => (
          <AgentMessageEntry
            key={item.id}
            attached
            message={item}
            sessionId={sessionId}
            onRead={read}
          />
        ))}
        {entry.questions.map((question) => {
          const answerNote = question.answer
            ? notesById.get(question.answer.noteId)
            : undefined;
          const carrier = answerNote?.callId
            ? calls.get(answerNote.callId)
            : undefined;
          return (
            <QuestionEntry
              key={question.id}
              attached
              question={question}
              sessionId={sessionId}
              answerNote={answerNote}
              carrierTime={carrier?.startedAt}
              onAnswer={onAnswer}
              onLocate={onLocate}
              onChanged={onChanged}
            />
          );
        })}
      </>
    );
  }
  if (entry.kind === "note") {
    const carrier = entry.note.callId
      ? calls.get(entry.note.callId)
      : undefined;
    return (
      <NoteEntry
        note={entry.note}
        sessionId={sessionId}
        carrierTime={carrier?.startedAt}
        highlighted={!!hover && hover === `call:${entry.note.callId}`}
        flight={flight}
        onLanded={onLanded}
        onLocate={onLocate}
        onHover={onHover}
        onChanged={onChanged}
      />
    );
  }
  const answerNote = entry.question.answer
    ? notesById.get(entry.question.answer.noteId)
    : undefined;
  const carrier = answerNote?.callId ? calls.get(answerNote.callId) : undefined;
  return (
    <QuestionEntry
      question={entry.question}
      sessionId={sessionId}
      answerNote={answerNote}
      carrierTime={carrier?.startedAt}
      onAnswer={onAnswer}
      onLocate={onLocate}
      onChanged={onChanged}
    />
  );
}

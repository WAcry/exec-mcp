import {
  ChevronLeft,
  Ellipsis,
  Pencil,
  Search,
  SquareTerminal,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { NOTE_LABEL_BYTES } from "../../../../src/session-notes-types";
import { useLocale } from "../../context/LocaleContext";
import { apiFetch } from "../../lib/api";
import { errorText } from "../../lib/errors";
import { plural } from "../../lib/locale";
import { UNSCOPED, type ConversationState } from "../../lib/conversation";
import { formatAgo, formatElapsed, utf8Bytes } from "../../lib/format";
import { routeHref } from "../../lib/router";
import { useNow } from "../../lib/use-now";
import type { SessionSummary, TerminalItem } from "../../types";
import { MenuItem, Popover, Segmented } from "../ui/Controls";
import { Sigil } from "../ui/Sigil";
import { Spinner } from "../ui/StatusNode";

export type TimelineFilter = "all" | "error";

function TitleEditor({
  id,
  label,
  editable,
  onRenamed,
}: {
  id: string;
  label: string;
  editable: boolean;
  onRenamed(): void;
}) {
  const { t } = useLocale();
  const [value, setValue] = useState<string | null>(null);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const editing = value !== null;
  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);
  useEffect(() => {
    const rename = () => editable && setValue(label);
    window.addEventListener("exec:rename", rename);
    return () => window.removeEventListener("exec:rename", rename);
  }, [editable, label]);
  const unscoped = id === UNSCOPED;
  const save = async () => {
    if (value === null) return;
    const next = value.trim();
    if (next === label) {
      setValue(null);
      return;
    }
    if (utf8Bytes(next) > NOTE_LABEL_BYTES) {
      setError(t("conversation.labelTooLong"));
      return;
    }
    try {
      await apiFetch(`/api/sessions/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: next }),
      });
      setValue(null);
      setError("");
      onRenamed();
    } catch (caught) {
      setError(errorText(caught, t));
    }
  };
  if (value !== null)
    return (
      <div className="min-w-0">
        <input
          ref={input}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onBlur={() => void save()}
          onKeyDown={(event) => {
            if (event.key === "Enter") void save();
            if (event.key === "Escape") {
              setValue(null);
              setError("");
            }
          }}
          placeholder={t("conversation.labelPlaceholder")}
          aria-label={t("conversation.label")}
          className="h-7 w-full max-w-md rounded-md border border-line-strong bg-surface px-2 text-md font-semibold text-ink outline-none"
        />
        {error && <p className="mt-0.5 text-2xs text-err">{error}</p>}
      </div>
    );
  const title = unscoped
    ? t("conversation.unscoped")
    : label || t("conversation.untitled");
  return (
    <button
      type="button"
      disabled={!editable}
      onClick={() => setValue(label)}
      title={editable ? t("conversation.rename") : undefined}
      className="group/title flex min-w-0 items-center gap-2 rounded-md text-left"
    >
      <h1
        className={`min-w-0 truncate text-md font-semibold ${label || unscoped ? "text-ink" : "text-ink-2"}`}
      >
        {title}
      </h1>
      {!unscoped && (
        <span className="shrink-0 font-mono text-2xs text-ink-3">
          {id.slice(0, 6)}
        </span>
      )}
      {editable && (
        <Pencil className="h-3.5 w-3.5 shrink-0 text-ink-3 opacity-0 transition-opacity group-hover/title:opacity-100 group-focus-visible/title:opacity-100" />
      )}
    </button>
  );
}

function StatusLine({
  state,
  summary,
  cells,
}: {
  state: ConversationState;
  summary: SessionSummary | undefined;
  cells: number;
}) {
  const { t } = useLocale();
  const now = useNow(state.working ? 1000 : 30_000);
  if (state.state === "asking")
    return (
      <span className="flex items-center gap-1.5 text-warn">
        <span className="h-1.5 w-1.5 rounded-full bg-warn" />
        {plural(t, state.questions, "state.askingOne", "state.asking")}
      </span>
    );
  if (state.working)
    return (
      <span className="flex items-center gap-1.5 text-ink-2">
        <Spinner size={11} className="text-run" />
        {t("state.working")}
        {summary?.lastCall?.status === "running" && (
          <span className="tabular text-run">
            {formatElapsed(
              now - new Date(summary.lastCall.timestamp).getTime(),
            )}
          </span>
        )}
      </span>
    );
  if (state.background)
    return (
      <span className="flex items-center gap-1.5 text-ink-2">
        <span className="h-2 w-2 rounded-full border-[1.5px] border-dashed border-run" />
        {cells > 1 ? t("state.backgroundCells", cells) : t("state.background")}
      </span>
    );
  return (
    <span className="flex items-center gap-1.5 text-ink-3">
      <span className="h-1.5 w-1.5 rounded-full bg-ink-4" />
      {summary
        ? t(
            "state.idleSince",
            formatAgo(now - new Date(summary.lastActive).getTime(), t),
          )
        : t("state.idle")}
    </span>
  );
}

export function ConversationHeader({
  id,
  summary,
  label,
  editable,
  state,
  cells,
  processes,
  filter,
  onFilter,
  search,
  onSearch,
  wide,
  onBack,
  onRenamed,
}: {
  id: string;
  summary: SessionSummary | undefined;
  label: string;
  editable: boolean;
  state: ConversationState;
  cells: number;
  processes: TerminalItem[];
  filter: TimelineFilter;
  onFilter(filter: TimelineFilter): void;
  search: string;
  onSearch(value: string): void;
  wide: boolean;
  onBack(): void;
  onRenamed(): void;
}) {
  const { t } = useLocale();
  const [searching, setSearching] = useState(!!search);
  const [query, setQuery] = useState(search);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => onSearch(query.trim()), 280);
    return () => window.clearTimeout(timer);
  }, [query, onSearch]);
  useEffect(() => {
    if (searching) field.current?.focus();
  }, [searching]);
  useEffect(() => {
    const focus = () => setSearching(true);
    window.addEventListener("exec:focus-timeline-search", focus);
    return () =>
      window.removeEventListener("exec:focus-timeline-search", focus);
  }, []);
  const errors = summary?.errorCount ?? 0;
  return (
    <header className="shrink-0 border-b border-line bg-bg">
      <div className="mx-auto flex max-w-[960px] items-center gap-3 px-4 py-3 sm:px-6">
        {!wide && (
          <button
            type="button"
            onClick={onBack}
            aria-label={t("common.back")}
            className="-ml-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-ink-2 hover:bg-hover"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
        )}
        <Sigil id={id} size={34} live={state.working} />
        <div className="min-w-0 flex-1">
          <TitleEditor
            id={id}
            label={label}
            editable={editable}
            onRenamed={onRenamed}
          />
          <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
            <StatusLine state={state} summary={summary} cells={cells} />
            {summary && (
              <span className="tabular text-ink-3">
                {plural(
                  t,
                  summary.callCount,
                  "conversation.call",
                  "conversation.calls",
                )}
                {errors > 0 && (
                  <>
                    {" · "}
                    <button
                      type="button"
                      onClick={() =>
                        onFilter(filter === "error" ? "all" : "error")
                      }
                      className="text-err hover:underline"
                    >
                      {t("conversation.failed", errors)}
                    </button>
                  </>
                )}
              </span>
            )}
            {processes.length > 0 && (
              <a
                href={routeHref({ name: "processes" })}
                className="flex min-w-0 items-center gap-1 text-ink-2 hover:text-ink"
                title={processes.map((item) => item.command).join("\n")}
              >
                <SquareTerminal className="h-3 w-3 shrink-0 text-run" />
                <span className="truncate">
                  {processes.length === 1
                    ? t(
                        "conversation.process",
                        processes[0]!.command ?? processes[0]!.id,
                      )
                    : t("conversation.processes", processes.length)}
                </span>
              </a>
            )}
          </div>
          {id === UNSCOPED && (
            <p className="mt-1 max-w-xl text-xs text-ink-3">
              {t("conversation.unscopedHelp")}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {searching ? (
            <label className="flex h-8 w-44 items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-2 sm:w-56">
              <Search className="h-3.5 w-3.5 shrink-0 text-ink-3" />
              <input
                ref={field}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    setQuery("");
                    setSearching(false);
                  }
                }}
                placeholder={t("conversation.search")}
                aria-label={t("conversation.search")}
                className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none"
              />
              <button
                type="button"
                aria-label={t("common.clear")}
                onClick={() => {
                  setQuery("");
                  setSearching(false);
                }}
                className="text-ink-3 hover:text-ink"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </label>
          ) : (
            <button
              type="button"
              onClick={() => setSearching(true)}
              aria-label={t("conversation.search")}
              title={t("conversation.search")}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-3 hover:bg-hover hover:text-ink"
            >
              <Search className="h-4 w-4" strokeWidth={1.8} />
            </button>
          )}
          {wide && (
            <Segmented
              label={t("conversation.filter")}
              value={filter}
              onChange={onFilter}
              options={[
                { value: "all", label: t("conversation.filterAll") },
                { value: "error", label: t("conversation.filterErrors") },
              ]}
            />
          )}
          <Popover
            label={t("common.more")}
            align="end"
            panelClassName="w-56"
            trigger={({ toggle, ref, open, id: panel }) => (
              <button
                ref={ref}
                type="button"
                onClick={toggle}
                aria-expanded={open}
                aria-controls={panel}
                aria-label={t("common.more")}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-3 hover:bg-hover hover:text-ink"
              >
                <Ellipsis className="h-4 w-4" />
              </button>
            )}
          >
            {(close) => (
              <>
                {editable && (
                  <MenuItem
                    onSelect={() => {
                      close();
                      window.dispatchEvent(new Event("exec:rename"));
                    }}
                  >
                    {t("conversation.rename")}
                  </MenuItem>
                )}
                {!wide && (
                  <MenuItem
                    onSelect={() => {
                      close();
                      onFilter(filter === "error" ? "all" : "error");
                    }}
                  >
                    {filter === "error"
                      ? t("conversation.filterAll")
                      : t("conversation.filterErrors")}
                  </MenuItem>
                )}
                <MenuItem
                  onSelect={() => {
                    close();
                    void navigator.clipboard?.writeText(id);
                  }}
                >
                  {t("conversation.copyId")}
                </MenuItem>
              </>
            )}
          </Popover>
        </div>
      </div>
    </header>
  );
}

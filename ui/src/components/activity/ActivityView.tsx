import { Search, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../../context/AuthContext";
import { useLive } from "../../context/LiveContext";
import { useLocale } from "../../context/LocaleContext";
import { apiFetch } from "../../lib/api";
import { dayKey, dayLabel } from "../../lib/format";
import type { Navigate, Route } from "../../lib/router";
import { useCalls } from "../../lib/use-calls";
import { useNow } from "../../lib/use-now";
import type { SessionSummary } from "../../types";
import { ConfirmButton, EmptyState, Segmented, Loading } from "../ui/Controls";
import { buildLinks, hoverKey } from "../conversation/entries";
import { StepRow } from "../conversation/StepRow";
import { PageFrame } from "../pages/PageFrame";

type StatusFilter = "all" | "running" | "error" | "yielding" | "terminated";

export function ActivityView({
  route,
  navigate,
  wide,
}: {
  route: Extract<Route, { name: "activity" }>;
  navigate: Navigate;
  wide: boolean;
}) {
  const { t, locale } = useLocale();
  const live = useLive();
  const { systemStatus, refreshStatus } = useAuth();
  const now = useNow(60_000);
  const [query, setQuery] = useState(route.query ?? "");
  const status = (route.status ?? "all") as StatusFilter;
  const search = route.query ?? "";
  const field = useRef<HTMLInputElement>(null);
  const calls = useCalls({
    ...(status !== "all" ? { status } : {}),
    ...(search ? { search } : {}),
  });
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(route.call ? [route.call] : []),
  );
  const [hover, setHover] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (query.trim() !== search)
        navigate(
          {
            name: "activity",
            ...(query.trim() ? { query: query.trim() } : {}),
            ...(status !== "all" ? { status } : {}),
          },
          { replace: true },
        );
    }, 300);
    return () => window.clearTimeout(timer);
  }, [query, search, status, navigate]);
  useEffect(() => {
    const focus = () => field.current?.focus();
    window.addEventListener("exec:focus-search", focus);
    return () => window.removeEventListener("exec:focus-search", focus);
  }, []);

  const sessions = useMemo(
    () => new Map((live.sessions ?? []).map((item) => [item.id, item])),
    [live.sessions],
  );
  const items = useMemo(
    () =>
      [...calls.items.values()].sort((a, b) =>
        b.startedAt.localeCompare(a.startedAt),
      ),
    [calls.items],
  );
  const links = useMemo(
    () => buildLinks(calls.items.values(), []),
    [calls.items],
  );
  const toggle = useCallback((id: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const locate = useCallback((id: string) => {
    const node = document.getElementById(`call-${id}`);
    if (!node) return;
    node.scrollIntoView({ block: "center", behavior: "smooth" });
    node.classList.remove("locate");
    void node.offsetWidth;
    node.classList.add("locate");
  }, []);
  const clear = async () => {
    setError("");
    try {
      await apiFetch("/api/calls", { method: "DELETE" });
      await refreshStatus();
      live.refresh();
    } catch (caught) {
      setError(t("activity.clearFailed", String(caught)));
    }
  };

  let previousDay = 0;
  const unknown = (id: string): SessionSummary => ({
    id,
    callCount: 0,
    errorCount: 0,
    firstSeen: "",
    lastActive: "",
  });
  return (
    <PageFrame
      title={t("activity.title")}
      description={t(
        "activity.description",
        (systemStatus?.stats.totalCalls ?? 0).toLocaleString(locale),
      )}
      navigate={navigate}
      wide={wide}
      actions={
        <ConfirmButton
          onConfirm={clear}
          confirmLabel={t("activity.clearConfirm")}
          disabled={!systemStatus?.stats.totalCalls}
        >
          <Trash2 className="h-3.5 w-3.5" />
          {t("activity.clear")}
        </ConfirmButton>
      }
      toolbar={
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg border border-line bg-surface px-2.5 focus-within:border-line-strong sm:max-w-sm">
            <Search className="h-3.5 w-3.5 shrink-0 text-ink-3" />
            <input
              ref={field}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("activity.search")}
              aria-label={t("activity.search")}
              className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none"
            />
            {query && (
              <button
                type="button"
                aria-label={t("common.clear")}
                onClick={() => setQuery("")}
                className="text-ink-3 hover:text-ink"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </label>
          <Segmented
            label={t("activity.status")}
            value={status}
            onChange={(value) =>
              navigate(
                {
                  name: "activity",
                  ...(search ? { query: search } : {}),
                  ...(value !== "all" ? { status: value } : {}),
                },
                { replace: true },
              )
            }
            options={[
              { value: "all", label: t("activity.all") },
              { value: "running", label: t("activity.running") },
              { value: "yielding", label: t("activity.background") },
              { value: "error", label: t("activity.failed") },
              { value: "terminated", label: t("activity.stopped") },
            ]}
          />
        </div>
      }
    >
      {error && <p className="mb-3 text-sm text-err">{error}</p>}
      {!calls.loaded ? (
        <Loading />
      ) : items.length === 0 ? (
        <EmptyState
          title={
            search || status !== "all"
              ? t("activity.noMatches")
              : t("activity.empty")
          }
        >
          {!search && status === "all" && t("activity.emptyHelp")}
        </EmptyState>
      ) : (
        <div className="relative -mx-2">
          <span
            aria-hidden="true"
            className="pointer-events-none absolute top-6 bottom-10 left-[74px] w-px bg-line"
          />
          {items.map((call) => {
            const day = dayKey(call.startedAt);
            const separator =
              day !== previousDay ? (
                <div className="grid grid-cols-[48px_20px_minmax(0,1fr)] gap-x-2 px-2 pt-3 pb-1">
                  <span />
                  <span className="relative z-10 flex items-center justify-center">
                    <span className="h-1.5 w-1.5 rounded-full bg-line-strong ring-4 ring-bg" />
                  </span>
                  <span className="text-2xs font-medium text-ink-3">
                    {dayLabel(call.startedAt, now, locale, t)}
                  </span>
                </div>
              ) : null;
            previousDay = day;
            return (
              <div key={call.id}>
                {separator}
                <StepRow
                  call={call}
                  expanded={expanded.has(call.id)}
                  active={false}
                  highlighted={!!hover && hover === hoverKey(call)}
                  origin={links.origin.get(call.id)}
                  continuations={links.continuations.get(call.id)}
                  conversation={
                    sessions.get(call.sessionId) ?? unknown(call.sessionId)
                  }
                  onToggle={toggle}
                  onHover={setHover}
                  onLocate={locate}
                  onOpenConversation={(id) =>
                    navigate({ name: "conversation", id, call: call.id })
                  }
                />
              </div>
            );
          })}
          {calls.hasEarlier && (
            <div className="flex justify-center py-4">
              <button
                type="button"
                disabled={calls.loadingEarlier}
                onClick={() => void calls.loadEarlier()}
                className="rounded-md px-3 py-1.5 text-sm text-ink-2 hover:bg-hover hover:text-ink"
              >
                {calls.loadingEarlier
                  ? t("common.loading")
                  : t("activity.more", calls.total - calls.items.size)}
              </button>
            </div>
          )}
        </div>
      )}
    </PageFrame>
  );
}

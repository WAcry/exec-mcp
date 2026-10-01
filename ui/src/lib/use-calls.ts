import { useCallback, useEffect, useRef, useState } from "react";
import { useLiveEvents, usePollWhileOffline } from "../context/LiveContext";
import type { CallListItem, CallsResponse } from "../types";
import { apiFetch } from "./api";
import { coalesced } from "./coalesce";
import { errorFeedback } from "./errors";
import type { Feedback } from "./locale";

const PAGE_SIZE = 50;
const MAX_ITEMS = 1500;

export interface CallFilter {
  sessionId?: string;
  status?: string;
  search?: string;
}

interface CallsState {
  items: Map<string, CallListItem>;
  total: number;
  loaded: boolean;
  error: Feedback;
}

const empty = (): CallsState => ({
  items: new Map(),
  total: 0,
  loaded: false,
  error: "",
});

function query(filter: CallFilter, page: number): string {
  const params = new URLSearchParams({
    page: String(page),
    pageSize: String(PAGE_SIZE),
  });
  if (filter.sessionId) params.set("sessionId", filter.sessionId);
  if (filter.status) params.set("status", filter.status);
  if (filter.search) params.set("search", filter.search);
  return `/api/calls?${params}`;
}

function merged(
  previous: Map<string, CallListItem>,
  incoming: readonly CallListItem[],
): Map<string, CallListItem> {
  const next = new Map(previous);
  for (const item of incoming) next.set(item.id, item);
  if (next.size <= MAX_ITEMS) return next;
  const newest = [...next.values()]
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, MAX_ITEMS);
  return new Map(newest.map((item) => [item.id, item]));
}

/** Newest page refreshes on events; older pages load once and merge without gaps. */
export function useCalls(filter: CallFilter) {
  const [state, setState] = useState<CallsState>(empty);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const key = JSON.stringify(filter);
  const current = useRef(filter);
  current.current = filter;
  const known = useRef(new Set<string>());
  known.current = new Set(state.items.keys());
  const loader = useRef<ReturnType<typeof coalesced> | null>(null);

  useEffect(() => {
    let disposed = false;
    setState(empty());
    const filterAtStart = JSON.parse(key) as CallFilter;
    const load = coalesced(async () => {
      try {
        const page = await apiFetch<CallsResponse>(query(filterAtStart, 1));
        if (disposed) return;
        setState((previous) => ({
          items: merged(previous.items, page.items),
          total: page.total,
          loaded: true,
          error: "",
        }));
      } catch (error) {
        if (!disposed)
          setState((previous) => ({
            ...previous,
            loaded: true,
            error: errorFeedback(error),
          }));
      }
    }, 180);
    loader.current = load;
    load.now();
    return () => {
      disposed = true;
      loader.current = null;
      load.dispose();
    };
  }, [key]);

  usePollWhileOffline(() => loader.current?.schedule(), 20_000);

  useLiveEvents((event) => {
    const filter = current.current;
    if (event.type === "call:clear") {
      setState(empty());
      loader.current?.now();
      return;
    }
    if (event.type === "call:start") {
      if (!filter.sessionId || filter.sessionId === event.sessionId)
        loader.current?.schedule();
      return;
    }
    if (event.type === "call:subcall" || event.type === "call:finish") {
      if (
        known.current.has(event.callId) ||
        !filter.sessionId ||
        (event.type === "call:finish" && (filter.status || filter.search))
      )
        loader.current?.schedule();
    }
  });

  const loadEarlier = useCallback(async () => {
    const page = Math.floor(known.current.size / PAGE_SIZE) + 1;
    setLoadingEarlier(true);
    try {
      const result = await apiFetch<CallsResponse>(
        query(current.current, page),
      );
      setState((previous) => ({
        ...previous,
        items: merged(previous.items, result.items),
        total: result.total,
      }));
    } finally {
      setLoadingEarlier(false);
    }
  }, []);

  const refresh = useCallback(() => loader.current?.now(), []);
  return {
    ...state,
    hasEarlier: state.total > state.items.size,
    loadingEarlier,
    loadEarlier,
    refresh,
  };
}

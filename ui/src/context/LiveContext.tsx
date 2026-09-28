import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { apiFetch } from "../lib/api";
import { coalesced } from "../lib/coalesce";
import { useQuestionNotifications } from "../lib/use-question-notifications";
import type {
  CodeModeMemoryStatus,
  LiveEvent,
  NativeSessionItem,
  SessionPage,
  SessionSummary,
  TerminalItem,
} from "../types";
import { useAuth } from "./AuthContext";

export type Connection = "connecting" | "live" | "offline";

interface LiveValue {
  connection: Connection;
  sessions: SessionSummary[] | null;
  pendingQuestionsTotal: number;
  /** Code Mode sessions keyed by conversation digest. */
  native: Record<string, NativeSessionItem>;
  nativeList: NativeSessionItem[];
  memory: CodeModeMemoryStatus | null;
  terminals: TerminalItem[] | null;
  subscribe(listener: (event: LiveEvent) => void): () => void;
  refresh(): void;
  notifications: ReturnType<typeof useQuestionNotifications>;
}

const Context = createContext<LiveValue | null>(null);

export function LiveProvider({
  children,
  onOpenQuestion,
}: {
  children: ReactNode;
  onOpenQuestion(sessionId: string): void;
}) {
  const { isAuthenticated } = useAuth();
  const [connection, setConnection] = useState<Connection>("connecting");
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [pendingQuestionsTotal, setPending] = useState(0);
  const [nativeList, setNativeList] = useState<NativeSessionItem[]>([]);
  const [memory, setMemory] = useState<CodeModeMemoryStatus | null>(null);
  const [terminals, setTerminals] = useState<TerminalItem[] | null>(null);
  const listeners = useRef(new Set<(event: LiveEvent) => void>());
  const refreshers = useRef<(() => void) | null>(null);
  const openQuestion = useRef(onOpenQuestion);
  openQuestion.current = onOpenQuestion;
  const notifications = useQuestionNotifications(isAuthenticated, (id) =>
    openQuestion.current(id),
  );
  const receive = notifications.receive;

  useEffect(() => {
    if (!isAuthenticated) {
      setSessions(null);
      setPending(0);
      setNativeList([]);
      setMemory(null);
      setTerminals(null);
      setConnection("connecting");
      return;
    }
    const sessionsLoader = coalesced(async () => {
      const page = await apiFetch<SessionPage>("/api/sessions?pageSize=100");
      setSessions(page.items);
      setPending(page.pendingQuestionsTotal);
    }, 250);
    const nativeLoader = coalesced(async () => {
      const value = await apiFetch<{
        sessions: NativeSessionItem[];
        memory: CodeModeMemoryStatus;
      }>("/api/native-sessions");
      setNativeList(value.sessions);
      setMemory(value.memory);
    }, 400);
    const terminalLoader = coalesced(async () => {
      const value = await apiFetch<{ sessions: TerminalItem[] }>(
        "/api/terminals",
      );
      setTerminals(value.sessions);
    }, 400);
    const all = () => {
      sessionsLoader.schedule();
      nativeLoader.schedule();
      terminalLoader.schedule();
    };
    refreshers.current = all;

    let source: EventSource | null = null;
    let retry: number | undefined;
    let attempts = 0;
    let disposed = false;
    const connect = () => {
      if (disposed) return;
      source = new EventSource("/api/events");
      source.onopen = () => {
        attempts = 0;
        setConnection("live");
        all();
      };
      source.onerror = () => {
        source?.close();
        source = null;
        if (disposed) return;
        setConnection("offline");
        retry = window.setTimeout(
          connect,
          Math.min(10_000, 1000 * 2 ** attempts++),
        );
      };
      source.onmessage = (message) => {
        let event: LiveEvent;
        try {
          event = JSON.parse(message.data) as LiveEvent;
        } catch {
          return;
        }
        if (event.type === "connected") return;
        for (const listener of listeners.current) listener(event);
        if (event.type.startsWith("call:")) all();
        if (event.type === "session:notes") {
          sessionsLoader.schedule();
          receive(event);
        }
      };
    };
    connect();
    sessionsLoader.now();
    nativeLoader.now();
    terminalLoader.now();
    const poll = window.setInterval(all, 12_000);
    return () => {
      disposed = true;
      refreshers.current = null;
      source?.close();
      if (retry !== undefined) window.clearTimeout(retry);
      window.clearInterval(poll);
      sessionsLoader.dispose();
      nativeLoader.dispose();
      terminalLoader.dispose();
    };
  }, [isAuthenticated, receive]);

  const subscribe = useCallback((listener: (event: LiveEvent) => void) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);
  const refresh = useCallback(() => refreshers.current?.(), []);
  const native = useMemo(() => {
    const map: Record<string, NativeSessionItem> = {};
    for (const item of nativeList)
      if (item.scope && !item.retired) map[item.scope] = item;
    return map;
  }, [nativeList]);

  const value = useMemo<LiveValue>(
    () => ({
      connection,
      sessions,
      pendingQuestionsTotal,
      native,
      nativeList,
      memory,
      terminals,
      subscribe,
      refresh,
      notifications,
    }),
    [
      connection,
      sessions,
      pendingQuestionsTotal,
      native,
      nativeList,
      memory,
      terminals,
      subscribe,
      refresh,
      notifications,
    ],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useLive(): LiveValue {
  const value = useContext(Context);
  if (!value) throw new Error("Missing LiveProvider");
  return value;
}

/** Subscribes for the component's lifetime with the latest handler. */
export function useLiveEvents(handler: (event: LiveEvent) => void): void {
  const { subscribe } = useLive();
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => subscribe((event) => latest.current(event)), [subscribe]);
}

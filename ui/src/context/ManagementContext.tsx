import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { apiFetch } from "../lib/api";
import { errorFeedback } from "../lib/errors";
import type { Feedback } from "../lib/locale";
import type { ConfigToggleRequest, ManagementResponse } from "../types";
import { useAuth } from "./AuthContext";
import { useLive, useLiveEvents } from "./LiveContext";

export type ManagementState = ManagementResponse;
/** The provider adds the revision it last read. */
type WithoutRevision<T> = T extends unknown ? Omit<T, "revision"> : never;
type Toggle = WithoutRevision<ConfigToggleRequest>;
const Context = createContext<{
  data: ManagementState | null;
  busy: boolean;
  error: Feedback;
  toggle(change: Toggle): Promise<void>;
  restart(): Promise<void>;
} | null>(null);

export function ManagementProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated, refreshStatus } = useAuth();
  const { connection } = useLive();
  const [data, setData] = useState<ManagementState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Feedback>("");
  const active = useRef(false);
  const refresh = useCallback(async () => {
    if (!isAuthenticated) return;
    try {
      setData(await apiFetch<ManagementResponse>("/api/management"));
    } catch (caught) {
      setError(errorFeedback(caught));
    }
  }, [isAuthenticated]);
  // A restart sends runtime events; poll fast only when the stream cannot deliver them.
  const fast = data?.state === "restarting" && connection !== "live";
  useEffect(() => {
    if (!isAuthenticated) {
      setData(null);
      return;
    }
    void refresh();
    // The configuration file can change on disk without any event.
    const timer = window.setInterval(
      () => {
        void refresh();
      },
      fast ? 1000 : 15000,
    );
    return () => clearInterval(timer);
  }, [isAuthenticated, fast, refresh]);
  useLiveEvents((event) => {
    if (event.type !== "runtime") return;
    void refresh();
    void refreshStatus();
  });

  const action = async (operation: () => Promise<void>) => {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setError("");
    try {
      await operation();
    } catch (caught) {
      setError(errorFeedback(caught));
      await refresh();
    } finally {
      active.current = false;
      setBusy(false);
    }
  };
  const toggle = (change: Toggle) =>
    action(async () => {
      setData(
        await apiFetch<ManagementResponse>("/api/config/toggle", {
          method: "POST",
          body: JSON.stringify({ ...change, revision: data?.revision }),
        }),
      );
    });
  const restart = () =>
    action(async () => {
      await apiFetch("/api/runtime/restart", { method: "POST" });
      setData((previous) =>
        previous
          ? { ...previous, state: "restarting", error: undefined }
          : previous,
      );
      void refreshStatus();
    });
  return (
    <Context.Provider
      value={{
        data,
        busy: busy || data?.state === "restarting",
        error,
        toggle,
        restart,
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function useManagement() {
  const value = useContext(Context);
  if (!value) throw new Error("Missing ManagementProvider");
  return value;
}

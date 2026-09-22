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
import { useAuth } from "./AuthContext";

export interface ManagementState {
  available: boolean;
  revision?: string;
  pending?: boolean;
  state?: "ready" | "restarting" | "error" | "stopped";
  generation?: number;
  error?: string;
  servers?: { name: string; enabled: boolean; active: boolean }[];
  settings?: { login: boolean; web: boolean };
}
type Toggle =
  | { kind: "mcp"; name: string; enabled: boolean }
  | { kind: "skill"; path: string; workdir?: string; enabled: boolean }
  | {
      kind: "setting";
      name: "execution.login" | "web.enabled";
      enabled: boolean;
    };
const Context = createContext<{
  data: ManagementState | null;
  busy: boolean;
  error: string;
  toggle(change: Toggle): Promise<void>;
  restart(): Promise<void>;
} | null>(null);

export function ManagementProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated, refreshStatus } = useAuth();
  const [data, setData] = useState<ManagementState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const active = useRef(false);
  const refresh = useCallback(async () => {
    if (!isAuthenticated) return;
    try {
      setData(await apiFetch<ManagementState>("/api/management"));
    } catch (caught) {
      setError(String(caught));
    }
  }, [isAuthenticated]);
  useEffect(() => {
    if (!isAuthenticated) {
      setData(null);
      return;
    }
    void refresh();
    const timer = window.setInterval(
      () => {
        void refresh();
      },
      data?.state === "restarting" ? 1000 : 15000,
    );
    return () => clearInterval(timer);
  }, [isAuthenticated, data?.state, refresh]);

  const action = async (operation: () => Promise<void>) => {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setError("");
    try {
      await operation();
    } catch (caught) {
      setError(String(caught));
      await refresh();
    } finally {
      active.current = false;
      setBusy(false);
    }
  };
  const toggle = (change: Toggle) =>
    action(async () => {
      setData(
        await apiFetch<ManagementState>("/api/config/toggle", {
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

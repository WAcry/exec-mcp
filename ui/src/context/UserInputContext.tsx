import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
} from "react";
import { useAuth } from "./AuthContext";
import { apiFetch } from "../lib/api";
import type { UserInputList } from "../types";

export const USER_INPUT_REFRESH = "exec-user-input-refresh";
export const USER_INPUT_OPEN = "exec-user-input-open";
const storageKey = "exec-mcp-question-notifications";
const seenKey = "exec-mcp-question-seen";
const supported = () =>
  typeof window !== "undefined" &&
  window.isSecureContext &&
  "Notification" in window;
const Context = createContext<{
  pending: number;
  enabled: boolean;
  refresh: () => Promise<void>;
  permission: string;
  notify: boolean;
  setNotifications: () => Promise<void>;
}>({
  pending: 0,
  enabled: false,
  refresh: async () => {},
  permission: "unsupported",
  notify: false,
  setNotifications: async () => {},
});
export const useUserInput = () => useContext(Context);

export function UserInputProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useAuth();
  const [pending, setPending] = useState(0);
  const [enabled, setEnabled] = useState(false);
  const [permission, setPermission] = useState(
    supported() ? Notification.permission : "unsupported",
  );
  const [notify, setNotify] = useState(() => {
    try {
      return localStorage.getItem(storageKey) !== "off";
    } catch {
      return true;
    }
  });
  const seen = useRef(new Set<string>());
  const mounted = useRef(true);
  const refreshing = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const refresh = useCallback(async () => {
    if (!isAuthenticated || refreshing.current) return;
    refreshing.current = true;
    try {
      const data = await apiFetch<UserInputList>(
        "/api/user-input?status=pending",
      );
      if (!mounted.current) return;
      setPending(data.pending);
      setEnabled(data.enabled);
      setPermission(supported() ? Notification.permission : "unsupported");
      if (!notify || !supported() || Notification.permission !== "granted")
        return;
      try {
        for (const id of JSON.parse(
          localStorage.getItem(seenKey) ?? "[]",
        ) as string[])
          seen.current.add(id);
      } catch {
        /* Private browsing still gets in-tab reminders. */
      }
      const fresh = data.items.filter((item) => !seen.current.has(item.id));
      if (fresh.length) {
        const message = new Notification("Exec MCP 有问题需要你决定", {
          body: `${data.pending} 组问题待回答；打开控制台选择并补充说明。`,
          tag: "exec-mcp-user-input",
        });
        message.onclick = () => {
          window.focus();
          window.dispatchEvent(
            new CustomEvent(USER_INPUT_OPEN, { detail: fresh[0]!.id }),
          );
          message.close();
        };
        for (const item of fresh) seen.current.add(item.id);
        if (seen.current.size > 1000)
          seen.current = new Set([...seen.current].slice(-1000));
        try {
          localStorage.setItem(seenKey, JSON.stringify([...seen.current]));
        } catch {
          /* Optional notification deduplication. */
        }
      }
    } catch {
      /* Data stays on the server; normal polling reconnects. */
    } finally {
      refreshing.current = false;
    }
  }, [isAuthenticated, notify]);
  useEffect(() => {
    if (!isAuthenticated) {
      setPending(0);
      setEnabled(false);
      return;
    }
    void refresh();
    const listener = () => {
      void refresh();
    };
    window.addEventListener(USER_INPUT_REFRESH, listener);
    const timer = window.setInterval(listener, 15_000);
    return () => {
      window.removeEventListener(USER_INPUT_REFRESH, listener);
      window.clearInterval(timer);
    };
  }, [isAuthenticated, refresh]);
  const setNotifications = async () => {
    if (!supported()) return;
    if (Notification.permission !== "granted") {
      let result: NotificationPermission;
      try {
        result = await Notification.requestPermission();
      } catch {
        // Browser/OS restrictions do not affect the durable inbox or its in-page badge.
        setPermission(Notification.permission);
        return;
      }
      setPermission(result);
      if (result !== "granted") return;
      setNotify(true);
      try {
        localStorage.setItem(storageKey, "on");
      } catch {
        /* Optional preference. */
      }
    } else {
      setNotify((value) => !value);
      try {
        localStorage.setItem(storageKey, notify ? "off" : "on");
      } catch {
        /* Optional preference. */
      }
    }
    window.dispatchEvent(new Event(USER_INPUT_REFRESH));
  };
  return (
    <Context.Provider
      value={{
        pending,
        enabled,
        refresh,
        permission,
        notify,
        setNotifications,
      }}
    >
      {children}
    </Context.Provider>
  );
}

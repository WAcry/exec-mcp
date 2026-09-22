import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { SystemStatus } from "../types";
import { AUTH_REQUIRED_EVENT } from "../lib/api";

interface AuthContextType {
  isAuthenticated: boolean;
  isVerifying: boolean;
  systemStatus: SystemStatus | null;
  verifyToken(testToken: string): Promise<boolean>;
  logout(): Promise<void>;
  refreshStatus(): Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

function takeFragmentToken(): string | undefined {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const token = params.get("token")?.trim();
  if (!token) return undefined;
  params.delete("token");
  const hash = params.toString();
  window.history.replaceState(
    {},
    document.title,
    window.location.pathname +
      window.location.search +
      (hash ? `#${hash}` : ""),
  );
  return token;
}

// Read and scrub the fragment exactly once; React StrictMode remounts providers
// during development and must not consume the bootstrap credential twice.
let initialFragmentToken = takeFragmentToken();

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isVerifying, setIsVerifying] = useState(true);
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const statusRequest = useRef<AbortController | null>(null);
  const loggingOut = useRef(false);

  const fetchStatus = useCallback(async () => {
    if (loggingOut.current) return;
    statusRequest.current?.abort();
    const controller = new AbortController();
    statusRequest.current = controller;
    try {
      const response = await fetch("/api/status", {
        credentials: "same-origin",
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (response.status === 401) {
        setIsAuthenticated(false);
        setSystemStatus(null);
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const status = (await response.json()) as SystemStatus;
      if (controller.signal.aborted) return;
      setSystemStatus(status);
      setIsAuthenticated(true);
    } catch {
      // A transient offline state does not erase a valid browser session.
    } finally {
      if (!controller.signal.aborted) setIsVerifying(false);
    }
  }, []);

  const verifyToken = useCallback(
    async (testToken: string): Promise<boolean> => {
      loggingOut.current = false;
      statusRequest.current?.abort();
      setIsVerifying(true);
      try {
        const response = await fetch("/api/auth/verify", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-exec-web": "1",
          },
          credentials: "same-origin",
          body: JSON.stringify({ token: testToken }),
        });
        if (!response.ok) return false;
        setIsAuthenticated(true);
        setSystemStatus(null);
        void fetchStatus();
        return true;
      } catch {
        return false;
      } finally {
        setIsVerifying(false);
      }
    },
    [fetchStatus],
  );

  const logout = useCallback(async () => {
    loggingOut.current = true;
    statusRequest.current?.abort();
    setIsAuthenticated(false);
    setSystemStatus(null);
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        headers: { "x-exec-web": "1" },
        credentials: "same-origin",
      });
    } finally {
      setIsAuthenticated(false);
      setSystemStatus(null);
    }
  }, []);

  useEffect(() => {
    const token = initialFragmentToken;
    initialFragmentToken = undefined;
    if (token) void verifyToken(token);
    else void fetchStatus();
  }, [fetchStatus, verifyToken]);

  useEffect(() => {
    const requireAuth = () => {
      statusRequest.current?.abort();
      setIsAuthenticated(false);
      setSystemStatus(null);
    };
    window.addEventListener(AUTH_REQUIRED_EVENT, requireAuth);
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, requireAuth);
  }, []);

  useEffect(() => {
    if (!isAuthenticated) return;
    const timer = window.setInterval(() => void fetchStatus(), 15_000);
    return () => {
      window.clearInterval(timer);
      statusRequest.current?.abort();
    };
  }, [fetchStatus, isAuthenticated]);

  return (
    <AuthContext.Provider
      value={{
        isAuthenticated,
        isVerifying,
        systemStatus,
        verifyToken,
        logout,
        refreshStatus: fetchStatus,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within an AuthProvider");
  return context;
}

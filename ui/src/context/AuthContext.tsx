import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
} from "react";
import type { SystemStatus } from "../types";

interface AuthContextType {
  token: string | null;
  isAuthenticated: boolean;
  isVerifying: boolean;
  systemStatus: SystemStatus | null;
  verifyToken: (testToken: string) => Promise<boolean>;
  logout: () => void;
  refreshStatus: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null>(() => {
    // Check URL query param first
    const urlParams = new URLSearchParams(window.location.search);
    const urlToken = urlParams.get("token");
    if (urlToken) {
      localStorage.setItem("exec_lan_token", urlToken);
      // Clean query parameter from URL without reload
      const newUrl = window.location.pathname + window.location.hash;
      window.history.replaceState({}, document.title, newUrl);
      return urlToken;
    }
    return localStorage.getItem("exec_lan_token");
  });

  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(true);
  const [isVerifying, setIsVerifying] = useState<boolean>(true);
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const headers: Record<string, string> = {};
      const currentToken = localStorage.getItem("exec_lan_token");
      if (currentToken) {
        headers["x-exec-token"] = currentToken;
      }
      const res = await fetch("/api/status", { headers });
      if (res.status === 401) {
        setIsAuthenticated(false);
        setSystemStatus(null);
        return;
      }
      if (res.ok) {
        const data = (await res.json()) as SystemStatus;
        setSystemStatus(data);
        setIsAuthenticated(true);
      }
    } catch {
      // Offline or network error
    } finally {
      setIsVerifying(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const verifyToken = async (testToken: string): Promise<boolean> => {
    setIsVerifying(true);
    try {
      const res = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: testToken }),
      });
      if (res.ok) {
        localStorage.setItem("exec_lan_token", testToken);
        setToken(testToken);
        setIsAuthenticated(true);
        await fetchStatus();
        return true;
      }
      return false;
    } catch {
      return false;
    } finally {
      setIsVerifying(false);
    }
  };

  const logout = () => {
    localStorage.removeItem("exec_lan_token");
    setToken(null);
    setIsAuthenticated(false);
  };

  return (
    <AuthContext.Provider
      value={{
        token,
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
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}

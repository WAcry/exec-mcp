import { useLocale } from "../context/LocaleContext";
import { useTheme } from "../context/ThemeContext";
import { useAuth } from "../context/AuthContext";
import { VERSION } from "../../../src/version";
import type { ReactNode } from "react";
import { Sun, Moon, Laptop, LogOut } from "lucide-react";

interface HeaderProps {
  activeTab: string;
  setActiveTab: (tab: string) => void;
  online: boolean;
  notificationControl?: ReactNode;
}

export function Header({
  activeTab,
  setActiveTab,
  online,
  notificationControl,
}: HeaderProps) {
  const { t } = useLocale();

  const { theme, setTheme } = useTheme();
  const { systemStatus, logout } = useAuth();

  const navItems = [
    { id: "calls", label: t("nav.calls") },
    { id: "sessions", label: t("nav.sessions") },
    { id: "terminals", label: t("nav.terminals") },
    { id: "mcp", label: t("nav.mcp") },
    { id: "skills", label: t("nav.skills") },
    { id: "artifacts", label: t("nav.artifacts") },
    { id: "config", label: t("nav.config") },
  ];

  const status = !online
    ? { label: t("header.disconnected"), dot: "bg-rose-500" }
    : systemStatus?.status === "restarting"
      ? { label: t("header.restarting"), dot: "bg-amber-500" }
      : systemStatus?.status === "error"
        ? { label: t("header.error"), dot: "bg-rose-500" }
        : { label: t("header.ready"), dot: "bg-zinc-400 dark:bg-zinc-500" };

  return (
    <header className="sticky top-0 z-40 w-full border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#09090b]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex flex-wrap sm:flex-nowrap items-center justify-between min-h-14 py-2 gap-x-6 gap-y-2">
          <div className="flex flex-col justify-center shrink-0">
            <div className="flex items-baseline gap-2 whitespace-nowrap">
              <span className="font-semibold text-sm text-zinc-900 dark:text-zinc-100">
                EXEC MCP
              </span>
              <span className="text-[11px] tabular-nums text-zinc-400 dark:text-zinc-500">
                v{systemStatus?.version ?? VERSION}
              </span>
            </div>
            <div className="flex items-center gap-1.5 text-[11px] text-zinc-500 dark:text-zinc-400 whitespace-nowrap leading-none mt-1">
              <span
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${status.dot}`}
              />
              <span>{status.label}</span>
              <span className="text-zinc-300 dark:text-zinc-700">·</span>
              <span className="font-mono text-zinc-400 dark:text-zinc-500">
                {systemStatus?.mcp.host}:{systemStatus?.mcp.port}
              </span>
            </div>
          </div>

          <nav className="hidden md:flex flex-1 items-center gap-0.5 overflow-x-auto no-scrollbar">
            {navItems.map((item) => {
              const isActive = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => setActiveTab(item.id)}
                  aria-current={isActive ? "page" : undefined}
                  className={`px-2.5 py-1.5 rounded-md text-xs font-medium whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
                    isActive
                      ? "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100"
                      : "text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100"
                  }`}
                >
                  {item.label}
                </button>
              );
            })}
          </nav>

          <div className="flex items-center gap-2 shrink-0">
            {notificationControl}

            {systemStatus && !systemStatus.isLoopback && (
              <button
                onClick={() => void logout()}
                className="p-1.5 rounded-md text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
                title={t("header.logout")}
              >
                <LogOut className="w-3.5 h-3.5" />
              </button>
            )}

            <div className="flex items-center p-0.5 rounded-lg bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 text-zinc-500 dark:text-zinc-400 shrink-0">
              <button
                onClick={() => setTheme("light")}
                className={`p-1.5 rounded-md transition-colors cursor-pointer ${
                  theme === "light"
                    ? "bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 shadow-xs"
                    : "hover:text-zinc-900 dark:hover:text-zinc-100"
                }`}
                title={t("theme.light")}
              >
                <Sun className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => setTheme("dark")}
                className={`p-1.5 rounded-md transition-colors cursor-pointer ${
                  theme === "dark"
                    ? "bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 shadow-xs"
                    : "hover:text-zinc-900 dark:hover:text-zinc-100"
                }`}
                title={t("theme.dark")}
              >
                <Moon className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => setTheme("system")}
                className={`p-1.5 rounded-md transition-colors cursor-pointer ${
                  theme === "system"
                    ? "bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 shadow-xs"
                    : "hover:text-zinc-900 dark:hover:text-zinc-100"
                }`}
                title={t("theme.system")}
              >
                <Laptop className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>

        <div className="flex md:hidden overflow-x-auto no-scrollbar py-2 border-t border-zinc-100 dark:border-zinc-800 gap-1">
          {navItems.map((item) => {
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setActiveTab(item.id)}
                aria-current={isActive ? "page" : undefined}
                className={`px-2.5 py-1.5 rounded-md text-xs font-medium whitespace-nowrap shrink-0 transition-colors ${
                  isActive
                    ? "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100"
                    : "text-zinc-500 dark:text-zinc-400"
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </div>
      </div>
    </header>
  );
}

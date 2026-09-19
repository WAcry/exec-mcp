import { useTheme } from "../context/ThemeContext";
import { useAuth } from "../context/AuthContext";
import {
  Sun,
  Moon,
  Laptop,
  Terminal,
  Activity,
  Layers,
  Wrench,
  Settings,
  HardDrive,
  FileCode2,
  LogOut,
} from "lucide-react";

interface HeaderProps {
  activeTab: string;
  setActiveTab: (tab: string) => void;
  online: boolean;
}

export function Header({ activeTab, setActiveTab, online }: HeaderProps) {
  const { theme, setTheme } = useTheme();
  const { systemStatus, logout } = useAuth();

  const navItems = [
    { id: "calls", label: "调用审计流", icon: Activity },
    { id: "sessions", label: "会话组", icon: Layers },
    { id: "terminals", label: "活动终端", icon: Terminal },
    { id: "mcp", label: "下游 MCP", icon: Wrench },
    { id: "skills", label: "Skills 目录", icon: FileCode2 },
    { id: "artifacts", label: "产物附件", icon: HardDrive },
    { id: "config", label: "服务配置", icon: Settings },
  ];

  return (
    <header className="sticky top-0 z-40 w-full border-b border-zinc-200/80 dark:border-zinc-800/80 bg-white/95 dark:bg-[#09090b]/95 backdrop-blur-md transition-colors">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-15 gap-3">
          {/* Brand & Instance Info */}
          <div className="flex items-center gap-3 shrink-0">
            <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 font-mono font-bold text-xs tracking-wider shadow-xs border border-zinc-800 dark:border-zinc-200 shrink-0">
              &gt;_
            </div>
            <div className="flex flex-col justify-center">
              <div className="flex items-center gap-1.5 whitespace-nowrap">
                <span className="font-bold text-sm text-zinc-900 dark:text-zinc-100 tracking-tight">
                  EXEC MCP
                </span>
                <span className="text-[10px] font-mono px-1.5 py-0.2 rounded font-medium bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 border border-zinc-200 dark:border-zinc-700/80 shrink-0">
                  v{systemStatus?.version ?? "0.1.0"}
                </span>
              </div>
              <div className="flex items-center gap-1.5 text-[11px] text-zinc-500 dark:text-zinc-400 whitespace-nowrap leading-none mt-0.5">
                <span className="flex items-center gap-1 shrink-0">
                  <span
                    className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                      online ? "bg-emerald-500" : "bg-rose-500"
                    }`}
                  />
                  <span className="whitespace-nowrap">
                    {online ? "就绪" : "已断开"}
                  </span>
                </span>
                <span className="text-zinc-300 dark:text-zinc-700">•</span>
                <span className="font-mono text-[10px] text-zinc-400 dark:text-zinc-500 shrink-0">
                  {systemStatus?.mcp.host}:{systemStatus?.mcp.port}
                </span>
              </div>
            </div>
          </div>

          {/* Navigation Tabs (Desktop) */}
          <nav className="hidden md:flex items-center gap-1 overflow-x-auto no-scrollbar py-1">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => setActiveTab(item.id)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap shrink-0 transition-all cursor-pointer border ${
                    isActive
                      ? "bg-zinc-900 text-white dark:bg-zinc-800 dark:text-zinc-100 border-zinc-900 dark:border-zinc-700 shadow-xs font-semibold"
                      : "border-transparent text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800/60"
                  }`}
                >
                  <Icon className="w-3.5 h-3.5 shrink-0" />
                  <span className="whitespace-nowrap">{item.label}</span>
                </button>
              );
            })}
          </nav>

          {/* Right Actions: SSE Status & Theme Toggle */}
          <div className="flex items-center gap-2 shrink-0">
            <div className="hidden xl:flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-mono bg-zinc-100 dark:bg-zinc-900 text-zinc-600 dark:text-zinc-400 border border-zinc-200/80 dark:border-zinc-800 whitespace-nowrap shrink-0">
              <span
                className={`w-1.5 h-1.5 rounded-full shrink-0 ${online ? "bg-emerald-500 animate-pulse" : "bg-rose-500"}`}
              />
              <span>{online ? "事件流已连接" : "事件流已断开"}</span>
            </div>

            {systemStatus && !systemStatus.isLoopback && (
              <button
                onClick={() => void logout()}
                className="p-1.5 rounded-md text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
                title="退出 Web UI"
              >
                <LogOut className="w-3.5 h-3.5" />
              </button>
            )}

            {/* Theme switcher */}
            <div className="flex items-center p-0.5 rounded-lg bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 text-zinc-500 dark:text-zinc-400 shrink-0">
              <button
                onClick={() => setTheme("light")}
                className={`p-1.5 rounded-md transition-colors cursor-pointer ${
                  theme === "light"
                    ? "bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 shadow-xs"
                    : "hover:text-zinc-900 dark:hover:text-zinc-100"
                }`}
                title="亮色模式"
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
                title="暗色模式"
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
                title="跟随系统"
              >
                <Laptop className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>

        {/* Mobile Navigation */}
        <div className="flex md:hidden overflow-x-auto no-scrollbar py-2 border-t border-zinc-100 dark:border-zinc-800/80 gap-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setActiveTab(item.id)}
                className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium whitespace-nowrap shrink-0 transition-colors border ${
                  isActive
                    ? "bg-zinc-900 text-white dark:bg-zinc-800 dark:text-zinc-100 border-zinc-900 dark:border-zinc-700 font-semibold"
                    : "border-transparent text-zinc-600 dark:text-zinc-400 bg-zinc-100 dark:bg-zinc-800/70"
                }`}
              >
                <Icon className="w-3.5 h-3.5 shrink-0" />
                <span className="whitespace-nowrap">{item.label}</span>
              </button>
            );
          })}
        </div>
      </div>
    </header>
  );
}

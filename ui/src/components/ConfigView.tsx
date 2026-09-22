import { useState, useEffect } from "react";
import { apiFetch } from "../lib/api";
import { useAuth } from "../context/AuthContext";
import { ConfigResponse } from "../types";
import { CodeBlock } from "./CodeBlock";
import { useManagement } from "../context/ManagementContext";
import { ConfigToggle } from "./ConfigToggle";
import {
  Settings,
  Globe,
  Copy,
  Check,
  RotateCw,
  FileCode2,
  FolderOpen,
} from "lucide-react";

export function ConfigView() {
  const management = useManagement();
  const { systemStatus, refreshStatus } = useAuth();
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [copiedLoopback, setCopiedLoopback] = useState(false);
  const [copiedLan, setCopiedLan] = useState(false);
  const [copiedPath, setCopiedPath] = useState(false);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [isRevealing, setIsRevealing] = useState(false);
  const [regeneratedLanUrls, setRegeneratedLanUrls] = useState<string[] | null>(
    null,
  );

  useEffect(() => {
    apiFetch<ConfigResponse>("/api/config")
      .then(setConfig)
      .catch(console.error);
  }, []);

  const handleCopy = (text: string, type: "loopback" | "lan" | "path") => {
    navigator.clipboard.writeText(text);
    if (type === "loopback") {
      setCopiedLoopback(true);
      setTimeout(() => setCopiedLoopback(false), 2000);
    } else if (type === "lan") {
      setCopiedLan(true);
      setTimeout(() => setCopiedLan(false), 2000);
    } else {
      setCopiedPath(true);
      setTimeout(() => setCopiedPath(false), 2000);
    }
  };

  const handleRegenerateToken = async () => {
    if (
      !confirm(
        "重新生成局域网密钥后，使用旧密钥的局域网客户端需重新登录。是否确认？",
      )
    ) {
      return;
    }
    setIsRegenerating(true);
    try {
      const result = await apiFetch<{ lanUrls: string[] }>(
        "/api/auth/regenerate-token",
        { method: "POST" },
      );
      setRegeneratedLanUrls(result.lanUrls);
      await refreshStatus();
      alert("局域网访问密钥已重新生成，旧登录已失效。");
    } catch (err) {
      alert("重新生成失败: " + String(err));
    } finally {
      setIsRegenerating(false);
    }
  };

  const handleRevealConfig = async () => {
    setIsRevealing(true);
    try {
      await apiFetch("/api/config/reveal", { method: "POST" });
    } catch (err) {
      alert("打开所在目录失败: " + String(err));
    } finally {
      setIsRevealing(false);
    }
  };

  return (
    <div className="space-y-4">
      {management.data?.available && (
        <section className="space-y-3 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900/50">
          <h3 className="text-xs font-bold">配置开关</h3>
          <div className="flex items-center justify-between gap-4 text-xs">
            <div>
              <p>Shell 登录环境 / PowerShell profile</p>
              <p className="mt-1 text-zinc-500">
                修改默认 login；单次调用仍可覆盖。
              </p>
            </div>
            <ConfigToggle
              label="默认加载 Shell profile"
              checked={management.data.settings?.login ?? false}
              disabled={management.busy}
              onChange={(enabled) =>
                void management.toggle({
                  kind: "setting",
                  name: "execution.login",
                  enabled,
                })
              }
            />
          </div>
          <div className="flex items-center justify-between gap-4 text-xs">
            <div>
              <p>Web 管理控制台</p>
              <p className="mt-1 text-zinc-500">
                停用后执行服务继续运行；再次启用需从终端修改配置。
              </p>
            </div>
            <ConfigToggle
              label="启用 Web 管理控制台"
              checked={management.data.settings?.web ?? true}
              disabled={management.busy}
              onChange={(enabled) =>
                void management.toggle({
                  kind: "setting",
                  name: "web.enabled",
                  enabled,
                })
              }
            />
          </div>
          <p className="text-xs text-zinc-500">
            开关仅保存 config.toml，点击“重启执行服务”后生效。
          </p>
        </section>
      )}
      {/* Network & URLs Access Card */}
      <div className="p-4 rounded-xl bg-white dark:bg-zinc-900/50 border border-zinc-200/80 dark:border-zinc-800/80 shadow-xs space-y-3">
        <div className="flex items-center gap-2">
          <Globe className="w-4 h-4 text-zinc-400" />
          <h3 className="text-xs font-bold text-zinc-900 dark:text-zinc-100">
            Web UI 访问入口与局域网鉴权密钥
          </h3>
        </div>

        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          默认只监听本机回环。只有显式把 <code>[web].host</code> 配置为
          <code>0.0.0.0</code> 或 <code>::</code>{" "}
          时才开放局域网，并使用本次启动的随机密钥。
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-1">
          {/* Loopback URL */}
          <div className="p-3.5 rounded-lg bg-zinc-50 dark:bg-zinc-950/60 border border-zinc-200 dark:border-zinc-800 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-zinc-700 dark:text-zinc-300 flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                本机回环访问
              </span>
              <span className="text-[10px] px-1.5 py-0.2 rounded bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 font-semibold border border-emerald-200 dark:border-emerald-800">
                免密钥
              </span>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="text"
                readOnly
                value={systemStatus?.web.loopbackUrl ?? ""}
                className="flex-1 px-2.5 py-1.5 text-xs font-mono bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-md text-zinc-700 dark:text-zinc-300 select-all"
              />
              <button
                onClick={() =>
                  handleCopy(systemStatus?.web.loopbackUrl ?? "", "loopback")
                }
                className="p-1.5 text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-md cursor-pointer transition-colors"
                title="复制"
              >
                {copiedLoopback ? (
                  <Check className="w-3.5 h-3.5 text-emerald-500" />
                ) : (
                  <Copy className="w-3.5 h-3.5" />
                )}
              </button>
            </div>
          </div>

          {/* LAN URL with Token */}
          <div className="p-3.5 rounded-lg bg-zinc-50 dark:bg-zinc-950/60 border border-zinc-200 dark:border-zinc-800 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-zinc-700 dark:text-zinc-300 flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-zinc-400 dark:bg-zinc-500" />
                局域网访问
              </span>
              {systemStatus?.isLoopback && systemStatus.web.exposed && (
                <button
                  onClick={handleRegenerateToken}
                  disabled={isRegenerating}
                  className="text-[10px] flex items-center gap-1 px-2 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 font-medium hover:bg-zinc-200 dark:hover:bg-zinc-700 border border-zinc-200 dark:border-zinc-700 cursor-pointer transition-colors"
                >
                  <RotateCw
                    className={`w-3 h-3 ${isRegenerating ? "animate-spin" : ""}`}
                  />
                  换新密钥
                </button>
              )}
            </div>
            {systemStatus?.web.exposed &&
            (regeneratedLanUrls ?? systemStatus.web.lanUrls).length > 0 ? (
              <div className="space-y-1.5">
                {(regeneratedLanUrls ?? systemStatus.web.lanUrls).map(
                  (url, index) => (
                    <div className="flex items-center gap-2" key={url}>
                      <input
                        type="text"
                        readOnly
                        value={url}
                        className="flex-1 px-2.5 py-1.5 text-xs font-mono bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-md text-zinc-700 dark:text-zinc-300 select-all"
                      />
                      {index === 0 && (
                        <button
                          onClick={() => handleCopy(url, "lan")}
                          className="p-1.5 text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-md cursor-pointer transition-colors"
                          title="复制"
                        >
                          {copiedLan ? (
                            <Check className="w-3.5 h-3.5 text-emerald-500" />
                          ) : (
                            <Copy className="w-3.5 h-3.5" />
                          )}
                        </button>
                      )}
                    </div>
                  ),
                )}
              </div>
            ) : systemStatus?.web.exposed ? (
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                带密钥的局域网链接仅在本机回环控制台显示。
              </p>
            ) : (
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                当前未开放局域网访问；这也是推荐默认值。
              </p>
            )}
          </div>
        </div>
      </div>

      {/* System Status and Config */}
      <div className="p-4 rounded-xl bg-white dark:bg-zinc-900/50 border border-zinc-200/80 dark:border-zinc-800/80 shadow-xs space-y-3.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Settings className="w-4 h-4 text-zinc-400" />
            <h3 className="text-xs font-bold text-zinc-900 dark:text-zinc-100">
              生效配置清单
            </h3>
          </div>
          {config?.config_exists !== undefined && (
            <span className="text-[11px] font-mono px-2 py-0.5 rounded-md bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 border border-zinc-200 dark:border-zinc-700">
              {config.config_exists ? "文件存在" : "未持久化至文件"}
            </span>
          )}
        </div>

        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          当前运行实例的安全配置摘要（包含服务器网络、执行环境、内存水位、Skills
          与下游 MCP 挂载）；凭据值和命令参数不会发送到浏览器。
        </p>

        {/* Config File Location Card */}
        <div className="p-3 rounded-lg bg-zinc-50 dark:bg-zinc-950/60 border border-zinc-200 dark:border-zinc-800 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="p-1.5 rounded-md bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 shrink-0">
              <FileCode2 className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <span className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400 block">
                配置文件路径 (TOML)
              </span>
              <p
                className="font-mono text-xs font-semibold text-zinc-800 dark:text-zinc-200 truncate select-all mt-0.5"
                title={config?.config_path ?? config?.config_file}
              >
                {config?.config_path ??
                  config?.config_file ??
                  "正在加载路径..."}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5 shrink-0 self-end sm:self-auto">
            <button
              onClick={() => handleCopy(config?.config_path ?? "", "path")}
              disabled={!config?.config_path}
              className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-md text-zinc-700 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-40 cursor-pointer transition-colors"
              title="复制文件绝对路径"
            >
              {copiedPath ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-500" />
                  <span>已复制</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  <span>复制路径</span>
                </>
              )}
            </button>

            {systemStatus?.isLoopback && (
              <button
                onClick={handleRevealConfig}
                disabled={isRevealing || !config?.config_path}
                className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-md text-zinc-700 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-40 cursor-pointer transition-colors"
                title="在本地文件管理器中定位该文件"
              >
                <FolderOpen className="w-3.5 h-3.5" />
                <span>打开所在目录</span>
              </button>
            )}
          </div>
        </div>

        {config && (
          <CodeBlock
            code={JSON.stringify(config, null, 2)}
            language="json"
            maxHeight="max-h-[450px]"
          />
        )}
      </div>
    </div>
  );
}

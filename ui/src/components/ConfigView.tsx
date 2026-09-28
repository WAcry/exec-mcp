import { useLocale } from "../context/LocaleContext";
import { useState, useEffect } from "react";
import { apiFetch } from "../lib/api";
import { useAuth } from "../context/AuthContext";
import { ConfigResponse } from "../types";
import { CodeBlock } from "./CodeBlock";
import { useManagement } from "../context/ManagementContext";
import { ConfigToggle } from "./ConfigToggle";
import { InterfacePreferences } from "./LanguageControl";
import { Copy, Check, RotateCw, FolderOpen } from "lucide-react";

export function ConfigView() {
  const { t } = useLocale();

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
    if (!confirm(t("config.rotateConfirm"))) {
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
      alert(t("config.rotated"));
    } catch (err) {
      alert(t("config.rotateFailed") + String(err));
    } finally {
      setIsRegenerating(false);
    }
  };

  const handleRevealConfig = async () => {
    setIsRevealing(true);
    try {
      await apiFetch("/api/config/reveal", { method: "POST" });
    } catch (err) {
      alert(t("config.revealFailed") + String(err));
    } finally {
      setIsRevealing(false);
    }
  };

  const copyButton =
    "p-1.5 text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800 border border-zinc-200 dark:border-zinc-800 rounded-md cursor-pointer transition-colors";
  const urlInput =
    "min-w-0 flex-1 px-2.5 py-1.5 text-xs font-mono bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-md text-zinc-700 dark:text-zinc-300 select-all";
  const fileButton =
    "flex items-center gap-1 px-2.5 py-1 text-xs font-medium border border-zinc-200 dark:border-zinc-800 rounded-md text-zinc-700 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-40 cursor-pointer transition-colors";

  return (
    <div className="space-y-4">
      <InterfacePreferences />
      {management.data?.available && (
        <section className="panel space-y-4 p-4">
          <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
            {t("config.switches")}
          </h3>
          <div className="flex items-center justify-between gap-4 text-xs">
            <div>
              <p className="font-medium text-zinc-900 dark:text-zinc-100">
                {t("config.login")}
              </p>
              <p className="mt-0.5 text-zinc-500">{t("config.loginHelp")}</p>
            </div>
            <ConfigToggle
              label={t("config.loginLabel")}
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
              <p className="font-medium text-zinc-900 dark:text-zinc-100">
                {t("config.web")}
              </p>
              <p className="mt-0.5 text-zinc-500">{t("config.webHelp")}</p>
            </div>
            <ConfigToggle
              label={t("config.webEnable")}
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
          <p className="pt-3 border-t border-zinc-100 dark:border-zinc-800 text-xs text-zinc-500">
            {t("config.applyHelp")}
          </p>
        </section>
      )}

      <section className="panel p-4">
        <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
          {t("config.access")}
        </h3>
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          {t("config.accessHelp")}
        </p>

        <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-5">
          <div className="space-y-2">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-xs font-medium text-zinc-900 dark:text-zinc-100">
                {t("config.loopback")}
              </span>
              <span className="text-[11px] text-zinc-500">
                {t("config.noToken")}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="text"
                readOnly
                value={systemStatus?.web.loopbackUrl ?? ""}
                className={urlInput}
              />
              <button
                onClick={() =>
                  handleCopy(systemStatus?.web.loopbackUrl ?? "", "loopback")
                }
                className={copyButton}
                title={t("common.copy")}
              >
                {copiedLoopback ? (
                  <Check className="w-3.5 h-3.5" />
                ) : (
                  <Copy className="w-3.5 h-3.5" />
                )}
              </button>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-xs font-medium text-zinc-900 dark:text-zinc-100">
                {t("config.lan")}
              </span>
              {systemStatus?.isLoopback && systemStatus.web.exposed && (
                <button
                  onClick={handleRegenerateToken}
                  disabled={isRegenerating}
                  className="text-[11px] flex items-center gap-1 px-2 py-0.5 rounded text-zinc-700 dark:text-zinc-300 font-medium hover:bg-zinc-100 dark:hover:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 cursor-pointer transition-colors"
                >
                  <RotateCw
                    className={`w-3 h-3 ${isRegenerating ? "animate-spin" : ""}`}
                  />
                  {t("config.rotate")}
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
                        className={urlInput}
                      />
                      {index === 0 && (
                        <button
                          onClick={() => handleCopy(url, "lan")}
                          className={copyButton}
                          title={t("common.copy")}
                        >
                          {copiedLan ? (
                            <Check className="w-3.5 h-3.5" />
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
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                {t("config.privateLinks")}
              </p>
            ) : (
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                {t("config.lanDisabled")}
              </p>
            )}
          </div>
        </div>
      </section>

      <section className="panel p-4 space-y-4">
        <div>
          <div className="flex items-baseline justify-between gap-3">
            <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
              {t("config.effective")}
            </h3>
            {config?.config_exists !== undefined && (
              <span className="text-xs text-zinc-500">
                {config.config_exists
                  ? t("config.fileExists")
                  : t("config.noFile")}
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
            {t("config.summary")}
          </p>
        </div>

        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-2.5">
          <div className="min-w-0">
            <span className="text-[11px] text-zinc-500 dark:text-zinc-400 block">
              {t("config.path")}
            </span>
            <p
              className="font-mono text-xs text-zinc-900 dark:text-zinc-100 truncate select-all mt-0.5"
              title={config?.config_path ?? config?.config_file}
            >
              {config?.config_path ??
                config?.config_file ??
                t("config.pathLoading")}
            </p>
          </div>

          <div className="flex items-center gap-1.5 shrink-0 self-end sm:self-auto">
            <button
              onClick={() => handleCopy(config?.config_path ?? "", "path")}
              disabled={!config?.config_path}
              className={fileButton}
              title={t("config.copyAbsolute")}
            >
              {copiedPath ? (
                <>
                  <Check className="w-3.5 h-3.5" />
                  <span>{t("common.copied")}</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  <span>{t("config.copyPath")}</span>
                </>
              )}
            </button>

            {systemStatus?.isLoopback && (
              <button
                onClick={handleRevealConfig}
                disabled={isRevealing || !config?.config_path}
                className={fileButton}
                title={t("config.reveal")}
              >
                <FolderOpen className="w-3.5 h-3.5" />
                <span>{t("config.openFolder")}</span>
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
      </section>
    </div>
  );
}

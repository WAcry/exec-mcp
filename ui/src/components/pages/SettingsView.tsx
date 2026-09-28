import {
  FolderOpen,
  LogOut,
  Monitor,
  Moon,
  RotateCw,
  Sun,
  Trash2,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useAuth } from "../../context/AuthContext";
import { useLive } from "../../context/LiveContext";
import { useLocale } from "../../context/LocaleContext";
import { useManagement } from "../../context/ManagementContext";
import { useTheme } from "../../context/ThemeContext";
import { apiFetch } from "../../lib/api";
import { formatDuration } from "../../lib/format";
import type { Navigate } from "../../lib/router";
import type { ConfigResponse } from "../../types";
import { LanguageOptions } from "../LanguageControl";
import { CodeView } from "../ui/CodeSurface";
import { Button, ConfirmButton, Segmented, Switch } from "../ui/Controls";
import { CopyButton } from "../ui/CopyButton";
import { PageFrame, Panel } from "./PageFrame";

function Group({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-x-10 gap-y-3 border-b border-line py-7 first:pt-0 last:border-0 md:grid-cols-[220px_minmax(0,1fr)]">
      <div>
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        {description && (
          <p className="mt-1 text-xs text-ink-3">{description}</p>
        )}
      </div>
      <div className="min-w-0 space-y-3">{children}</div>
    </section>
  );
}

function Row({
  label,
  help,
  control,
}: {
  label: ReactNode;
  help?: ReactNode;
  control: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-6">
      <div className="min-w-0">
        <p className="text-sm text-ink">{label}</p>
        {help && <p className="mt-0.5 text-xs text-ink-3">{help}</p>}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}

function UrlField({ value }: { value: string }) {
  return (
    <div className="flex min-w-0 items-center gap-1 rounded-lg border border-line bg-sunken pr-1 pl-2.5">
      <span
        className="min-w-0 flex-1 truncate py-1.5 font-mono text-xs text-ink-2"
        title={value}
      >
        {value}
      </span>
      <CopyButton text={value} />
    </div>
  );
}

export function SettingsView({
  navigate,
  wide,
}: {
  navigate: Navigate;
  wide: boolean;
}) {
  const { t } = useLocale();
  const { theme, setTheme } = useTheme();
  const { systemStatus, refreshStatus, logout } = useAuth();
  const management = useManagement();
  const { notifications } = useLive();
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [lanUrls, setLanUrls] = useState<string[] | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    apiFetch<ConfigResponse>("/api/config")
      .then(setConfig)
      .catch((caught) => setError(String(caught)));
  }, [management.data?.generation]);

  const rotate = async () => {
    setError("");
    try {
      const result = await apiFetch<{ lanUrls: string[] }>(
        "/api/auth/regenerate-token",
        {
          method: "POST",
        },
      );
      setLanUrls(result.lanUrls);
      setMessage(t("settings.rotated"));
      await refreshStatus();
    } catch (caught) {
      setError(t("settings.rotateFailed", String(caught)));
    }
  };
  const reveal = async () => {
    setError("");
    try {
      await apiFetch("/api/config/reveal", { method: "POST" });
    } catch (caught) {
      setError(t("settings.revealFailed", String(caught)));
    }
  };
  const clear = async () => {
    setError("");
    try {
      await apiFetch("/api/calls", { method: "DELETE" });
      setMessage(t("settings.cleared"));
      await refreshStatus();
    } catch (caught) {
      setError(t("activity.clearFailed", String(caught)));
    }
  };

  const urls = lanUrls ?? systemStatus?.web.lanUrls ?? [];
  const path = config?.config_path ?? config?.config_file;
  const endpoint = systemStatus
    ? `http://${systemStatus.mcp.host}:${systemStatus.mcp.port}/mcp`
    : "";
  const notificationEnabled = notifications.state === "enabled";
  const notificationAvailable = !["denied", "unsupported", "insecure"].includes(
    notifications.state,
  );
  return (
    <PageFrame title={t("settings.title")} navigate={navigate} wide={wide}>
      {(message || error) && (
        <p
          role="status"
          className={`mb-5 text-sm ${error ? "text-err" : "text-ok"}`}
        >
          {error || message}
        </p>
      )}

      <Group title={t("settings.interface")}>
        <Row
          label={t("language.label")}
          help={t("language.help")}
          control={<LanguageOptions />}
        />
        <Row
          label={t("settings.theme")}
          control={
            <Segmented
              label={t("settings.theme")}
              value={theme}
              onChange={setTheme}
              options={[
                {
                  value: "system",
                  label: <Monitor className="h-3.5 w-3.5" />,
                  title: t("theme.system"),
                },
                {
                  value: "light",
                  label: <Sun className="h-3.5 w-3.5" />,
                  title: t("theme.light"),
                },
                {
                  value: "dark",
                  label: <Moon className="h-3.5 w-3.5" />,
                  title: t("theme.dark"),
                },
              ]}
            />
          }
        />
      </Group>

      <Group
        title={t("notification.label")}
        description={t("notification.help")}
      >
        <Row
          label={t(
            notifications.state === "enabled"
              ? "notification.enabled"
              : notifications.state === "paused"
                ? "notification.paused"
                : notifications.state === "denied"
                  ? "notification.denied"
                  : notifications.state === "insecure"
                    ? "notification.insecure"
                    : notifications.state === "unsupported"
                      ? "notification.unsupported"
                      : notifications.state === "error"
                        ? "notification.error"
                        : "notification.default",
          )}
          control={
            <div className="flex gap-2">
              {notificationEnabled && (
                <Button size="sm" onClick={notifications.test}>
                  {t("notification.test")}
                </Button>
              )}
              {notificationAvailable && (
                <Button
                  size="sm"
                  tone={notificationEnabled ? "secondary" : "primary"}
                  disabled={notifications.requesting}
                  onClick={() =>
                    notificationEnabled
                      ? notifications.pause()
                      : void notifications.enable()
                  }
                >
                  {notifications.requesting
                    ? t("notification.requesting")
                    : notificationEnabled
                      ? t("notification.pause")
                      : notifications.state === "error"
                        ? t("notification.retry")
                        : t("notification.enable")}
                </Button>
              )}
            </div>
          }
        />
      </Group>

      {management.data?.available && (
        <Group
          title={t("settings.execution")}
          description={t("settings.executionHelp")}
        >
          <Row
            label={t("config.login")}
            help={t("config.loginHelp")}
            control={
              <Switch
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
            }
          />
          <Row
            label={t("config.web")}
            help={t("config.webHelp")}
            control={
              <Switch
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
            }
          />
          <Row
            label={
              management.data.state === "restarting"
                ? t("runtime.reloading")
                : management.data.pending
                  ? t("runtime.pending")
                  : t("runtime.applied")
            }
            help={t("runtime.help")}
            control={
              <ConfirmButton
                disabled={management.busy}
                onConfirm={management.restart}
                confirmLabel={t("runtime.confirmRestart")}
              >
                <RotateCw className="h-3.5 w-3.5" />
                {t("runtime.restart")}
              </ConfirmButton>
            }
          />
          {(management.error || management.data.error) && (
            <p className="text-xs text-err">
              {management.error || management.data.error}
            </p>
          )}
        </Group>
      )}

      <Group title={t("settings.access")} description={t("config.accessHelp")}>
        {systemStatus && (
          <div className="space-y-1.5">
            <p className="text-xs text-ink-3">{t("config.loopback")}</p>
            <UrlField value={systemStatus.web.loopbackUrl} />
          </div>
        )}
        <div className="space-y-1.5">
          <p className="text-xs text-ink-3">{t("config.lan")}</p>
          {systemStatus?.web.exposed ? (
            urls.length ? (
              urls.map((url) => <UrlField key={url} value={url} />)
            ) : (
              <p className="text-sm text-ink-2">{t("config.privateLinks")}</p>
            )
          ) : (
            <p className="text-sm text-ink-2">{t("config.lanDisabled")}</p>
          )}
        </div>
        <div className="flex flex-wrap gap-2 pt-1">
          {systemStatus?.isLoopback && systemStatus.web.exposed && (
            <ConfirmButton
              onConfirm={rotate}
              confirmLabel={t("settings.rotateConfirm")}
            >
              <RotateCw className="h-3.5 w-3.5" />
              {t("config.rotate")}
            </ConfirmButton>
          )}
          {systemStatus && !systemStatus.isLoopback && (
            <Button size="sm" onClick={() => void logout()}>
              <LogOut className="h-3.5 w-3.5" />
              {t("header.logout")}
            </Button>
          )}
        </div>
      </Group>

      <Group
        title={t("settings.configuration")}
        description={t("config.summary")}
      >
        {path && (
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-0 flex-1">
              <UrlField value={path} />
            </div>
            {systemStatus?.isLoopback && config?.config_path && (
              <Button size="sm" onClick={() => void reveal()}>
                <FolderOpen className="h-3.5 w-3.5" />
                {t("config.openFolder")}
              </Button>
            )}
          </div>
        )}
        {config && (
          <CodeView
            code={JSON.stringify(config, null, 2)}
            language="json"
            collapsedLines={12}
          />
        )}
      </Group>

      <Group
        title={t("settings.history")}
        description={t("settings.historyHelp")}
      >
        <ConfirmButton
          onConfirm={clear}
          confirmLabel={t("activity.clearConfirm")}
          disabled={!systemStatus?.stats.totalCalls}
        >
          <Trash2 className="h-3.5 w-3.5" />
          {t("activity.clear")}
        </ConfirmButton>
      </Group>

      {systemStatus && (
        <Group title={t("settings.about")}>
          <Panel>
            <dl className="grid grid-cols-[minmax(0,160px)_minmax(0,1fr)] gap-x-4 gap-y-2 px-4 py-3 text-sm">
              <dt className="text-ink-3">{t("settings.version")}</dt>
              <dd className="tabular text-ink">{systemStatus.version}</dd>
              <dt className="text-ink-3">{t("settings.host")}</dt>
              <dd className="truncate text-ink">
                {systemStatus.system.hostname ?? "—"}
              </dd>
              <dt className="text-ink-3">{t("settings.platform")}</dt>
              <dd className="font-mono text-xs text-ink">
                {systemStatus.system.platform} · {systemStatus.system.arch} ·
                Node {systemStatus.system.nodeVersion}
              </dd>
              <dt className="text-ink-3">{t("settings.endpoint")}</dt>
              <dd className="flex min-w-0 items-center gap-1 font-mono text-xs text-ink">
                <span className="truncate">{endpoint}</span>
                <span className="shrink-0 text-ink-3">
                  · {systemStatus.mcp.access}
                </span>
              </dd>
              <dt className="text-ink-3">{t("settings.uptime")}</dt>
              <dd className="tabular text-ink">
                {formatDuration(systemStatus.uptime * 1000, t)}
              </dd>
            </dl>
          </Panel>
        </Group>
      )}
    </PageFrame>
  );
}

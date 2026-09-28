import {
  Bell,
  BellOff,
  BellRing,
  Clock3,
  Command,
  Cpu,
  Files,
  Layers,
  Monitor,
  Moon,
  Plug,
  Search,
  Settings,
  Sun,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { VERSION } from "../../../../src/version";
import { useAuth } from "../../context/AuthContext";
import { useLive, type Connection } from "../../context/LiveContext";
import { useLocale } from "../../context/LocaleContext";
import { useManagement } from "../../context/ManagementContext";
import { useTheme } from "../../context/ThemeContext";
import {
  conversationState,
  sortConversations,
  UNSCOPED,
} from "../../lib/conversation";
import { listTime, plainMessage, shortId } from "../../lib/format";
import { plural } from "../../lib/locale";
import { routeHref, type Navigate, type Route } from "../../lib/router";
import { describeStep } from "../../lib/steps";
import { useFlip } from "../../lib/use-flip";
import { useNow } from "../../lib/use-now";
import type { NativeSessionItem, SessionSummary } from "../../types";
import { Button, Kbd, Popover } from "../ui/Controls";
import { BrandMark, Sigil } from "../ui/Sigil";
import { Spinner } from "../ui/StatusNode";

export function Sidebar({
  route,
  navigate,
  wide,
  onShortcuts,
}: {
  route: Route;
  navigate: Navigate;
  wide: boolean;
  onShortcuts(): void;
}) {
  const live = useLive();
  const { t } = useLocale();
  const { systemStatus } = useAuth();
  const management = useManagement();
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const conversations = useMemo(() => {
    const q = query.trim().toLowerCase();
    const items = (live.sessions ?? []).filter(
      (item) =>
        !q ||
        [
          item.id,
          item.label,
          item.lastCall?.preview,
          item.lastCall?.step?.preview,
          item.messagePreview,
        ]
          .filter(Boolean)
          .some((value) => value!.toLowerCase().includes(q)),
    );
    return sortConversations(items, live.native);
  }, [live.sessions, live.native, query]);
  useFlip(list, conversations.map((item) => item.id).join("|"));

  const selected = route.name === "conversation" ? route.id : undefined;
  useEffect(() => {
    const focus = () => search.current?.focus();
    const step = (event: Event) => {
      const direction = (event as CustomEvent<number>).detail;
      if (!conversations.length) return;
      const index = conversations.findIndex((item) => item.id === selected);
      const next =
        conversations[
          (index + direction + conversations.length) % conversations.length
        ];
      if (next) navigate({ name: "conversation", id: next.id });
    };
    window.addEventListener("exec:step-conversation", step);
    if (route.name !== "activity")
      window.addEventListener("exec:focus-search", focus);
    return () => {
      window.removeEventListener("exec:step-conversation", step);
      window.removeEventListener("exec:focus-search", focus);
    };
  }, [conversations, selected, navigate, route.name]);

  const running =
    live.terminals?.filter((item) => item.exitCode === undefined).length ?? 0;
  const machine: {
    route: Route;
    label: string;
    icon: LucideIcon;
    badge?: string | undefined;
    attention?: boolean;
  }[] = [
    {
      route: { name: "processes" },
      label: t("nav.processes"),
      icon: Cpu,
      badge: running ? String(running) : undefined,
      attention:
        live.memory?.status === "elevated" ||
        live.memory?.status === "exceeded",
    },
    { route: { name: "tools", tab: "mcp" }, label: t("nav.tools"), icon: Plug },
    { route: { name: "files" }, label: t("nav.files"), icon: Files },
    {
      route: { name: "settings" },
      label: t("nav.settings"),
      icon: Settings,
      attention: !!management.data?.pending,
    },
  ];

  return (
    <aside
      className={`flex h-full shrink-0 flex-col bg-sidebar ${wide ? "w-[288px] border-r border-line" : "w-full"}`}
    >
      <div className="flex items-center gap-2.5 px-4 pt-4 pb-3">
        <BrandMark size={22} />
        <div className="min-w-0 flex-1 leading-tight">
          <div className="text-sm font-semibold tracking-[-0.01em] text-ink">
            EXEC MCP
          </div>
          <div
            className="truncate text-2xs text-ink-3"
            title={systemStatus?.system.hostname}
          >
            {systemStatus?.system.hostname ?? t("sidebar.thisMachine")}
          </div>
        </div>
        <NotificationControl />
      </div>

      <div className="px-3 pb-2">
        <label className="flex h-8 items-center gap-2 rounded-lg border border-line bg-surface px-2.5 text-sm text-ink-3 transition-colors focus-within:border-line-strong">
          <Search className="h-3.5 w-3.5 shrink-0" strokeWidth={1.8} />
          <input
            ref={search}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setQuery("");
                event.currentTarget.blur();
              }
            }}
            placeholder={t("sidebar.search")}
            aria-label={t("sidebar.search")}
            className="min-w-0 flex-1 bg-transparent text-ink outline-none"
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label={t("common.clear")}
              className="text-ink-3 hover:text-ink"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : (
            <Kbd>/</Kbd>
          )}
        </label>
      </div>

      <nav
        aria-label={t("sidebar.conversations")}
        className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 scroll-thin"
      >
        <NavRow
          href={routeHref({ name: "activity" })}
          active={route.name === "activity"}
          icon={Layers}
          label={t("nav.activity")}
          badge={
            systemStatus?.stats.totalCalls
              ? systemStatus.stats.totalCalls.toLocaleString()
              : undefined
          }
        />
        <div className="mt-3 mb-1 flex items-center justify-between px-2.5 text-2xs font-medium text-ink-3">
          <span>{t("sidebar.conversations")}</span>
          {!!live.sessions?.length && (
            <span className="tabular">{live.sessions.length}</span>
          )}
        </div>
        <div ref={list} className="space-y-px">
          {conversations.map((item) => (
            <ConversationRow
              key={item.id}
              summary={item}
              native={live.native[item.id]}
              selected={item.id === selected}
            />
          ))}
        </div>
        {live.sessions && !conversations.length && (
          <p className="px-2.5 py-6 text-sm text-ink-3">
            {query ? t("sidebar.noMatches") : t("sidebar.empty")}
          </p>
        )}
      </nav>

      <nav
        aria-label={t("sidebar.machine")}
        className="space-y-px border-t border-line px-2 py-2"
      >
        {machine.map((item) => (
          <NavRow
            key={item.route.name}
            href={routeHref(item.route)}
            active={route.name === item.route.name}
            icon={item.icon}
            label={item.label}
            badge={item.badge}
            attention={item.attention}
          />
        ))}
      </nav>

      <footer className="flex items-center gap-2 border-t border-line px-4 py-2.5 text-2xs text-ink-3">
        <ConnectionStatus connection={live.connection} />
        <span className="tabular">v{systemStatus?.version ?? VERSION}</span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={onShortcuts}
          title={t("shortcuts.title")}
          aria-label={t("shortcuts.title")}
          className="flex h-6 w-6 items-center justify-center rounded-md hover:bg-hover hover:text-ink"
        >
          <Command className="h-3.5 w-3.5" strokeWidth={1.8} />
        </button>
        <ThemeCycle />
      </footer>
    </aside>
  );
}

function NavRow({
  href,
  active,
  icon: Icon,
  label,
  badge,
  attention,
}: {
  href: string;
  active: boolean;
  icon: LucideIcon;
  label: string;
  badge?: string | undefined;
  attention?: boolean | undefined;
}) {
  return (
    <a
      href={href}
      aria-current={active ? "page" : undefined}
      className={`flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-sm transition-colors ${active ? "bg-selected font-medium text-ink" : "text-ink-2 hover:bg-hover hover:text-ink"}`}
    >
      <Icon className="h-4 w-4 shrink-0" strokeWidth={1.7} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {attention && <span className="h-1.5 w-1.5 rounded-full bg-warn" />}
      {badge && <span className="tabular text-2xs text-ink-3">{badge}</span>}
    </a>
  );
}

function ConversationRow({
  summary,
  native,
  selected,
}: {
  summary: SessionSummary;
  native: NativeSessionItem | undefined;
  selected: boolean;
}) {
  const { t, locale } = useLocale();
  const now = useNow(30_000);
  const state = conversationState(summary, native);
  const unscoped = summary.id === UNSCOPED;
  const title = unscoped
    ? t("conversation.unscoped")
    : summary.label || t("conversation.untitled");
  const step = summary.lastCall?.step;
  const activity = step ? describeStep(step, t) : undefined;
  const activityText = activity
    ? [activity.verb, activity.subject].filter(Boolean).join(" ")
    : summary.lastCall?.preview;
  return (
    <a
      data-flip={summary.id}
      href={routeHref({ name: "conversation", id: summary.id })}
      aria-current={selected ? "page" : undefined}
      className={`group relative flex gap-2.5 rounded-lg px-2.5 py-2 transition-colors ${selected ? "bg-selected" : "hover:bg-hover"}`}
    >
      <Sigil
        id={summary.id}
        size={28}
        live={state.working}
        className="mt-0.5"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-1.5">
          <span
            className={`min-w-0 truncate text-sm ${summary.label || unscoped ? "font-medium text-ink" : "text-ink-2"}`}
          >
            {title}
          </span>
          {!summary.label && !unscoped && (
            <span className="shrink-0 font-mono text-2xs text-ink-3">
              {shortId(summary.id)}
            </span>
          )}
          <time
            className="ml-auto shrink-0 tabular text-2xs text-ink-3"
            dateTime={summary.lastActive}
          >
            {listTime(summary.lastActive, now, locale, t)}
          </time>
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-xs">
          {state.state === "asking" ? (
            <span className="min-w-0 truncate text-warn">
              {t("sidebar.asking", summary.questionPreview ?? "")}
            </span>
          ) : state.state === "message" ? (
            <span className="min-w-0 truncate font-medium text-ink">
              {t("sidebar.message", plainMessage(summary.messagePreview ?? ""))}
            </span>
          ) : state.working ? (
            <>
              <Spinner size={10} className="text-run" />
              <span className="min-w-0 truncate text-ink-2">
                {activityText ?? t("state.working")}
              </span>
            </>
          ) : state.background ? (
            <span className="min-w-0 truncate text-ink-2">
              {t("state.background")}
            </span>
          ) : (
            <span className="min-w-0 truncate text-ink-3">
              {activityText ?? t("sidebar.noCalls")}
            </span>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            {!!summary.pendingNotes && (
              <span
                className="flex items-center gap-0.5 tabular text-2xs text-ink-3"
                title={plural(
                  t,
                  summary.pendingNotes,
                  "sidebar.queuedNote",
                  "sidebar.queuedNotes",
                )}
              >
                <Clock3 className="h-3 w-3" strokeWidth={2} />
                {summary.pendingNotes}
              </span>
            )}
            {!!state.questions && (
              <span
                className="flex h-4 min-w-4 items-center justify-center rounded-full bg-warn px-1 tabular text-[10px] font-semibold text-surface"
                title={plural(
                  t,
                  state.questions,
                  "sidebar.questionWaiting",
                  "sidebar.questionsWaiting",
                )}
              >
                {state.questions}
              </span>
            )}
            {!!state.unread && (
              <span
                className="flex h-4 min-w-4 items-center justify-center rounded-full bg-run px-1 tabular text-[10px] font-semibold text-surface"
                title={plural(
                  t,
                  state.unread,
                  "sidebar.messageUnread",
                  "sidebar.messagesUnread",
                )}
              >
                {state.unread}
              </span>
            )}
          </span>
        </div>
      </div>
    </a>
  );
}

function ConnectionStatus({ connection }: { connection: Connection }) {
  const { t } = useLocale();
  const label =
    connection === "live"
      ? t("connection.live")
      : connection === "connecting"
        ? t("connection.connecting")
        : t("connection.offline");
  return (
    <span className="flex items-center gap-1.5" title={label}>
      <span
        className={`h-1.5 w-1.5 rounded-full ${connection === "live" ? "bg-ok" : connection === "connecting" ? "bg-ink-4" : "bg-err"}`}
      />
      {label}
    </span>
  );
}

function ThemeCycle() {
  const { theme, setTheme } = useTheme();
  const { t } = useLocale();
  const order = ["system", "light", "dark"] as const;
  const Icon = theme === "light" ? Sun : theme === "dark" ? Moon : Monitor;
  const label =
    theme === "light"
      ? t("theme.light")
      : theme === "dark"
        ? t("theme.dark")
        : t("theme.system");
  return (
    <button
      type="button"
      onClick={() =>
        setTheme(order[(order.indexOf(theme) + 1) % order.length]!)
      }
      title={label}
      aria-label={label}
      className="flex h-6 w-6 items-center justify-center rounded-md hover:bg-hover hover:text-ink"
    >
      <Icon className="h-3.5 w-3.5" strokeWidth={1.8} />
    </button>
  );
}

const NOTIFICATION_TEXT = {
  default: "notification.default",
  enabled: "notification.enabled",
  paused: "notification.paused",
  denied: "notification.denied",
  insecure: "notification.insecure",
  unsupported: "notification.unsupported",
  error: "notification.error",
} as const;

export function NotificationControl() {
  const { t } = useLocale();
  const { notifications } = useLive();
  const { state, requesting, enable, pause, test } = notifications;
  const enabled = state === "enabled";
  const available = !["denied", "unsupported", "insecure"].includes(state);
  const Icon = enabled ? BellRing : state === "paused" ? BellOff : Bell;
  return (
    <Popover
      label={t("notification.label")}
      align="end"
      panelClassName="w-72 p-3"
      trigger={({ toggle, ref, open, id }) => (
        <button
          ref={ref}
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-controls={id}
          title={t("notification.label")}
          aria-label={t("notification.label")}
          className={`relative flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-hover ${enabled ? "text-ink" : "text-ink-3"}`}
        >
          <Icon className="h-4 w-4" strokeWidth={1.7} />
          {enabled && (
            <span className="absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full bg-ok" />
          )}
        </button>
      )}
    >
      <p className="text-sm font-medium text-ink">{t("notification.label")}</p>
      <p role="status" className="mt-1 text-sm text-ink-2">
        {t(NOTIFICATION_TEXT[state])}
      </p>
      <div className="mt-3 flex gap-2">
        {available && (
          <Button
            tone={enabled ? "secondary" : "primary"}
            size="sm"
            disabled={requesting}
            onClick={() => (enabled ? pause() : void enable())}
          >
            {requesting
              ? t("notification.requesting")
              : enabled
                ? t("notification.pause")
                : state === "error"
                  ? t("notification.retry")
                  : t("notification.enable")}
          </Button>
        )}
        {enabled && (
          <Button size="sm" onClick={test}>
            {t("notification.test")}
          </Button>
        )}
      </div>
      <p className="mt-3 text-xs text-ink-3">{t("notification.help")}</p>
    </Popover>
  );
}

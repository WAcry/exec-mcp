import { SquareTerminal } from "lucide-react";
import { useMemo } from "react";
import { useLive } from "../../context/LiveContext";
import { useLocale } from "../../context/LocaleContext";
import { UNSCOPED } from "../../lib/conversation";
import { formatAgo, formatBytes, formatDuration } from "../../lib/format";
import { plural } from "../../lib/locale";
import { routeHref, type Navigate } from "../../lib/router";
import { useNow } from "../../lib/use-now";
import type {
  NativeSessionItem,
  SessionSummary,
  TerminalItem,
} from "../../types";
import { EmptyState, Meter, SectionTitle, Loading } from "../ui/Controls";
import { Sigil } from "../ui/Sigil";
import { PageFrame, Panel } from "./PageFrame";

function ConversationLink({
  id,
  sessions,
  mark = true,
}: {
  id: string | undefined;
  sessions: Map<string, SessionSummary>;
  mark?: boolean;
}) {
  const { t } = useLocale();
  if (!id) return null;
  const summary = sessions.get(id);
  return (
    <a
      href={routeHref({ name: "conversation", id })}
      className="inline-flex min-w-0 items-center gap-1.5 text-ink-2 hover:text-ink"
    >
      {mark && <Sigil id={id} size={14} />}
      <span className="truncate">
        {id === UNSCOPED
          ? t("conversation.unscoped")
          : summary?.label || id.slice(0, 6)}
      </span>
    </a>
  );
}

function TerminalRow({
  item,
  sessions,
}: {
  item: TerminalItem;
  sessions: Map<string, SessionSummary>;
}) {
  const { t, locale } = useLocale();
  const now = useNow(30_000);
  const running = item.exitCode === undefined;
  const usage =
    (item.bufferBytes / Math.max(1, item.bufferCapacityBytes)) * 100;
  return (
    <div className="grid grid-cols-[16px_minmax(0,1fr)] gap-x-3 px-4 py-3 sm:grid-cols-[16px_minmax(0,1fr)_180px]">
      <span className="flex h-5 items-center">
        <span
          className={`h-2 w-2 rounded-full ${running ? "bg-ok" : item.exitCode === 0 ? "bg-ink-4" : "bg-err"}`}
        />
      </span>
      <div className="min-w-0">
        <p
          className="truncate font-mono text-[12.5px] text-ink"
          title={item.command}
        >
          {item.command || item.id}
        </p>
        <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-ink-3">
          <span
            className={
              running ? "text-ok" : item.exitCode === 0 ? "" : "text-err"
            }
          >
            {running
              ? t("processes.running")
              : t("nested.exit", item.exitCode!)}
          </span>
          {item.cwd && (
            <span className="truncate font-mono" title={item.cwd}>
              {item.cwd}
            </span>
          )}
          <ConversationLink id={item.owner} sessions={sessions} />
          <span className="tabular">
            {item.pid ? `pid ${item.pid}` : ""} · {item.kind}
          </span>
          <span>{formatAgo(now - item.touched, t)}</span>
        </div>
        {!running && (
          <p className="mt-1 text-2xs text-ink-3">
            {t("processes.exitedHelp")}
          </p>
        )}
      </div>
      <div className="col-start-2 mt-2 sm:col-start-3 sm:mt-0">
        <div className="flex justify-between text-2xs tabular text-ink-3">
          <span>{t("processes.unread")}</span>
          <span>
            {formatBytes(item.bufferBytes, locale)} /{" "}
            {formatBytes(item.bufferCapacityBytes, locale)}
          </span>
        </div>
        <Meter
          value={usage}
          tone={usage > 90 ? "warn" : "neutral"}
          className="mt-1"
        />
        {item.omittedBytes > 0 && (
          <p className="mt-1 text-2xs text-warn">
            {t("processes.dropped", formatBytes(item.omittedBytes, locale))}
          </p>
        )}
      </div>
    </div>
  );
}

function SessionRow({
  item,
  sessions,
  idleHours,
  pressure,
}: {
  item: NativeSessionItem;
  sessions: Map<string, SessionSummary>;
  idleHours: number;
  pressure: boolean;
}) {
  const { t } = useLocale();
  const now = useNow(30_000);
  const busy = item.users > 0;
  const note = item.retired
    ? item.retired === "memory"
      ? t("processes.reclaimedMemory")
      : t("processes.released")
    : !busy
      ? item.isOldestIdle
        ? t("processes.oldestIdle")
        : t("processes.idlePolicy", idleHours)
      : item.isOldestActive
        ? t("processes.oldestActive")
        : t("processes.activePolicy");
  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <span className="mt-0.5">
        {item.scope ? (
          <Sigil id={item.scope} size={22} live={busy} />
        ) : (
          <Sigil id={UNSCOPED} size={22} />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-3 text-sm">
          {item.scope ? (
            <ConversationLink
              id={item.scope}
              sessions={sessions}
              mark={false}
            />
          ) : (
            <span className="text-ink-2">{t("processes.unscopedSession")}</span>
          )}
          <span
            className={`text-xs ${item.retired === "memory" ? "text-err" : busy ? "text-run" : "text-ink-3"}`}
          >
            {item.retired
              ? t("processes.reclaimed")
              : busy
                ? t("processes.busy")
                : t("processes.idle", formatDuration(now - item.idleSince, t))}
          </span>
          {item.activeCellCount > 0 && (
            <span className="text-xs text-ink-2">
              {plural(
                t,
                item.activeCellCount,
                "processes.cell",
                "processes.cells",
              )}{" "}
              <span className="font-mono text-ink-3">
                {item.activeCellIds.join(", ")}
              </span>
            </span>
          )}
        </div>
        <p
          className={`mt-0.5 text-xs ${pressure && item.isOldestIdle && !busy && !item.retired ? "text-warn" : "text-ink-3"}`}
        >
          {note}
        </p>
      </div>
    </div>
  );
}

export function ProcessesView({
  navigate,
  wide,
}: {
  navigate: Navigate;
  wide: boolean;
}) {
  const { t, locale } = useLocale();
  const live = useLive();
  const sessions = useMemo(
    () => new Map((live.sessions ?? []).map((item) => [item.id, item])),
    [live.sessions],
  );
  const terminals = useMemo(
    () =>
      [...(live.terminals ?? [])].sort(
        (a, b) =>
          Number(a.exitCode !== undefined) - Number(b.exitCode !== undefined) ||
          b.touched - a.touched,
      ),
    [live.terminals],
  );
  const memory = live.memory;
  const sampled =
    memory?.rssBytes !== undefined && memory.status !== "unsampled";
  const usage = sampled
    ? (memory!.rssBytes! / Math.max(1, memory!.highWaterBytes)) * 100
    : 0;
  return (
    <PageFrame
      title={t("processes.title")}
      description={t("processes.description")}
      navigate={navigate}
      wide={wide}
    >
      <section className="mb-8">
        <SectionTitle description={t("processes.terminalsHelp")}>
          {t("processes.commands")}
        </SectionTitle>
        {!live.terminals ? (
          <Loading />
        ) : terminals.length === 0 ? (
          <Panel>
            <EmptyState
              icon={<SquareTerminal className="h-6 w-6" strokeWidth={1.5} />}
              title={t("processes.noTerminals")}
            >
              {t("processes.noTerminalsHelp")}
            </EmptyState>
          </Panel>
        ) : (
          <Panel className="divide-y divide-line">
            {terminals.map((item) => (
              <TerminalRow key={item.id} item={item} sessions={sessions} />
            ))}
          </Panel>
        )}
      </section>

      <section className="mb-8">
        <SectionTitle
          description={t(
            "processes.sessionsHelp",
            memory?.idleRetentionHours ?? 72,
          )}
        >
          {t("processes.sessions")}
        </SectionTitle>
        {live.nativeList.length === 0 ? (
          <Panel>
            <EmptyState title={t("processes.noSessions")}>
              {t("processes.noSessionsHelp")}
            </EmptyState>
          </Panel>
        ) : (
          <Panel className="divide-y divide-line">
            {live.nativeList.map((item) => (
              <SessionRow
                key={item.id}
                item={item}
                sessions={sessions}
                idleHours={memory?.idleRetentionHours ?? 72}
                pressure={
                  memory?.status === "elevated" || memory?.status === "exceeded"
                }
              />
            ))}
          </Panel>
        )}
      </section>

      {memory && (
        <section>
          <SectionTitle description={t("processes.memoryHelp")}>
            {t("processes.memory")}
          </SectionTitle>
          <Panel className="px-4 py-4">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="text-xl font-semibold tabular text-ink">
                {sampled
                  ? formatBytes(memory.rssBytes!, locale)
                  : t("processes.unsampled")}
              </span>
              <span className="text-sm tabular text-ink-3">
                / {formatBytes(memory.highWaterBytes, locale)}
              </span>
              <span
                className={`text-sm ${memory.status === "exceeded" ? "text-err" : memory.status === "elevated" ? "text-warn" : "text-ok"}`}
              >
                {memory.status === "exceeded"
                  ? t("memory.exceeded")
                  : memory.status === "elevated"
                    ? t("memory.elevated")
                    : memory.status === "normal"
                      ? t("memory.normal")
                      : ""}
              </span>
            </div>
            {sampled && (
              <Meter
                value={usage}
                tone={
                  memory.status === "exceeded"
                    ? "err"
                    : memory.status === "elevated"
                      ? "warn"
                      : "neutral"
                }
                className="mt-3"
              />
            )}
            <p className="mt-3 text-xs text-ink-3">{t("memory.order")}</p>
          </Panel>
        </section>
      )}
    </PageFrame>
  );
}

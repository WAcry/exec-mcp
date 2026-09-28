import { ArrowUp, ChevronRight, CornerDownLeft } from "lucide-react";
import { Fragment, memo } from "react";
import type { SessionNote } from "../../../../src/session-notes-types";
import { useLocale } from "../../context/LocaleContext";
import { callStatusLabel } from "../../lib/call-presentation";
import { UNSCOPED } from "../../lib/conversation";
import { plural } from "../../lib/locale";
import {
  clockTime,
  formatDuration,
  formatElapsed,
  fullTime,
} from "../../lib/format";
import {
  describeCall,
  describeStep,
  latestStep,
  stepKind,
  type CallSummaryText,
} from "../../lib/steps";
import { useLazyMount } from "../../lib/use-lazy-mount";
import { useNow } from "../../lib/use-now";
import type { CallListItem, CallStatus, SessionSummary } from "../../types";
import { Sigil } from "../ui/Sigil";
import { StatusNode } from "../ui/StatusNode";
import { StepIcon } from "../ui/StepIcon";
import { effectiveStatus, hoverKey } from "./entries";
import { StepDetail } from "./StepDetail";

function Elapsed({ since }: { since: string }) {
  const now = useNow(1000);
  return (
    <span className="tabular text-run">
      {formatElapsed(now - new Date(since).getTime())}
    </span>
  );
}

function ToolStrip({ call }: { call: CallListItem }) {
  const { t } = useLocale();
  const steps = call.steps ?? [];
  if (!steps.length) return null;
  const hidden = call.subcallCount - steps.length;
  const gap = hidden > 0 ? Math.min(5, steps.length - 3) : -1;
  return (
    <span className="flex shrink-0 items-center gap-[3px]">
      {steps.map((step, index) => {
        const failed =
          step.status === "error" ||
          (step.exitCode !== undefined && step.exitCode !== 0);
        const summary = describeStep(step, t);
        const live =
          step.status === "running" &&
          (call.status === "running" || call.status === "yielding");
        return (
          <Fragment key={index}>
            {index === gap && (
              <span className="px-0.5 text-2xs tabular text-ink-3">
                +{hidden}
              </span>
            )}
            <span
              title={`${summary.verb} ${summary.subject ?? ""}${step.status === "running" ? "" : ` · ${formatDuration(step.durationMs, t)}`}`}
              className={failed ? "text-err" : live ? "text-run" : "text-ink-3"}
            >
              <StepIcon kind={stepKind(step.name)} className="h-3 w-3" />
            </span>
          </Fragment>
        );
      })}
    </span>
  );
}

export interface StepRowProps {
  call: CallListItem;
  expanded: boolean;
  active: boolean;
  highlighted: boolean;
  origin?: CallListItem | undefined;
  continuations?: CallListItem[] | undefined;
  carried?: SessionNote[] | undefined;
  conversation?: SessionSummary | undefined;
  /** Questions rendered under this row; the row then only marks the moment. */
  asked?: number;
  onToggle(id: string): void;
  onHover(key: string | null): void;
  onLocate(id: string): void;
  onOpenConversation?: ((id: string) => void) | undefined;
}

const STATUS_TEXT: Partial<
  Record<CallStatus, "state.failed" | "state.stopped">
> = { error: "state.failed", terminated: "state.stopped" };

export const StepRow = memo(function StepRow({
  call,
  expanded,
  active,
  highlighted,
  origin,
  continuations,
  carried,
  conversation,
  asked = 0,
  onToggle,
  onHover,
  onLocate,
  onOpenConversation,
}: StepRowProps) {
  const { t, locale } = useLocale();
  const described = describeCall(call, t);
  const summary: CallSummaryText =
    asked && call.subcallCount <= asked
      ? {
          verb: asked === 1 ? t("step.askedOne") : t("step.askedMany", asked),
          more: 0,
        }
      : described;
  const status = effectiveStatus(call, continuations);
  const wait = call.tool === "wait";
  const running = call.status === "running";
  const current = running ? latestStep(call) : undefined;
  const currentSummary = current ? describeStep(current, t) : undefined;
  const cell = wait ? call.args.cell_id : call.cellId;
  const key = hoverKey(call);
  const lastContinuation = continuations?.at(-1);
  const mounted = useLazyMount(expanded);

  const details: React.ReactNode[] = [];
  if (call.errorPreview)
    details.push(
      <span
        key="error"
        className="min-w-0 truncate font-mono text-[11.5px] text-err"
      >
        {call.errorPreview}
      </span>,
    );
  if (currentSummary)
    details.push(
      <span key="now" className="min-w-0 truncate text-ink-2">
        <span className="text-run">↳ </span>
        {currentSummary.verb}{" "}
        <span className={currentSummary.code ? "font-mono text-[11.5px]" : ""}>
          {currentSummary.subject}
        </span>
      </span>,
    );
  if (!wait && call.status === "yielding")
    details.push(
      <span key="background" className="min-w-0 truncate text-ink-2">
        {lastContinuation &&
        lastContinuation.status !== "yielding" &&
        lastContinuation.status !== "running"
          ? t(
              continuations!.length === 1
                ? "step.finishedLaterOne"
                : "step.finishedLater",
              clockTime(
                lastContinuation.endedAt ?? lastContinuation.startedAt,
                locale,
              ),
              continuations!.length,
            )
          : t("step.inBackground", cell ?? "")}
      </span>,
    );
  if (wait && origin)
    details.push(
      <button
        key="origin"
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onLocate(origin.id);
        }}
        className="inline-flex min-w-0 items-center gap-1 truncate text-ink-3 hover:text-ink"
      >
        <ArrowUp className="h-3 w-3 shrink-0" />
        {t("step.resumes", clockTime(origin.startedAt, locale))}
      </button>,
    );
  if (carried?.length)
    details.push(
      <span
        key="notes"
        className="inline-flex shrink-0 items-center gap-1 text-ink-2"
      >
        <CornerDownLeft className="h-3 w-3 text-ok" />
        {plural(t, carried.length, "step.carriedOne", "step.carried")}
      </span>,
    );

  return (
    <div
      id={`call-${call.id}`}
      data-call={call.id}
      className={`group/step relative ${highlighted ? "bg-[color-mix(in_srgb,var(--run)_7%,transparent)]" : ""} rounded-lg transition-colors duration-200`}
      onMouseEnter={() => onHover(key)}
      onMouseLeave={() => onHover(null)}
    >
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-label={t("calls.open", call.tool)}
        onClick={() => onToggle(call.id)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onToggle(call.id);
          }
        }}
        className={`grid cursor-pointer grid-cols-[48px_20px_minmax(0,1fr)_auto] items-start gap-x-2 rounded-lg px-2 outline-offset-[-2px] ${wait ? "py-1.5" : "py-2"} ${active ? "bg-hover" : ""} hover:bg-hover`}
      >
        <time
          dateTime={call.startedAt}
          title={fullTime(call.startedAt, locale)}
          className={`pt-px text-right tabular text-2xs text-ink-3 ${wait ? "opacity-70" : ""}`}
        >
          {clockTime(call.startedAt, locale)}
        </time>
        <span
          className="relative z-10 flex h-5 items-center justify-center"
          title={callStatusLabel({ ...call, status }, t)}
        >
          <span className="flex items-center justify-center rounded-full bg-bg p-[3px]">
            <StatusNode status={status} small={wait} />
          </span>
        </span>
        <div className="min-w-0">
          <div className="flex min-w-0 items-baseline gap-1.5 leading-5">
            {conversation && (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenConversation?.(conversation.id);
                }}
                title={conversation.label || conversation.id}
                className="inline-flex shrink-0 translate-y-[3px] items-center gap-1 self-start rounded-md pr-1 text-2xs text-ink-2 hover:text-ink"
              >
                <Sigil id={conversation.id} size={14} />
                <span
                  className={`max-w-32 truncate ${conversation.label || conversation.id === UNSCOPED ? "" : "font-mono"}`}
                >
                  {conversation.id === UNSCOPED
                    ? t("conversation.unscoped")
                    : conversation.label || conversation.id.slice(0, 6)}
                </span>
              </button>
            )}
            <span
              className={`shrink-0 ${wait ? "text-xs text-ink-3" : "text-sm text-ink-2"}`}
            >
              {summary.verb}
            </span>
            {summary.subject && (
              <span
                className={`min-w-0 truncate ${wait ? "text-xs text-ink-2" : "text-sm text-ink"} ${summary.code ? "font-mono text-[12.5px]" : ""}`}
                title={summary.subject}
              >
                {summary.subject}
              </span>
            )}
            {summary.detail && (
              <span className="min-w-0 truncate font-mono text-[11.5px] text-ink-3">
                {summary.detail}
              </span>
            )}
            {summary.more > 0 && (
              <span className="shrink-0 text-2xs tabular text-ink-3">
                {t("step.more", summary.more)}
              </span>
            )}
          </div>
          {(details.length > 0 || (call.steps?.length ?? 0) > 1) && (
            <div className="mt-0.5 flex min-w-0 items-center gap-2.5 text-xs leading-5">
              {(call.steps?.length ?? 0) > 1 && <ToolStrip call={call} />}
              {details}
            </div>
          )}
        </div>
        <span className="flex items-center gap-2 pt-px text-2xs text-ink-3">
          {STATUS_TEXT[status] && (
            <span className={status === "error" ? "text-err" : ""}>
              {t(STATUS_TEXT[status]!)}
            </span>
          )}
          {running ? (
            <Elapsed since={call.startedAt} />
          ) : (
            call.durationMs !== undefined && (
              <span className="tabular">
                {formatDuration(call.durationMs, t)}
              </span>
            )
          )}
          <ChevronRight
            className={`h-3.5 w-3.5 transition-transform duration-200 ${expanded ? "rotate-90 text-ink-2" : "opacity-0 group-hover/step:opacity-100"}`}
          />
        </span>
      </div>
      <div className="reveal" data-open={expanded}>
        <div inert={!expanded}>
          {mounted && (
            <div className="grid grid-cols-[48px_20px_minmax(0,1fr)] gap-x-2 px-2 pt-1 pb-3">
              <span />
              <span />
              <div className="fade-in min-w-0 overflow-hidden rounded-xl border border-line bg-surface">
                <StepDetail id={call.id} running={running} />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

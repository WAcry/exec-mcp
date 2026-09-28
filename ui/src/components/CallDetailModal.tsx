import { useLocale } from "../context/LocaleContext";
import { useEffect, useState } from "react";
import { CallRecord } from "../types";
import { CodeBlock } from "./CodeBlock";
import {
  callInput,
  callStatusLabel,
  hasSubcalls,
} from "../lib/call-presentation";
import {
  X,
  CheckCircle2,
  AlertCircle,
  Loader2,
  ArrowRight,
  Square,
} from "lucide-react";

interface CallDetailModalProps {
  call: CallRecord;
  onClose: () => void;
  refreshError?: string | null;
  onRefresh?: () => void;
}

const tabClass = (active: boolean) =>
  `flex items-center gap-1.5 pb-2 px-3 shrink-0 whitespace-nowrap text-xs font-medium border-b-2 transition-colors cursor-pointer ${
    active
      ? "border-zinc-900 dark:border-zinc-100 text-zinc-900 dark:text-zinc-100"
      : "border-transparent text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
  }`;

const notice =
  "px-3 py-2 rounded-md border border-zinc-200 dark:border-zinc-800 text-xs text-zinc-600 dark:text-zinc-400";

export function CallDetailModal({
  call,
  onClose,
  refreshError,
  onRefresh,
}: CallDetailModalProps) {
  const { t, locale } = useLocale();

  const [selectedTab, setActiveTab] = useState<
    "overview" | "input" | "subcalls" | "output"
  >("overview");
  const showSubcalls = hasSubcalls(call);
  const activeTab =
    selectedTab === "subcalls" && !showSubcalls ? "input" : selectedTab;
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="call-detail-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 bg-black/50"
    >
      <div className="w-full min-w-0 max-w-4xl max-h-[90vh] bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg shadow-lg flex flex-col overflow-hidden">
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-zinc-200 dark:border-zinc-800">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-mono text-xs text-zinc-500 dark:text-zinc-400">
                {call.tool}
              </span>
              <h3
                id="call-detail-title"
                className="text-sm break-all font-semibold text-zinc-900 dark:text-zinc-100 font-mono"
              >
                {call.id}
              </h3>
              <StatusBadge call={call} />
            </div>
            <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-1">
              {t("detail.session")}{" "}
              <span className="font-mono break-all text-zinc-700 dark:text-zinc-300">
                {call.sessionId}
              </span>{" "}
              {t("detail.started")}{" "}
              <span className="tabular-nums">
                {new Date(call.startedAt).toLocaleString(locale)}
              </span>
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label={t("detail.close")}
            className="p-1.5 -mr-1.5 rounded-md text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex items-center gap-1 overflow-x-auto shrink-0 px-5 pt-2.5 border-b border-zinc-200 dark:border-zinc-800">
          <button
            onClick={() => setActiveTab("overview")}
            aria-pressed={activeTab === "overview"}
            className={tabClass(activeTab === "overview")}
          >
            {t("detail.overview")}
          </button>
          <button
            onClick={() => setActiveTab("input")}
            aria-pressed={activeTab === "input"}
            className={tabClass(activeTab === "input")}
          >
            {t("detail.input")}
          </button>
          {showSubcalls && (
            <button
              onClick={() => setActiveTab("subcalls")}
              aria-pressed={activeTab === "subcalls"}
              className={tabClass(activeTab === "subcalls")}
            >
              <span>{t("detail.subcalls")}</span>
              <span className="tabular-nums text-zinc-400">
                {call.subcalls.length}
                {call.omittedSubcalls ? `+${call.omittedSubcalls}` : ""}
              </span>
            </button>
          )}
          <button
            onClick={() => setActiveTab("output")}
            aria-pressed={activeTab === "output"}
            className={tabClass(activeTab === "output")}
          >
            {t("detail.output")}
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {refreshError && (
            <div
              role="alert"
              className={`${notice} text-zinc-800 dark:text-zinc-200`}
            >
              {t("detail.refreshFailed")}
              {refreshError}
              <button
                onClick={onRefresh}
                className="ml-2 underline cursor-pointer"
              >
                {t("detail.reload")}
              </button>
            </div>
          )}
          {(call.truncatedFields ?? 0) > 0 && (
            <div role="note" className={notice}>
              {t("detail.truncated")}
            </div>
          )}
          {activeTab === "overview" && (
            <div className="space-y-5">
              <dl className="grid grid-cols-1 sm:grid-cols-3 gap-4 pb-5 border-b border-zinc-100 dark:border-zinc-800">
                <div className="min-w-0">
                  <dt className="text-xs text-zinc-500 dark:text-zinc-400">
                    {t("common.duration")}
                  </dt>
                  <dd className="mt-1 text-base font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                    {call.durationMs !== undefined
                      ? `${call.durationMs} ms`
                      : t("common.runningEllipsis")}
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-xs text-zinc-500 dark:text-zinc-400">
                    {t("detail.scope")}
                  </dt>
                  <dd
                    className="mt-1.5 text-xs font-mono text-zinc-900 dark:text-zinc-100 truncate"
                    title={call.sessionId}
                  >
                    {call.sessionId}
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-xs text-zinc-500 dark:text-zinc-400">
                    {t("detail.entry")}
                  </dt>
                  <dd className="mt-1 text-sm font-medium text-zinc-900 dark:text-zinc-100">
                    {call.tool === "exec"
                      ? t("detail.exec")
                      : call.tool === "wait"
                        ? t("detail.wait")
                        : t("detail.direct")}
                  </dd>
                </div>
              </dl>
              <InputParameters call={call} />
            </div>
          )}

          {activeTab === "input" && <InputParameters call={call} />}

          {activeTab === "subcalls" && (
            <div className="space-y-3">
              {(call.omittedSubcalls ?? 0) > 0 && (
                <div className={notice}>
                  {t("detail.omitted", call.omittedSubcalls ?? 0)}
                </div>
              )}
              {call.subcalls.length === 0 ? (
                <div className="p-10 text-center text-zinc-400 text-xs">
                  {t("detail.emptySubcalls")}
                </div>
              ) : (
                <ol className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {call.subcalls.map((sub, i) => (
                    <li
                      key={sub.id || i}
                      className="py-4 first:pt-0 last:pb-0 space-y-2.5"
                    >
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 min-w-0">
                          <span className="text-xs tabular-nums text-zinc-400">
                            {i + 1}
                          </span>
                          <span className="text-xs font-mono font-medium text-zinc-900 dark:text-zinc-100 break-all">
                            tools.{sub.name}
                          </span>
                          <span
                            className={`text-xs ${
                              sub.status === "success"
                                ? "text-zinc-500 dark:text-zinc-400"
                                : "font-medium text-rose-600 dark:text-rose-400"
                            }`}
                          >
                            {sub.status === "success"
                              ? t("detail.returned")
                              : t("detail.failed")}
                          </span>
                        </div>
                        <span className="text-xs tabular-nums text-zinc-400">
                          {sub.durationMs} ms
                        </span>
                      </div>

                      <div className="space-y-2 text-xs">
                        <div>
                          <span className="text-zinc-500 dark:text-zinc-400 text-[11px] block mb-1">
                            {t("detail.arguments")}
                          </span>
                          {sub.name === "apply_patch" &&
                          typeof sub.input === "string" ? (
                            <InputParameters
                              call={{
                                tool: sub.name,
                                args: { patch: sub.input },
                              }}
                            />
                          ) : sub.input &&
                            typeof sub.input === "object" &&
                            !Array.isArray(sub.input) ? (
                            <InputParameters
                              call={{
                                tool: sub.name,
                                args: sub.input as CallRecord["args"],
                              }}
                            />
                          ) : (
                            <CodeBlock
                              code={
                                typeof sub.input === "string"
                                  ? sub.input
                                  : (JSON.stringify(sub.input, null, 2) ??
                                    "undefined")
                              }
                              language={
                                typeof sub.input === "string" ? "text" : "json"
                              }
                              maxHeight="max-h-36"
                            />
                          )}
                        </div>

                        {sub.output !== undefined && (
                          <div>
                            <span className="text-zinc-500 dark:text-zinc-400 text-[11px] block mb-1">
                              {t("detail.result")}
                            </span>
                            <CodeBlock
                              code={
                                typeof sub.output === "string"
                                  ? sub.output
                                  : (JSON.stringify(sub.output, null, 2) ??
                                    "undefined")
                              }
                              language="json"
                              maxHeight="max-h-44"
                            />
                          </div>
                        )}

                        {sub.error && (
                          <p className="font-mono text-xs whitespace-pre-wrap break-words text-rose-700 dark:text-rose-400">
                            {sub.error}
                          </p>
                        )}
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}

          {activeTab === "output" && (
            <div className="space-y-4">
              {call.error && (
                <div className="p-3 rounded-md border border-zinc-200 dark:border-zinc-800">
                  <h5 className="font-semibold text-xs flex items-center gap-1 mb-1.5 text-rose-600 dark:text-rose-400">
                    <AlertCircle className="w-3.5 h-3.5" />
                    {t("detail.error")}
                  </h5>
                  <p className="font-mono text-xs whitespace-pre-wrap break-words text-zinc-800 dark:text-zinc-200">
                    {call.error}
                  </p>
                </div>
              )}

              {call.output !== undefined ? (
                <div>
                  <h5 className="text-xs text-zinc-500 dark:text-zinc-400 mb-2">
                    {t("detail.auditResult")}
                  </h5>
                  <CodeBlock
                    code={JSON.stringify(call.output, null, 2)}
                    language="json"
                    maxHeight="max-h-[450px]"
                  />
                </div>
              ) : (
                <div className="p-8 text-center text-zinc-400 text-xs">
                  {call.status === "running"
                    ? t("detail.waiting")
                    : call.status === "terminated"
                      ? t("detail.terminated")
                      : t("detail.empty")}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function InputParameters({
  call,
}: {
  call: Pick<CallRecord, "tool" | "args">;
}) {
  const { t } = useLocale();

  const { code, parameters } = callInput(call);
  return (
    <div className="space-y-3">
      {(!code || Object.keys(parameters).length > 0) && (
        <div>
          <h4 className="text-xs text-zinc-500 dark:text-zinc-400 mb-2">
            {code ? t("detail.otherParameters") : t("detail.parameters")}
          </h4>
          {(Object.hasOwn(call.args, "file") ||
            (Array.isArray(call.args.files) && call.args.files.length > 0)) && (
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-2">
              {t("detail.attachments")}
            </p>
          )}
          <CodeBlock
            code={JSON.stringify(parameters, null, 2)}
            language="json"
            maxHeight="max-h-60"
          />
        </div>
      )}
      {code && (
        <div>
          <h4 className="text-xs text-zinc-500 dark:text-zinc-400 mb-2">
            {t("detail.source", code.field)}
          </h4>
          <CodeBlock
            code={code.value}
            language={code.language}
            maxHeight="max-h-[450px]"
          />
        </div>
      )}
    </div>
  );
}

function StatusBadge({ call }: { call: CallRecord }) {
  const { t } = useLocale();
  const { status } = call;
  const label = callStatusLabel(call, t);
  const Icon =
    status === "running"
      ? Loader2
      : status === "completed"
        ? CheckCircle2
        : status === "yielding"
          ? ArrowRight
          : status === "terminated"
            ? Square
            : AlertCircle;
  return (
    <span
      className={`flex items-center gap-1 text-xs font-medium ${
        status === "error"
          ? "text-rose-600 dark:text-rose-400"
          : "text-zinc-600 dark:text-zinc-400"
      }`}
    >
      <Icon
        className={`w-3.5 h-3.5 ${status === "running" ? "animate-spin" : ""}`}
      />
      {label}
    </span>
  );
}

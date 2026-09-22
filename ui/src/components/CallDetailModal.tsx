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
  Clock,
  Layers,
  CheckCircle2,
  AlertCircle,
  Loader2,
  ArrowRight,
  Square,
  Zap,
} from "lucide-react";

interface CallDetailModalProps {
  call: CallRecord;
  onClose: () => void;
  refreshError?: string | null;
  onRefresh?: () => void;
}

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
      className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 bg-black/60 backdrop-blur-xs animate-in fade-in duration-150"
    >
      <div className="w-full min-w-0 max-w-4xl max-h-[90vh] bg-white dark:bg-[#121215] border border-zinc-200 dark:border-zinc-800 rounded-xl shadow-2xl flex flex-col overflow-hidden animate-in zoom-in-95 duration-200">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-950/40">
          <div className="flex flex-wrap min-w-0 items-center gap-2.5">
            <span className="px-2 py-0.5 rounded text-xs font-mono font-bold uppercase bg-zinc-100 dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200 border border-zinc-200 dark:border-zinc-700">
              {call.tool}
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3
                  id="call-detail-title"
                  className="text-sm break-all font-bold text-zinc-900 dark:text-zinc-100 font-mono"
                >
                  {call.id}
                </h3>
                <StatusBadge call={call} />
              </div>
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-0.5">
                {t("detail.session")}{" "}
                <span className="font-mono break-all text-zinc-700 dark:text-zinc-300">
                  {call.sessionId}
                </span>{" "}
                {t("detail.started")}{" "}
                {new Date(call.startedAt).toLocaleString(locale)}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label={t("detail.close")}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tab switcher */}
        <div className="flex items-center gap-1 overflow-x-auto shrink-0 px-5 pt-2.5 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-[#121215]">
          <button
            onClick={() => setActiveTab("overview")}
            aria-pressed={activeTab === "overview"}
            className={`pb-2 px-3 shrink-0 whitespace-nowrap text-xs font-medium border-b-2 transition-all cursor-pointer ${
              activeTab === "overview"
                ? "border-zinc-900 dark:border-zinc-100 text-zinc-900 dark:text-zinc-100 font-semibold"
                : "border-transparent text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
            }`}
          >
            {t("detail.overview")}
          </button>
          <button
            onClick={() => setActiveTab("input")}
            aria-pressed={activeTab === "input"}
            className={`pb-2 px-3 shrink-0 whitespace-nowrap text-xs font-medium border-b-2 transition-all cursor-pointer ${
              activeTab === "input"
                ? "border-zinc-900 dark:border-zinc-100 text-zinc-900 dark:text-zinc-100 font-semibold"
                : "border-transparent text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
            }`}
          >
            {t("detail.input")}
          </button>
          {showSubcalls && (
            <button
              onClick={() => setActiveTab("subcalls")}
              aria-pressed={activeTab === "subcalls"}
              className={`flex items-center shrink-0 whitespace-nowrap gap-1.5 pb-2 px-3 text-xs font-medium border-b-2 transition-all cursor-pointer ${
                activeTab === "subcalls"
                  ? "border-zinc-900 dark:border-zinc-100 text-zinc-900 dark:text-zinc-100 font-semibold"
                  : "border-transparent text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
              }`}
            >
              <span>{t("detail.subcalls")}</span>
              <span className="px-1.5 py-0.2 rounded text-[10px] bg-zinc-100 dark:bg-zinc-800 font-mono text-zinc-600 dark:text-zinc-400">
                {call.subcalls.length}
                {call.omittedSubcalls ? `+${call.omittedSubcalls}` : ""}
              </span>
            </button>
          )}
          <button
            onClick={() => setActiveTab("output")}
            aria-pressed={activeTab === "output"}
            className={`pb-2 px-3 shrink-0 whitespace-nowrap text-xs font-medium border-b-2 transition-all cursor-pointer ${
              activeTab === "output"
                ? "border-zinc-900 dark:border-zinc-100 text-zinc-900 dark:text-zinc-100 font-semibold"
                : "border-transparent text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
            }`}
          >
            {t("detail.output")}
          </button>
        </div>

        {/* Tab Content */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {refreshError && (
            <div
              role="alert"
              className="p-3 rounded-lg bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 text-xs"
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
            <div
              role="note"
              className="p-3 rounded-lg bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 text-xs"
            >
              {t("detail.truncated")}
            </div>
          )}
          {activeTab === "overview" && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="p-3 rounded-lg bg-zinc-50 dark:bg-zinc-900/60 border border-zinc-200 dark:border-zinc-800">
                  <span className="text-xs text-zinc-400 flex items-center gap-1 mb-1">
                    <Clock className="w-3.5 h-3.5" />
                    {t("common.duration")}
                  </span>
                  <span className="text-base font-mono font-semibold text-zinc-900 dark:text-zinc-100">
                    {call.durationMs !== undefined
                      ? `${call.durationMs} ms`
                      : t("common.runningEllipsis")}
                  </span>
                </div>
                <div className="p-3 rounded-lg bg-zinc-50 dark:bg-zinc-900/60 border border-zinc-200 dark:border-zinc-800">
                  <span className="text-xs text-zinc-400 flex items-center gap-1 mb-1">
                    <Layers className="w-3.5 h-3.5" />
                    {t("detail.scope")}
                  </span>
                  <span className="text-xs font-mono font-semibold text-zinc-900 dark:text-zinc-100 truncate block">
                    {call.sessionId}
                  </span>
                </div>
                <div className="p-3 rounded-lg bg-zinc-50 dark:bg-zinc-900/60 border border-zinc-200 dark:border-zinc-800">
                  <span className="text-xs text-zinc-400 flex items-center gap-1 mb-1">
                    <Zap className="w-3.5 h-3.5" />
                    {t("detail.entry")}
                  </span>
                  <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                    {call.tool === "exec"
                      ? t("detail.exec")
                      : call.tool === "wait"
                        ? t("detail.wait")
                        : t("detail.direct")}
                  </span>
                </div>
              </div>
              <InputParameters call={call} />
            </div>
          )}

          {activeTab === "input" && <InputParameters call={call} />}

          {activeTab === "subcalls" && (
            <div className="space-y-3">
              {(call.omittedSubcalls ?? 0) > 0 && (
                <div className="p-2.5 rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 text-amber-700 dark:text-amber-300 text-xs">
                  {t("detail.omitted", call.omittedSubcalls ?? 0)}
                </div>
              )}
              {call.subcalls.length === 0 ? (
                <div className="p-10 text-center text-zinc-400 text-xs">
                  {t("detail.emptySubcalls")}
                </div>
              ) : (
                call.subcalls.map((sub, i) => (
                  <div
                    key={sub.id || i}
                    className="p-3.5 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-900/40 space-y-2.5"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2 min-w-0">
                        <span className="text-[10px] font-mono font-bold px-1.5 py-0.2 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 border border-zinc-200 dark:border-zinc-700">
                          #{i + 1}
                        </span>
                        <span className="text-xs font-mono font-semibold text-zinc-900 dark:text-zinc-100 break-all">
                          tools.{sub.name}
                        </span>
                        <span
                          className={`text-[10px] px-1.5 py-0.2 rounded font-medium ${
                            sub.status === "success"
                              ? "bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800"
                              : "bg-rose-50 dark:bg-rose-950/60 text-rose-600 dark:text-rose-400 border border-rose-200 dark:border-rose-800"
                          }`}
                        >
                          {sub.status === "success"
                            ? t("detail.returned")
                            : t("detail.failed")}
                        </span>
                      </div>
                      <span className="text-xs font-mono text-zinc-400">
                        {sub.durationMs}ms
                      </span>
                    </div>

                    <div className="space-y-2 text-xs">
                      <div>
                        <span className="text-zinc-400 text-[10px] block mb-1">
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
                          <span className="text-zinc-400 text-[10px] block mb-1">
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
                        <div className="p-2.5 rounded bg-rose-50 dark:bg-rose-950/50 border border-rose-200 dark:border-rose-900 text-rose-700 dark:text-rose-300 font-mono text-xs">
                          {sub.error}
                        </div>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {activeTab === "output" && (
            <div className="space-y-3">
              {call.error && (
                <div className="p-3.5 rounded-lg bg-rose-50 dark:bg-rose-950/60 border border-rose-200 dark:border-rose-800 text-rose-700 dark:text-rose-300">
                  <h5 className="font-semibold text-xs flex items-center gap-1 mb-1">
                    <AlertCircle className="w-3.5 h-3.5" />
                    {t("detail.error")}
                  </h5>
                  <p className="font-mono text-xs whitespace-pre-wrap">
                    {call.error}
                  </p>
                </div>
              )}

              {call.output !== undefined ? (
                <div>
                  <h5 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400 mb-1.5">
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
  if (status === "running") {
    return (
      <span className="flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-amber-50 dark:bg-amber-950/60 text-amber-600 dark:text-amber-400 border border-amber-200 dark:border-amber-800">
        <Loader2 className="w-3 h-3 animate-spin" />
        {label}
      </span>
    );
  }
  if (status === "completed") {
    return (
      <span className="flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800">
        <CheckCircle2 className="w-3 h-3" />
        {label}
      </span>
    );
  }
  if (status === "yielding") {
    return (
      <span className="flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 border border-zinc-300 dark:border-zinc-700">
        <ArrowRight className="w-3 h-3" />
        {label}
      </span>
    );
  }
  if (status === "terminated") {
    return (
      <span className="flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 border border-zinc-300 dark:border-zinc-700">
        <Square className="w-3 h-3" />
        {label}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full bg-rose-50 dark:bg-rose-950/60 text-rose-600 dark:text-rose-400 border border-rose-200 dark:border-rose-800">
      <AlertCircle className="w-3 h-3" />
      {label}
    </span>
  );
}

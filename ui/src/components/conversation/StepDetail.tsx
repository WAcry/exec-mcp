import { CornerDownLeft, RotateCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useLiveEvents } from "../../context/LiveContext";
import { useLocale } from "../../context/LocaleContext";
import { apiFetch } from "../../lib/api";
import { callInput, hasSubcalls } from "../../lib/call-presentation";
import { coalesced } from "../../lib/coalesce";
import { formatDuration, fullTime } from "../../lib/format";
import { plural, type Translate } from "../../lib/locale";
import { parseToolResult } from "../../lib/results";
import type { CallRecord } from "../../types";
import { CopyButton } from "../ui/CopyButton";
import { CodeView, OutputView } from "../ui/CodeSurface";
import { Button, Loading } from "../ui/Controls";
import { NestedCall } from "./NestedCall";

function useCallDetail(id: string, live: boolean) {
  const [call, setCall] = useState<CallRecord | null>(null);
  const [error, setError] = useState("");
  const loader = useRef<ReturnType<typeof coalesced> | null>(null);
  useEffect(() => {
    let disposed = false;
    const load = coalesced(async () => {
      try {
        const value = await apiFetch<CallRecord>(
          `/api/calls/${encodeURIComponent(id)}`,
        );
        if (disposed) return;
        setCall(value);
        setError("");
      } catch (caught) {
        if (!disposed) setError(String(caught));
      }
    }, 150);
    loader.current = load;
    load.now();
    const poll = live ? window.setInterval(load.schedule, 3000) : undefined;
    return () => {
      disposed = true;
      loader.current = null;
      load.dispose();
      if (poll !== undefined) window.clearInterval(poll);
    };
  }, [id, live]);
  useLiveEvents((event) => {
    if (
      (event.type === "call:subcall" || event.type === "call:finish") &&
      event.callId === id
    )
      loader.current?.schedule();
  });
  return { call, error, reload: () => loader.current?.now() };
}

function Section({
  title,
  children,
  aside,
}: {
  title: string;
  children: React.ReactNode;
  aside?: React.ReactNode;
}) {
  return (
    <section className="px-4 py-3">
      <div className="mb-2 flex items-center gap-2 text-2xs font-medium text-ink-3">
        <span>{title}</span>
        {aside && <span className="ml-auto">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

/** The model-visible status header, in the interface language. */
function scriptStatus(status: string, t: Translate): string {
  if (status === "Script completed") return t("status.completed");
  if (status === "Script failed") return t("status.failed");
  if (status === "Script terminated") return t("common.stopped");
  return t("status.yielding");
}

export function StepDetail({ id, running }: { id: string; running: boolean }) {
  const { t, locale } = useLocale();
  const { call, error, reload } = useCallDetail(id, running);
  if (!call)
    return error ? (
      <div className="flex items-center gap-3 px-4 py-3 text-sm text-err">
        {t("detail.loadFailed", error)}
        <Button size="sm" onClick={reload}>
          <RotateCw className="h-3.5 w-3.5" />
          {t("common.retry")}
        </Button>
      </div>
    ) : (
      <div className="px-4">
        <Loading />
      </div>
    );

  const result = parseToolResult(call.output);
  const { code, parameters: input } = callInput(call);
  const source = code?.value ?? "";
  const many = call.subcalls.length > 3;
  const files = Array.isArray(input.files) ? input.files : [];
  const parameters = Object.entries(input).flatMap(([key, value]) =>
    key === "files" || value === undefined
      ? []
      : [
          [
            key,
            typeof value === "string" ? value : JSON.stringify(value),
          ] as const,
        ],
  );

  return (
    <div className="divide-y divide-line">
      {hasSubcalls(call) && call.subcalls.length > 0 && (
        <section className="py-1">
          {(call.omittedSubcalls ?? 0) > 0 && (
            <p className="px-4 pt-2 text-2xs text-ink-3">
              {t("detail.omitted", call.omittedSubcalls ?? 0)}
            </p>
          )}
          <div className="divide-y divide-line">
            {call.subcalls.map((subcall, index) => (
              <NestedCall
                key={subcall.id || index}
                subcall={subcall}
                live={call.status === "running" || call.status === "yielding"}
                defaultOpen={
                  subcall.status !== "success" ||
                  !many ||
                  (running && index === call.subcalls.length - 1)
                }
              />
            ))}
          </div>
        </section>
      )}

      {source && (
        <Section
          title={t("detail.script")}
          aside={
            call.subcalls.length === 0 && call.status === "running"
              ? t("detail.noToolsYet")
              : undefined
          }
        >
          <CodeView
            code={source}
            language="javascript"
            collapsedLines={call.subcalls.length ? 6 : 16}
          />
        </Section>
      )}

      {call.tool === "wait" && !source && parameters.length > 0 && (
        <Section title={t("detail.request")}>
          <div className="flex flex-wrap gap-1.5">
            {parameters.map(([key, value]) => (
              <span
                key={key}
                className="rounded-md bg-hover px-1.5 py-0.5 font-mono text-2xs text-ink-2"
              >
                {key}: {value}
              </span>
            ))}
          </div>
        </Section>
      )}

      {call.output !== undefined && (
        <Section
          title={
            result.isError ? t("detail.returnedError") : t("detail.returned")
          }
          aside={
            result.status
              ? `${scriptStatus(result.status, t)}${result.wallSeconds !== undefined ? ` · ${formatDuration(result.wallSeconds * 1000, t)}` : ""}`
              : undefined
          }
        >
          <div className="space-y-2">
            {result.preview !== undefined ? (
              <OutputView text={result.preview} />
            ) : (
              <>
                <OutputView
                  text={result.text}
                  empty={t("detail.noOutput")}
                  collapsedLines={12}
                />
                {result.structured !== undefined && (
                  <CodeView
                    code={JSON.stringify(result.structured, null, 2) ?? ""}
                    language="json"
                    collapsedLines={10}
                  />
                )}
                {result.media.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 text-2xs text-ink-3">
                    {result.media.map((item, index) => (
                      <span
                        key={index}
                        className="rounded-md bg-hover px-1.5 py-0.5"
                      >
                        {item.type} ·{" "}
                        <span className="font-mono">{item.label}</span>
                      </span>
                    ))}
                  </div>
                )}
              </>
            )}
            {result.notes.map((note, index) => (
              <div
                key={index}
                className="flex gap-2 rounded-lg border border-line px-3 py-2 text-sm"
              >
                <CornerDownLeft className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ok" />
                <div className="min-w-0">
                  <p className="text-2xs font-medium text-ink-3">
                    {t("detail.noteDelivered")}
                  </p>
                  <p className="whitespace-pre-wrap text-ink">{note}</p>
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}

      {call.error && call.output === undefined && (
        <Section title={t("detail.error")}>
          <OutputView text={call.error} />
        </Section>
      )}

      <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 text-2xs text-ink-3">
        <span className="flex items-center gap-1">
          <span className="font-mono">{call.id}</span>
          <CopyButton text={call.id} className="h-5 w-5" />
        </span>
        <span className="tabular">{fullTime(call.startedAt, locale)}</span>
        {call.tool !== "wait" &&
          parameters.map(([key, value]) => (
            <span key={key} className="font-mono">
              {key}={value}
            </span>
          ))}
        {files.length > 0 && (
          <span>
            {plural(t, files.length, "detail.file", "detail.files")}
            {": "}
            <span className="font-mono">
              {files
                .map((file) => (file as { name?: string }).name ?? "?")
                .join(", ")}
            </span>
          </span>
        )}
        {(call.truncatedFields ?? 0) > 0 && (
          <span className="w-full">{t("detail.truncated")}</span>
        )}
      </footer>
    </div>
  );
}

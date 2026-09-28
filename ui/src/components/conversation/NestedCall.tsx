import { ChevronRight, CircleAlert } from "lucide-react";
import { useState } from "react";
import { useLocale } from "../../context/LocaleContext";
import { formatBytes, formatDuration, visibleKeys } from "../../lib/format";
import { routeHref } from "../../lib/router";
import { useLazyMount } from "../../lib/use-lazy-mount";
import { asText, objectValue, parseToolResult } from "../../lib/results";
import {
  describeStep,
  mcpParts,
  stepKind,
  type StepKind,
} from "../../lib/steps";
import { nestedPreview } from "../../../../src/web/call-summary";
import type { SubCallRecord } from "../../types";
import { CodeView, OutputView, RichText } from "../ui/CodeSurface";
import { DiffView } from "../ui/DiffView";
import { Spinner } from "../ui/StatusNode";
import { StepIcon } from "../ui/StepIcon";

const KIND_LABEL = {
  command: "kind.command",
  stdin: "kind.stdin",
  patch: "kind.patch",
  question: "kind.question",
  image: "kind.image",
  export: "kind.export",
  import: "kind.import",
  skills: "kind.skills",
  resource: "kind.resource",
  mcp: "kind.mcp",
  tool: "kind.tool",
} as const satisfies Record<StepKind, string>;

function Chip({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone?: "ok" | "err" | "run";
}) {
  return (
    <span
      className={`inline-flex h-5 items-center gap-1 rounded-md px-1.5 text-2xs tabular ${tone === "ok" ? "text-ok" : tone === "err" ? "text-err" : tone === "run" ? "text-run" : "text-ink-3"} bg-hover`}
    >
      {children}
    </span>
  );
}

function TerminalBody({ subcall }: { subcall: SubCallRecord }) {
  const { t, locale } = useLocale();
  const input = objectValue(subcall.input) ?? {};
  const output = objectValue(subcall.output);
  const command =
    subcall.name === "exec_command"
      ? asText(input.cmd)
      : typeof input.chars === "string" && input.chars
        ? visibleKeys(input.chars)
        : "";
  const text = typeof output?.output === "string" ? output.output : "";
  const session =
    typeof output?.session_id === "string" ? output.session_id : undefined;
  const exit =
    typeof output?.exit_code === "number" ? output.exit_code : undefined;
  return (
    <div className="space-y-2">
      <div className="min-w-0 overflow-hidden rounded-lg border border-line bg-sunken">
        {command && (
          <div className="border-b border-line px-3 py-2 font-mono text-xs leading-[18px] whitespace-pre-wrap text-ink [overflow-wrap:anywhere]">
            <span className="text-ink-3 select-none">
              {subcall.name === "exec_command" ? "$ " : "› "}
            </span>
            {command}
          </div>
        )}
        {subcall.output !== undefined ? (
          <OutputView
            text={text}
            empty={t("nested.noOutput")}
            className="rounded-none border-0"
          />
        ) : (
          subcall.status === "running" && (
            <p className="px-3 py-2 text-2xs text-ink-3">
              {t("nested.outputLater")}
            </p>
          )
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {exit !== undefined && (
          <Chip tone={exit === 0 ? "ok" : "err"}>{t("nested.exit", exit)}</Chip>
        )}
        {session && (
          <a href={routeHref({ name: "processes" })}>
            <Chip tone="run">{t("nested.stillRunning", session)}</Chip>
          </a>
        )}
        {typeof output?.wall_time_seconds === "number" && (
          <Chip>{formatDuration(output.wall_time_seconds * 1000, t)}</Chip>
        )}
        {typeof input.workdir === "string" && (
          <Chip>
            <span className="font-mono">{input.workdir}</span>
          </Chip>
        )}
        {input.tty === true && <Chip>tty</Chip>}
        {typeof input.shell === "string" && (
          <Chip>
            <span className="font-mono">{input.shell}</span>
          </Chip>
        )}
        {typeof output?.omitted_bytes === "number" &&
          output.omitted_bytes > 0 && (
            <Chip>
              {t(
                "nested.omittedBytes",
                formatBytes(output.omitted_bytes, locale),
              )}
            </Chip>
          )}
      </div>
    </div>
  );
}

function QuestionBody({ subcall }: { subcall: SubCallRecord }) {
  const { t } = useLocale();
  const questions = objectValue(subcall.input)?.questions;
  return (
    <div className="space-y-3 rounded-lg border border-line bg-sunken px-3 py-2.5">
      {Array.isArray(questions) &&
        questions.map((raw, index) => {
          const question = objectValue(raw);
          const options = Array.isArray(question?.options)
            ? question.options
            : [];
          return (
            <div key={index}>
              <p className="text-sm whitespace-pre-wrap text-ink">
                {asText(question?.title)}
              </p>
              <ol className="mt-1.5 space-y-0.5 text-sm text-ink-2">
                {options.map((option, optionIndex) => (
                  <li key={optionIndex} className="flex gap-2">
                    <span className="tabular text-ink-3">
                      {optionIndex + 1}
                    </span>
                    <span className="whitespace-pre-wrap">
                      {asText(option)}
                    </span>
                    {optionIndex === 0 && (
                      <span className="text-2xs text-ink-3">
                        {t("question.recommended")}
                      </span>
                    )}
                  </li>
                ))}
              </ol>
            </div>
          );
        })}
    </div>
  );
}

function ExportBody({ subcall }: { subcall: SubCallRecord }) {
  const { t, locale } = useLocale();
  const output = objectValue(subcall.output);
  if (!output || typeof output.name !== "string")
    return <GenericBody subcall={subcall} />;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-lg border border-line bg-sunken px-3 py-2.5 text-xs">
      <dt className="text-ink-3">{t("files.name")}</dt>
      <dd className="font-mono text-ink">{output.name}</dd>
      {typeof output.size === "number" && (
        <>
          <dt className="text-ink-3">{t("files.size")}</dt>
          <dd className="tabular text-ink">
            {formatBytes(output.size, locale)}
          </dd>
        </>
      )}
      {typeof output.mime_type === "string" && (
        <>
          <dt className="text-ink-3">{t("files.type")}</dt>
          <dd className="font-mono text-ink">{output.mime_type}</dd>
        </>
      )}
      {typeof output.uri === "string" && (
        <>
          <dt className="text-ink-3">URI</dt>
          <dd className="font-mono break-all text-ink">{output.uri}</dd>
        </>
      )}
    </dl>
  );
}

function ToolResultBody({ output }: { output: unknown }) {
  const { t } = useLocale();
  const parsed = parseToolResult(output);
  if (parsed.preview !== undefined) return <OutputView text={parsed.preview} />;
  return (
    <div className="space-y-2">
      {parsed.isError && (
        <p className="text-xs font-medium text-err">{t("nested.toolError")}</p>
      )}
      {parsed.text && <OutputView text={parsed.text} />}
      {parsed.structured !== undefined && (
        <CodeView code={asText(parsed.structured)} language="json" />
      )}
      {parsed.media.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {parsed.media.map((item, index) => (
            <Chip key={index}>
              {item.type} · <span className="font-mono">{item.label}</span>
            </Chip>
          ))}
        </div>
      )}
    </div>
  );
}

function GenericBody({ subcall }: { subcall: SubCallRecord }) {
  const { t } = useLocale();
  const input = subcall.input;
  const hasInput =
    input !== undefined &&
    !(objectValue(input) && Object.keys(objectValue(input)!).length === 0);
  const output = subcall.output;
  const isToolResult =
    !!objectValue(output) && Array.isArray(objectValue(output)!.content);
  return (
    <div className="space-y-2">
      {hasInput && (
        <CodeView
          code={asText(input)}
          language={typeof input === "string" ? "text" : "json"}
          collapsedLines={8}
          header={t("nested.input")}
        />
      )}
      {output !== undefined &&
        (isToolResult ? (
          <ToolResultBody output={output} />
        ) : typeof output === "string" ? (
          <OutputView text={output} header={t("nested.output")} />
        ) : (
          <CodeView
            code={asText(output)}
            language="json"
            header={t("nested.output")}
          />
        ))}
    </div>
  );
}

function Body({ subcall, kind }: { subcall: SubCallRecord; kind: StepKind }) {
  switch (kind) {
    case "command":
    case "stdin":
      return <TerminalBody subcall={subcall} />;
    case "patch": {
      const patch =
        typeof subcall.input === "string"
          ? subcall.input
          : asText(objectValue(subcall.input)?.patch);
      return (
        <div className="space-y-2">
          <DiffView patch={patch} />
          {typeof subcall.output === "string" && subcall.output.trim() && (
            <p className="px-0.5 text-xs whitespace-pre-wrap text-ink-3">
              <RichText text={subcall.output.trim()} />
            </p>
          )}
        </div>
      );
    }
    case "question":
      return <QuestionBody subcall={subcall} />;
    case "export":
      return <ExportBody subcall={subcall} />;
    default:
      return <GenericBody subcall={subcall} />;
  }
}

export function NestedCall({
  subcall,
  defaultOpen,
  live,
}: {
  subcall: SubCallRecord;
  defaultOpen: boolean;
  /** The parent script is still running, so an unfinished step is in progress. */
  live: boolean;
}) {
  const { t } = useLocale();
  const [open, setOpen] = useState(defaultOpen);
  const mounted = useLazyMount(open);
  const kind = stepKind(subcall.name);
  const summary = describeStep(
    { name: subcall.name, preview: nestedPreview(subcall.name, subcall.input) },
    t,
  );
  const output = objectValue(subcall.output);
  const exit =
    typeof output?.exit_code === "number" ? output.exit_code : undefined;
  const failed = subcall.status === "error";
  const running = subcall.status === "running";
  const server = mcpParts(subcall.name)?.server;
  return (
    <div className="px-4 py-2.5">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="group flex w-full min-w-0 items-center gap-2 text-left"
      >
        <ChevronRight
          className={`h-3.5 w-3.5 shrink-0 text-ink-3 transition-transform duration-200 ${open ? "rotate-90" : ""}`}
        />
        <span className={failed ? "text-err" : "text-ink-3"}>
          <StepIcon kind={kind} />
        </span>
        <span className="shrink-0 text-xs font-medium text-ink-2">
          {kind === "mcp" && server ? server : t(KIND_LABEL[kind])}
        </span>
        <span
          className={`min-w-0 truncate text-sm ${summary.code ? "font-mono text-[12.5px]" : ""} text-ink`}
        >
          {summary.subject || summary.detail}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-2 text-2xs tabular text-ink-3">
          {running ? (
            live ? (
              <span className="flex items-center gap-1.5 text-run">
                <Spinner size={11} />
                {t("nested.running")}
              </span>
            ) : (
              t("nested.unfinished")
            )
          ) : (
            <>
              {exit !== undefined && exit !== 0 && (
                <span className="text-err">{t("nested.exit", exit)}</span>
              )}
              {failed && exit === undefined && (
                <span className="text-err">{t("nested.failed")}</span>
              )}
              {formatDuration(subcall.durationMs, t)}
            </>
          )}
        </span>
      </button>
      <div className="reveal" data-open={open}>
        <div inert={!open}>
          <div className="space-y-2 pt-2.5 pl-[22px]">
            {subcall.error && (
              <div className="flex gap-2 rounded-lg border border-line bg-sunken px-3 py-2 text-xs text-err">
                <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span className="font-mono whitespace-pre-wrap [overflow-wrap:anywhere]">
                  <RichText text={subcall.error} />
                </span>
              </div>
            )}
            {mounted && <Body subcall={subcall} kind={kind} />}
          </div>
        </div>
      </div>
    </div>
  );
}

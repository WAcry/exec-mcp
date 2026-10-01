import Prism from "prismjs";
import "prismjs/components/prism-javascript";
import "prismjs/components/prism-json";
import "prismjs/components/prism-bash";
import { ChevronDown } from "lucide-react";
import { Fragment, useMemo, useState, type ReactNode } from "react";
import { AUDIT_OMISSION_PATTERN } from "../../../../src/web/audit-format";
import { useLocale } from "../../context/LocaleContext";
import { hasAnsi, parseAnsi } from "../../lib/ansi";
import { CopyButton } from "./CopyButton";

const LINE = 18;

/** Long content folds to a readable height and expands in place. */
export function CodeSurface({
  lines,
  collapsedLines = 14,
  copyText,
  header,
  children,
  className = "",
}: {
  lines: number;
  collapsedLines?: number;
  copyText?: string;
  header?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const { t } = useLocale();
  const [expanded, setExpanded] = useState(false);
  const collapsible = lines > collapsedLines + 3;
  const folded = collapsible && !expanded;
  return (
    <div
      className={`group/code relative min-w-0 rounded-lg border border-line bg-sunken ${className}`}
    >
      {header && (
        <div className="flex min-h-8 items-center gap-2 border-b border-line px-3 text-2xs text-ink-3">
          {header}
        </div>
      )}
      <div
        className="relative overflow-hidden"
        style={folded ? { maxHeight: collapsedLines * LINE + 16 } : undefined}
      >
        <div className="code-view overflow-x-auto px-3 py-2 font-mono text-xs leading-[18px] text-ink scroll-thin">
          {children}
        </div>
        {folded && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-linear-to-t from-sunken to-transparent" />
        )}
      </div>
      {collapsible && (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            setExpanded((value) => !value);
          }}
          className="flex w-full items-center justify-center gap-1 border-t border-line py-1.5 text-2xs text-ink-3 transition-colors hover:bg-hover hover:text-ink"
        >
          <ChevronDown
            className={`h-3 w-3 transition-transform duration-200 ${expanded ? "rotate-180" : ""}`}
          />
          {expanded ? t("code.collapse") : t("code.expand", lines)}
        </button>
      )}
      {copyText !== undefined && (
        <CopyButton
          text={copyText}
          className={`absolute right-1 ${header ? "top-0.5" : "top-1"} bg-sunken opacity-0 group-hover/code:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100`}
        />
      )}
    </div>
  );
}

function lineCount(text: string): number {
  let count = 1;
  for (let index = 0; index < text.length; index++)
    if (text.charCodeAt(index) === 10) count++;
  return count;
}

export function CodeView({
  code,
  language,
  collapsedLines,
  header,
  className,
}: {
  code: string;
  language: "javascript" | "json" | "bash" | "text";
  collapsedLines?: number;
  header?: ReactNode;
  className?: string;
}) {
  const html = useMemo(() => {
    const grammar = language === "text" ? undefined : Prism.languages[language];
    return grammar
      ? Prism.highlight(code, grammar, language)
      : (Prism.util.encode(code) as string);
  }, [code, language]);
  return (
    <CodeSurface
      lines={lineCount(code)}
      copyText={code}
      {...(collapsedLines === undefined ? {} : { collapsedLines })}
      {...(header === undefined ? {} : { header })}
      {...(className === undefined ? {} : { className })}
    >
      <pre className="whitespace-pre-wrap [overflow-wrap:anywhere]">
        <code dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </CodeSurface>
  );
}

type OutputPart = { text: string } | { omitted: number };

function splitOmissions(text: string): OutputPart[] {
  const parts: OutputPart[] = [];
  let last = 0;
  for (const match of text.matchAll(AUDIT_OMISSION_PATTERN)) {
    if (match.index > last) parts.push({ text: text.slice(last, match.index) });
    parts.push({ omitted: Number(match[1]) });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

export function Omission({ characters }: { characters: number }) {
  const { t, locale } = useLocale();
  return (
    <span className="my-1.5 flex items-center gap-2 font-sans text-2xs text-ink-3 select-none">
      <span className="h-px flex-1 bg-line" />
      {t("code.omitted", characters.toLocaleString(locale))}
      <span className="h-px flex-1 bg-line" />
    </span>
  );
}

/** Text as the terminal showed it, with audit omissions as dividers. */
export function RichText({ text }: { text: string }) {
  const parts = useMemo(() => splitOmissions(text), [text]);
  return (
    <>
      {parts.map((part, index) =>
        "omitted" in part ? (
          <Omission key={index} characters={part.omitted} />
        ) : hasAnsi(part.text) ? (
          <Fragment key={index}>
            {parseAnsi(part.text).map((segment, inner) => (
              <span
                key={inner}
                style={{
                  ...(segment.fg ? { color: segment.fg } : {}),
                  ...(segment.bg ? { backgroundColor: segment.bg } : {}),
                  ...(segment.bold ? { fontWeight: 600 } : {}),
                  ...(segment.dim ? { opacity: 0.65 } : {}),
                  ...(segment.italic ? { fontStyle: "italic" } : {}),
                  ...(segment.underline ? { textDecoration: "underline" } : {}),
                }}
              >
                {segment.text}
              </span>
            ))}
          </Fragment>
        ) : (
          <Fragment key={index}>{part.text}</Fragment>
        ),
      )}
    </>
  );
}

export function OutputView({
  text,
  collapsedLines = 16,
  header,
  empty,
  className,
}: {
  text: string;
  collapsedLines?: number;
  header?: ReactNode;
  empty?: string;
  className?: string;
}) {
  const trimmed = text.replace(/\s+$/, "");
  return (
    <CodeSurface
      lines={lineCount(trimmed)}
      collapsedLines={collapsedLines}
      copyText={trimmed}
      {...(header === undefined ? {} : { header })}
      {...(className === undefined ? {} : { className })}
    >
      <div className="whitespace-pre-wrap [overflow-wrap:anywhere]">
        {trimmed ? (
          <RichText text={trimmed} />
        ) : (
          <span className="font-sans text-ink-3">{empty}</span>
        )}
      </div>
    </CodeSurface>
  );
}

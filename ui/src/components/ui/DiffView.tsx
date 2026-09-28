import { ChevronDown } from "lucide-react";
import { useMemo, useState } from "react";
import { useLocale } from "../../context/LocaleContext";
import { diffBlocks, parsePatch, type PatchFile } from "../../lib/patch";
import { CodeView, RichText } from "./CodeSurface";

const OPERATION = { add: "A", update: "M", delete: "D" } as const;
const OPERATION_LABEL = {
  add: "diff.add",
  update: "diff.update",
  delete: "diff.delete",
} as const;
const COLLAPSED_LINES = 40;

export function DiffStat({
  added,
  removed,
}: {
  added: number;
  removed: number;
}) {
  return (
    <span className="inline-flex items-center gap-2 tabular text-2xs">
      {added > 0 && <span className="text-ok">+{added}</span>}
      {removed > 0 && <span className="text-err">−{removed}</span>}
      <span className="flex gap-px" aria-hidden="true">
        {diffBlocks(added, removed).map((block, index) => (
          <span
            key={index}
            className={`h-2 w-2 rounded-[1.5px] ${block === "add" ? "bg-ok" : block === "remove" ? "bg-err" : "bg-line-strong"}`}
          />
        ))}
      </span>
    </span>
  );
}

function FileDiff({ file }: { file: PatchFile }) {
  const { t } = useLocale();
  const [expanded, setExpanded] = useState(false);
  const folded = file.lines.length > COLLAPSED_LINES + 6 && !expanded;
  const lines = folded ? file.lines.slice(0, COLLAPSED_LINES) : file.lines;
  return (
    <div className="min-w-0 overflow-hidden rounded-lg border border-line bg-sunken">
      <div className="flex min-h-8 items-center gap-2 border-b border-line px-3 text-xs">
        <span
          className={`w-3 shrink-0 text-center font-mono text-2xs font-semibold ${file.operation === "add" ? "text-ok" : file.operation === "delete" ? "text-err" : "text-ink-3"}`}
          title={t(OPERATION_LABEL[file.operation])}
        >
          {OPERATION[file.operation]}
        </span>
        <span className="min-w-0 truncate font-mono text-ink" title={file.path}>
          {file.path}
          {file.moveTo && <span className="text-ink-3"> → {file.moveTo}</span>}
        </span>
        <span className="ml-auto shrink-0">
          <DiffStat added={file.added} removed={file.removed} />
        </span>
      </div>
      {file.lines.length > 0 && (
        <div className="overflow-x-auto font-mono text-xs leading-[18px] scroll-thin">
          {lines.map((line, index) =>
            line.kind === "hunk" ? (
              <div
                key={index}
                className="border-y border-line bg-hover px-3 py-0.5 text-2xs text-ink-3 first:border-t-0"
              >
                @@ {line.text}
              </div>
            ) : (
              <div
                key={index}
                className={`flex min-w-max ${line.kind === "add" ? "bg-[color-mix(in_srgb,var(--ok)_9%,transparent)]" : line.kind === "remove" ? "bg-[color-mix(in_srgb,var(--err)_9%,transparent)]" : ""}`}
              >
                <span
                  className={`w-6 shrink-0 select-none text-center ${line.kind === "add" ? "text-ok" : line.kind === "remove" ? "text-err" : "text-ink-4"}`}
                >
                  {line.kind === "add"
                    ? "+"
                    : line.kind === "remove"
                      ? "−"
                      : ""}
                </span>
                <span className="whitespace-pre pr-4 text-ink">
                  <RichText text={line.text || " "} />
                </span>
              </div>
            ),
          )}
        </div>
      )}
      {file.lines.length > COLLAPSED_LINES + 6 && (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="flex w-full items-center justify-center gap-1 border-t border-line py-1.5 text-2xs text-ink-3 transition-colors hover:bg-hover hover:text-ink"
        >
          <ChevronDown
            className={`h-3 w-3 transition-transform duration-200 ${expanded ? "rotate-180" : ""}`}
          />
          {expanded ? t("code.collapse") : t("code.expand", file.lines.length)}
        </button>
      )}
    </div>
  );
}

export function DiffView({ patch }: { patch: string }) {
  const files = useMemo(() => parsePatch(patch), [patch]);
  if (!files.length) return <CodeView code={patch} language="text" />;
  return (
    <div className="space-y-2">
      {files.map((file, index) => (
        <FileDiff key={`${file.path}-${index}`} file={file} />
      ))}
    </div>
  );
}

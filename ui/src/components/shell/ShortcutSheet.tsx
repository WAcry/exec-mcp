import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import { useLocale } from "../../context/LocaleContext";
import type { MessageKey } from "../../lib/locale";
import { Kbd } from "../ui/Controls";

const SHORTCUTS: [string[], MessageKey][] = [
  [["j", "k"], "shortcuts.steps"],
  [["↵"], "shortcuts.expand"],
  [["c"], "shortcuts.compose"],
  [["1", "…", "7"], "shortcuts.answer"],
  [["f"], "shortcuts.find"],
  [["/"], "shortcuts.search"],
  [["[", "]"], "shortcuts.conversations"],
  [["?"], "shortcuts.toggle"],
];

export function ShortcutSheet({ onClose }: { onClose(): void }) {
  const { t } = useLocale();
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    panel.current?.focus();
  }, []);
  return (
    <div
      className="fade-in fixed inset-0 z-50 flex items-center justify-center bg-[rgb(0_0_0/0.28)] p-6"
      onClick={onClose}
    >
      <div
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={t("shortcuts.title")}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
        className="rise-in w-full max-w-sm rounded-2xl border border-line bg-surface p-5 shadow-(--pop-shadow) outline-none"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-md font-semibold text-ink">
            {t("shortcuts.title")}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.close")}
            className="flex h-7 w-7 items-center justify-center rounded-md text-ink-3 hover:bg-hover hover:text-ink"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <dl className="space-y-2.5 text-sm">
          {SHORTCUTS.map(([keys, label]) => (
            <div
              key={label}
              className="flex items-center justify-between gap-4"
            >
              <dt className="text-ink-2">{t(label)}</dt>
              <dd className="flex items-center gap-1">
                {keys.map((key) =>
                  key === "…" ? (
                    <span key={key} className="text-ink-3">
                      –
                    </span>
                  ) : (
                    <Kbd key={key}>{key}</Kbd>
                  ),
                )}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

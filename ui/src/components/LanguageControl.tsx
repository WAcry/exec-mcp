import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, Languages } from "lucide-react";
import { useLocale } from "../context/LocaleContext";

const languageNames = { en: "English", zh: "简体中文" };

function LanguageOptions() {
  const { preference, setLanguage, t } = useLocale();
  const name = useId();
  const helpId = useId();
  return (
    <fieldset className="min-w-0" aria-describedby={helpId}>
      <legend className="mb-2 text-xs font-medium text-zinc-700 dark:text-zinc-300">
        {t("language.label")}
      </legend>
      <div className="grid grid-cols-3 gap-1 rounded-lg bg-zinc-100 p-1 dark:bg-zinc-950">
        {(["auto", "en", "zh"] as const).map((value) => (
          <label key={value} className="min-w-0 cursor-pointer">
            <input
              type="radio"
              name={name}
              value={value}
              checked={preference === value}
              onChange={() => setLanguage(value)}
              className="peer sr-only"
            />
            <span
              lang={
                value === "auto" ? undefined : value === "zh" ? "zh-CN" : "en"
              }
              className="flex min-h-8 items-center justify-center rounded-md px-2 py-1.5 text-xs text-zinc-500 transition-colors hover:text-zinc-900 peer-checked:bg-white peer-checked:font-medium peer-checked:text-zinc-900 peer-checked:shadow-xs peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-zinc-500 dark:text-zinc-400 dark:hover:text-zinc-100 dark:peer-checked:bg-zinc-800 dark:peer-checked:text-zinc-100"
            >
              {value === "auto" ? t("language.auto") : languageNames[value]}
            </span>
          </label>
        ))}
      </div>
      <p id={helpId} className="mt-2 text-[11px] leading-relaxed text-zinc-500">
        {t("language.help")}
      </p>
    </fieldset>
  );
}

export function InterfacePreferences() {
  const { preference, locale, t } = useLocale();
  const current = languageNames[locale === "zh-CN" ? "zh" : "en"];
  return (
    <details className="group rounded-xl border border-zinc-200/80 bg-white shadow-xs dark:border-zinc-800/80 dark:bg-zinc-900/50">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-xl p-4 text-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-500 [&::-webkit-details-marker]:hidden">
        <span className="flex items-center gap-2 font-semibold text-zinc-900 dark:text-zinc-100">
          <Languages
            className="h-4 w-4 shrink-0 text-zinc-400"
            aria-hidden="true"
          />
          {t("preferences.title")}
        </span>
        <span className="flex min-w-0 items-center gap-2 text-zinc-500">
          <span className="truncate">
            {preference === "auto"
              ? t("language.auto") + " · " + current
              : current}
          </span>
          <ChevronDown
            className="h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-180"
            aria-hidden="true"
          />
        </span>
      </summary>
      <div className="border-t border-zinc-100 px-4 py-3 dark:border-zinc-800">
        <div className="max-w-sm">
          <LanguageOptions />
        </div>
      </div>
    </details>
  );
}

export function LoginLanguageControl() {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target))
        setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  return (
    <div
      ref={root}
      className="relative"
      onBlur={(event) => {
        // A label click can blur the trigger before its radio receives focus.
        if (
          event.relatedTarget &&
          !event.currentTarget.contains(event.relatedTarget)
        )
          setOpen(false);
      }}
      onKeyDown={(event) => {
        if (open && event.key === "Escape") {
          event.preventDefault();
          setOpen(false);
          toggle.current?.focus();
        }
      }}
    >
      <button
        ref={toggle}
        type="button"
        aria-label={t("language.label")}
        title={t("language.label")}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
      >
        <Languages className="h-4 w-4" aria-hidden="true" />
      </button>
      <div
        id={panelId}
        hidden={!open}
        className="absolute right-0 top-full z-10 mt-1 w-64 max-w-[calc(100vw-4rem)] rounded-xl border border-zinc-200 bg-white p-3 shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
      >
        <LanguageOptions />
      </div>
    </div>
  );
}

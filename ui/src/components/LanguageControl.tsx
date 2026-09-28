import { Languages } from "lucide-react";
import { useLocale } from "../context/LocaleContext";
import type { LanguagePreference } from "../lib/locale";
import { Popover, Segmented } from "./ui/Controls";

const languageNames = { en: "English", zh: "简体中文" };

export function LanguageOptions() {
  const { preference, setLanguage, t } = useLocale();
  return (
    <Segmented<LanguagePreference>
      label={t("language.label")}
      value={preference}
      onChange={setLanguage}
      options={[
        { value: "auto", label: t("language.auto") },
        { value: "en", label: <span lang="en">{languageNames.en}</span> },
        { value: "zh", label: <span lang="zh-CN">{languageNames.zh}</span> },
      ]}
    />
  );
}

export function LoginLanguageControl() {
  const { t } = useLocale();
  return (
    <Popover
      label={t("language.label")}
      align="end"
      panelClassName="w-auto p-3"
      trigger={({ toggle, ref, open, id }) => (
        <button
          ref={ref}
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-controls={id}
          aria-label={t("language.label")}
          title={t("language.label")}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-3 transition-colors hover:bg-hover hover:text-ink"
        >
          <Languages className="h-4 w-4" strokeWidth={1.8} />
        </button>
      )}
    >
      <p className="mb-2 text-xs font-medium text-ink-2">
        {t("language.label")}
      </p>
      <LanguageOptions />
      <p className="mt-2 max-w-64 text-2xs text-ink-3">{t("language.help")}</p>
    </Popover>
  );
}

import { Languages } from "lucide-react";
import { useLocale } from "../context/LocaleContext";
import { languagePreference } from "../lib/locale";

export function LanguageControl() {
  const { preference, setLanguage, t } = useLocale();
  return (
    <label
      className="inline-flex items-center gap-1 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-1.5 py-1 text-xs text-zinc-600 dark:text-zinc-300"
      title={t("language.label")}
    >
      <Languages className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
      <select
        aria-label={t("language.label")}
        value={preference}
        onChange={(event) =>
          setLanguage(languagePreference(event.target.value))
        }
        className="max-w-28 min-w-0 bg-transparent cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-500 dark:bg-zinc-900"
      >
        <option value="auto">{t("language.auto")}</option>
        <option value="en" lang="en">
          English
        </option>
        <option value="zh" lang="zh-CN">
          简体中文
        </option>
      </select>
    </label>
  );
}

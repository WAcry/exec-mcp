import { messages } from "./messages.js";

export const LANGUAGE_KEY = "exec_ui_language";
export type LanguagePreference = "auto" | "en" | "zh";
export type Locale = "en" | "zh-CN";
export type MessageKey = keyof typeof messages;
type Value = string | number;
export type Translate = (key: MessageKey, ...values: Value[]) => string;
export type Feedback = string | { key: MessageKey; values: Value[] };

export function languagePreference(value: unknown): LanguagePreference {
  return value === "en" || value === "zh" ? value : "auto";
}

/** Browser preferences describe the viewer, not the remote server's OS locale. */
export function resolveLocale(
  preference: LanguagePreference,
  languages: readonly string[],
): Locale {
  if (preference === "zh") return "zh-CN";
  if (preference === "en") return "en";
  for (const language of languages) {
    if (/^zh(?:-|$)/i.test(language)) return "zh-CN";
    if (/^en(?:-|$)/i.test(language)) return "en";
  }
  return "en";
}

export function readLanguagePreference(
  storage: Pick<Storage, "getItem">,
): LanguagePreference {
  try {
    return languagePreference(storage.getItem(LANGUAGE_KEY));
  } catch {
    return "auto";
  }
}

export function createTranslator(locale: Locale): Translate {
  return (key, ...values) =>
    messages[key][locale === "zh-CN" ? "zh" : "en"].replace(
      /\{(\d+)\}/g,
      (match, index: string) =>
        values[Number(index)] === undefined
          ? match
          : String(values[Number(index)]),
    );
}

/** Keep UI feedback translatable after a language switch; raw diagnostics stay raw. */
export function message(key: MessageKey, ...values: Value[]): Feedback {
  return { key, values };
}
export function feedback(value: Feedback, t: Translate): string {
  return typeof value === "string" ? value : t(value.key, ...value.values);
}

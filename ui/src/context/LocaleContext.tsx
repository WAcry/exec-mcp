import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  LANGUAGE_KEY,
  createTranslator,
  languagePreference,
  readLanguagePreference,
  resolveLocale,
  type LanguagePreference,
  type Locale,
  type Translate,
} from "../lib/locale";

const Context = createContext<{
  preference: LanguagePreference;
  locale: Locale;
  t: Translate;
  setLanguage(value: LanguagePreference): void;
} | null>(null);
function browserLanguages(): readonly string[] {
  return navigator.languages?.length
    ? navigator.languages
    : [navigator.language];
}

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [preference, setPreference] = useState<LanguagePreference>(() => {
    try {
      return readLanguagePreference(window.localStorage);
    } catch {
      return "auto";
    }
  });
  const [languages, setLanguages] = useState(browserLanguages);
  const locale = resolveLocale(preference, languages);
  const t = useMemo(() => createTranslator(locale), [locale]);
  useLayoutEffect(() => {
    document.documentElement.lang = locale;
    document.title = t("app.title");
  }, [locale, t]);
  useEffect(() => {
    const changed = () => setLanguages(browserLanguages());
    const stored = (event: StorageEvent) => {
      try {
        if (event.storageArea !== window.localStorage) return;
        if (event.key === LANGUAGE_KEY || event.key === null)
          setPreference(languagePreference(event.newValue));
      } catch {
        /* The current page's selection still works without storage. */
      }
    };
    window.addEventListener("languagechange", changed);
    window.addEventListener("storage", stored);
    return () => {
      window.removeEventListener("languagechange", changed);
      window.removeEventListener("storage", stored);
    };
  }, []);
  const value = useMemo(
    () => ({
      preference,
      locale,
      t,
      setLanguage(next: LanguagePreference) {
        setPreference(next);
        try {
          if (next === "auto") window.localStorage.removeItem(LANGUAGE_KEY);
          else window.localStorage.setItem(LANGUAGE_KEY, next);
        } catch {
          /* Keep the in-memory selection for this page. */
        }
      },
    }),
    [preference, locale, t],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useLocale() {
  const value = useContext(Context);
  if (!value) throw new Error("Missing LocaleProvider");
  return value;
}

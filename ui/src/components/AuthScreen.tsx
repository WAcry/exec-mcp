import { ShieldAlert } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useAuth } from "../context/AuthContext";
import { useLocale } from "../context/LocaleContext";
import { feedback, message, type Feedback } from "../lib/locale";
import { LoginLanguageControl } from "./LanguageControl";
import { Button } from "./ui/Controls";
import { BrandMark } from "./ui/Sigil";

export function AuthScreen() {
  const { t } = useLocale();
  const { verifyToken, isVerifying } = useAuth();
  const [token, setToken] = useState("");
  const [error, setError] = useState<Feedback>("");
  const [submitting, setSubmitting] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!token.trim() || submitting || isVerifying) return;
    setError("");
    setSubmitting(true);
    const ok = await verifyToken(token.trim());
    setSubmitting(false);
    if (!ok) setError(message("auth.invalid"));
    else setToken("");
  };
  return (
    <div className="flex h-full items-center justify-center bg-bg p-6">
      <div className="relative w-full max-w-sm">
        <div className="absolute -top-1 right-0">
          <LoginLanguageControl />
        </div>
        <BrandMark size={36} />
        <h1 className="mt-5 text-xl font-semibold text-ink">
          {t("auth.title")}
        </h1>
        <p className="mt-2 text-sm text-ink-2">{t("auth.help")}</p>
        <form
          onSubmit={(event) => void submit(event)}
          className="mt-6 space-y-3"
        >
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-ink-2">
              {t("auth.token")}
            </span>
            <input
              type="password"
              value={token}
              autoFocus
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              placeholder={t("auth.placeholder")}
              onChange={(event) => {
                setToken(event.target.value);
                setError("");
              }}
              className="h-10 w-full rounded-lg border border-line-strong bg-surface px-3 font-mono text-sm text-ink outline-none transition-colors focus:border-ink-3"
            />
          </label>
          {error && (
            <p className="flex items-start gap-1.5 text-xs text-err">
              <ShieldAlert className="mt-px h-3.5 w-3.5 shrink-0" />
              {feedback(error, t)}
            </p>
          )}
          <Button
            type="submit"
            tone="primary"
            className="h-10 w-full"
            disabled={isVerifying || submitting || !token.trim()}
          >
            {isVerifying || submitting ? t("auth.verifying") : t("auth.unlock")}
          </Button>
        </form>
        <p className="mt-6 text-xs text-ink-3">{t("auth.remember")}</p>
        <p className="mt-2 text-xs text-ink-3">{t("auth.boundary")}</p>
      </div>
    </div>
  );
}

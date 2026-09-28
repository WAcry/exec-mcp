import { useLocale } from "../context/LocaleContext";
import { message, feedback, type Feedback } from "../lib/locale";
import React, { useState } from "react";
import { useAuth } from "../context/AuthContext";
import { LoginLanguageControl } from "./LanguageControl";
import { ShieldAlert } from "lucide-react";

export function AuthModal() {
  const { t } = useLocale();

  const { verifyToken, isVerifying } = useAuth();
  const [inputToken, setInputToken] = useState("");
  const [errorMsg, setErrorMsg] = useState<Feedback>("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputToken.trim() || submitting || isVerifying) return;
    setErrorMsg("");
    setSubmitting(true);
    const ok = await verifyToken(inputToken.trim());
    setSubmitting(false);
    if (!ok) {
      setErrorMsg(message("auth.invalid"));
    } else {
      setInputToken("");
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-zinc-50 dark:bg-[#09090b]">
      <div className="panel relative w-full max-w-md p-6">
        <div className="absolute right-3 top-3">
          <LoginLanguageControl />
        </div>

        <p className="text-xs font-semibold text-zinc-500 dark:text-zinc-400">
          EXEC MCP
        </p>
        <h2 className="mt-1 pr-10 text-lg font-semibold text-zinc-900 dark:text-zinc-100">
          {t("auth.title")}
        </h2>
        <p className="mt-2 text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">
          {t("auth.help")}
        </p>
        <p className="mt-2 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
          {t("auth.remember")}
        </p>

        <form onSubmit={handleSubmit} className="mt-5 space-y-3">
          <div>
            <label
              htmlFor="web-access-token"
              className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1.5"
            >
              {t("auth.token")}
            </label>
            <input
              id="web-access-token"
              type="password"
              placeholder={t("auth.placeholder")}
              value={inputToken}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              onChange={(e) => {
                setInputToken(e.target.value);
                setErrorMsg("");
              }}
              className="w-full px-3 py-2 text-xs bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-md text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 focus:outline-none focus:border-zinc-400 dark:focus:border-zinc-600 focus:ring-1 focus:ring-zinc-400 dark:focus:ring-zinc-600 transition-colors font-mono"
              autoFocus
            />
          </div>

          {errorMsg && (
            <p className="flex items-start gap-1.5 text-xs text-rose-600 dark:text-rose-400">
              <ShieldAlert className="w-3.5 h-3.5 shrink-0 mt-px" />
              <span>{feedback(errorMsg, t)}</span>
            </p>
          )}

          <button
            type="submit"
            disabled={isVerifying || submitting || !inputToken.trim()}
            className="w-full py-2 px-3.5 rounded-md font-medium text-xs text-white bg-zinc-900 hover:bg-zinc-800 active:bg-black dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200 disabled:opacity-50 disabled:pointer-events-none transition-colors cursor-pointer"
          >
            {isVerifying || submitting ? t("auth.verifying") : t("auth.unlock")}
          </button>
        </form>

        <p className="mt-5 pt-3 border-t border-zinc-100 dark:border-zinc-800 text-[11px] text-zinc-500">
          {t("auth.boundary")}
        </p>
      </div>
    </div>
  );
}

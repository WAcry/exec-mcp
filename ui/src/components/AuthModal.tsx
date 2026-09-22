import { useLocale } from "../context/LocaleContext";
import { message, feedback, type Feedback } from "../lib/locale";
import React, { useState } from "react";
import { useAuth } from "../context/AuthContext";
import { LoginLanguageControl } from "./LanguageControl";
import { ShieldAlert, KeyRound, ArrowRight, Server, Lock } from "lucide-react";

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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs">
      <div className="relative w-full max-w-md p-6 bg-white dark:bg-[#121215] border border-zinc-200 dark:border-zinc-800 rounded-xl shadow-2xl animate-in fade-in zoom-in-95 duration-200">
        <div className="absolute right-3 top-3">
          <LoginLanguageControl />
        </div>
        <div className="flex items-center justify-center w-10 h-10 mb-4 rounded-lg bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 mx-auto">
          <Lock className="w-5 h-5" />
        </div>

        <h2 className="text-base font-bold text-center text-zinc-900 dark:text-zinc-100">
          {t("auth.title")}
        </h2>
        <p className="mt-1.5 text-xs text-center text-zinc-500 dark:text-zinc-400">
          {t("auth.help")}
        </p>
        <p className="mt-2 text-xs text-center text-zinc-500 dark:text-zinc-400">
          {t("auth.remember")}
        </p>

        <form onSubmit={handleSubmit} className="mt-5 space-y-3.5">
          <div>
            <label
              htmlFor="web-access-token"
              className="block text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 mb-1"
            >
              {t("auth.token")}
            </label>
            <div className="relative">
              <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400" />
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
                className="w-full pl-9 pr-3 py-2 text-xs bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-lg text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 focus:outline-none focus:border-zinc-400 dark:focus:border-zinc-600 focus:ring-1 focus:ring-zinc-400 dark:focus:ring-zinc-600 transition-colors font-mono"
                autoFocus
              />
            </div>
          </div>

          {errorMsg && (
            <div className="flex items-start gap-2 p-2.5 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900/50 rounded-lg">
              <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{feedback(errorMsg, t)}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={isVerifying || submitting || !inputToken.trim()}
            className="w-full flex items-center justify-center gap-1.5 py-2 px-3.5 rounded-lg font-medium text-xs text-white bg-zinc-900 hover:bg-zinc-800 active:bg-black dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-200 disabled:opacity-50 disabled:pointer-events-none transition-colors cursor-pointer"
          >
            {isVerifying || submitting ? t("auth.verifying") : t("auth.unlock")}
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </form>

        <div className="mt-5 pt-3 border-t border-zinc-100 dark:border-zinc-800/80 flex items-center gap-1.5 text-[11px] text-zinc-400 dark:text-zinc-500 justify-center">
          <Server className="w-3 h-3" />
          <span>{t("auth.boundary")}</span>
        </div>
      </div>
    </div>
  );
}

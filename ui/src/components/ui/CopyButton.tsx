import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useLocale } from "../../context/LocaleContext";

export function CopyButton({
  text,
  label,
  className = "",
  iconOnly = true,
}: {
  text: string;
  label?: string;
  className?: string;
  iconOnly?: boolean;
}) {
  const { t } = useLocale();
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = async (event: React.MouseEvent) => {
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), 1600);
  };
  const title =
    state === "copied"
      ? t("common.copied")
      : state === "failed"
        ? t("common.copyFailed")
        : (label ?? t("common.copy"));
  return (
    <button
      type="button"
      onClick={(event) => void copy(event)}
      title={title}
      aria-label={title}
      className={`inline-flex items-center gap-1.5 rounded-md text-ink-3 transition-colors hover:bg-hover hover:text-ink ${iconOnly ? "h-7 w-7 justify-center" : "h-7 px-2 text-xs"} ${className}`}
    >
      {state === "copied" ? (
        <Check className="h-3.5 w-3.5 text-ok" strokeWidth={2} />
      ) : (
        <Copy className="h-3.5 w-3.5" strokeWidth={1.8} />
      )}
      {!iconOnly && (
        <span className={state === "failed" ? "text-err" : ""}>{title}</span>
      )}
    </button>
  );
}

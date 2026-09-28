import { ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";
import { useLocale } from "../../context/LocaleContext";
import type { Navigate } from "../../lib/router";

/** Shared page chrome for everything that is not a conversation. */
export function PageFrame({
  title,
  description,
  actions,
  toolbar,
  children,
  navigate,
  wide,
  width = "max-w-[960px]",
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  toolbar?: ReactNode;
  children: ReactNode;
  navigate: Navigate;
  wide: boolean;
  width?: string;
}) {
  const { t } = useLocale();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-line">
        <div className={`mx-auto px-4 pt-4 pb-3 sm:px-6 ${width}`}>
          <div className="flex min-h-8 items-center gap-3">
            {!wide && (
              <button
                type="button"
                onClick={() => navigate({ name: "home" })}
                aria-label={t("common.back")}
                className="-ml-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-ink-2 hover:bg-hover"
              >
                <ChevronLeft className="h-5 w-5" />
              </button>
            )}
            <h1 className="min-w-0 flex-1 truncate text-lg font-semibold text-ink">
              {title}
            </h1>
            {actions && (
              <div className="flex shrink-0 items-center gap-2">{actions}</div>
            )}
          </div>
          {description && (
            <p className="mt-1 max-w-2xl text-sm text-ink-2">{description}</p>
          )}
        </div>
        {toolbar && (
          <div className={`mx-auto px-4 pb-3 sm:px-6 ${width}`}>{toolbar}</div>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto scroll-thin">
        <div className={`mx-auto px-4 py-5 sm:px-6 ${width}`}>{children}</div>
      </div>
    </div>
  );
}

export function Panel({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`overflow-hidden rounded-xl border border-line bg-surface ${className}`}
    >
      {children}
    </div>
  );
}

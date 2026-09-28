import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import { useLocale } from "../../context/LocaleContext";

type ButtonTone = "primary" | "secondary" | "ghost" | "danger";

const TONES: Record<ButtonTone, string> = {
  primary:
    "bg-ink text-bg hover:bg-[color-mix(in_srgb,var(--ink)_86%,var(--bg))] disabled:bg-ink-4 disabled:text-bg",
  secondary:
    "border border-line-strong bg-surface text-ink hover:bg-hover disabled:text-ink-4",
  ghost: "text-ink-2 hover:bg-hover hover:text-ink disabled:text-ink-4",
  danger:
    "border border-line-strong bg-surface text-err hover:bg-[color-mix(in_srgb,var(--err)_8%,var(--surface))] disabled:text-ink-4",
};

export function Button({
  tone = "secondary",
  size = "md",
  className = "",
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: ButtonTone;
  size?: "sm" | "md";
}) {
  return (
    <button
      type="button"
      {...props}
      className={`inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors duration-150 disabled:pointer-events-none ${size === "sm" ? "h-7 px-2.5 text-xs" : "h-8 px-3 text-sm"} ${TONES[tone]} ${className}`}
    >
      {children}
    </button>
  );
}

export function Switch({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange(value: boolean): void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-[18px] w-8 shrink-0 rounded-full transition-colors duration-200 disabled:opacity-50 ${checked ? "bg-ink" : "bg-line-strong"}`}
    >
      <span
        className={`absolute top-[2px] left-[2px] h-[14px] w-[14px] rounded-full bg-surface shadow-[0_1px_2px_rgb(0_0_0/0.25)] transition-transform duration-200 ease-(--ease-out) ${checked ? "translate-x-[14px]" : ""}`}
      />
    </button>
  );
}

/** Destructive actions arm on the first click and drain back to idle. */
export function ConfirmButton({
  onConfirm,
  children,
  confirmLabel,
  disabled,
  size = "sm",
  className = "",
}: {
  onConfirm(): void | Promise<void>;
  children: ReactNode;
  confirmLabel: string;
  disabled?: boolean;
  size?: "sm" | "md";
  className?: string;
}) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const click = async () => {
    if (!armed) {
      setArmed(true);
      timer.current = window.setTimeout(() => setArmed(false), 3200);
      return;
    }
    window.clearTimeout(timer.current);
    setArmed(false);
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button
      tone={armed ? "danger" : "secondary"}
      size={size}
      disabled={disabled || busy}
      onClick={() => void click()}
      onBlur={() => {
        window.clearTimeout(timer.current);
        setArmed(false);
      }}
      className={`relative overflow-hidden ${className}`}
    >
      {armed ? confirmLabel : children}
      {armed && (
        <span
          className="drain absolute inset-x-0 bottom-0 h-0.5 bg-err"
          style={{ ["--drain" as string]: "3.2s" }}
        />
      )}
    </Button>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: ReactNode; title?: string }[];
  onChange(value: T): void;
  label: string;
}) {
  const name = useId();
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex max-w-full overflow-x-auto rounded-lg bg-hover p-0.5 [scrollbar-width:none]"
    >
      {options.map((option) => (
        <label
          key={option.value}
          title={option.title}
          className="relative shrink-0 cursor-pointer"
        >
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={value === option.value}
            onChange={() => onChange(option.value)}
            className="peer sr-only"
          />
          <span className="flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs whitespace-nowrap text-ink-2 transition-colors peer-checked:bg-surface peer-checked:text-ink peer-checked:shadow-[0_1px_2px_rgb(0_0_0/0.08),0_0_0_1px_var(--line)] peer-focus-visible:outline-2 peer-focus-visible:outline-offset-1 peer-focus-visible:outline-run hover:text-ink">
            {option.label}
          </span>
        </label>
      ))}
    </div>
  );
}

export function Meter({
  value,
  tone = "neutral",
  className = "",
}: {
  value: number;
  tone?: "neutral" | "warn" | "err" | "ok";
  className?: string;
}) {
  const color =
    tone === "warn"
      ? "bg-warn"
      : tone === "err"
        ? "bg-err"
        : tone === "ok"
          ? "bg-ok"
          : "bg-ink-2";
  return (
    <span
      className={`block h-1 overflow-hidden rounded-full bg-line ${className}`}
    >
      <span
        className={`block h-full rounded-full transition-[width] duration-500 ease-(--ease-out) ${color}`}
        style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
      />
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-line-strong bg-surface px-1 font-sans text-[10px] leading-none text-ink-3">
      {children}
    </kbd>
  );
}

const VIEWPORT_GUTTER = 8;

/** Menus and small panels: outside click and Escape close them, focus returns. */
export function Popover({
  trigger,
  children,
  align = "start",
  side = "bottom",
  label,
  className = "",
  panelClassName = "w-64",
}: {
  trigger: (props: {
    open: boolean;
    toggle(): void;
    ref: React.RefObject<HTMLButtonElement | null>;
    id: string;
  }) => ReactNode;
  children: ReactNode | ((close: () => void) => ReactNode);
  align?: "start" | "end";
  side?: "bottom" | "top";
  label: string;
  className?: string;
  panelClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  // Anchoring to the trigger can push the panel off-screen; slide it back inside.
  useLayoutEffect(() => {
    const node = panel.current;
    if (!open || !node) return;
    const place = () => {
      node.style.translate = "";
      const rect = node.getBoundingClientRect();
      const room = document.documentElement.clientWidth;
      const shift =
        rect.left < VIEWPORT_GUTTER
          ? VIEWPORT_GUTTER - rect.left
          : rect.right > room - VIEWPORT_GUTTER
            ? room - VIEWPORT_GUTTER - rect.right
            : 0;
      node.style.translate = shift ? `${shift}px 0` : "";
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target))
        setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  const close = () => setOpen(false);
  return (
    <div ref={root} className={`relative ${className}`}>
      {trigger({
        open,
        toggle: () => setOpen((value) => !value),
        ref: button,
        id,
      })}
      {open && (
        <div
          ref={panel}
          id={id}
          role="dialog"
          aria-label={label}
          className={`fade-in absolute z-40 max-w-[calc(100vw-16px)] rounded-xl border border-line bg-surface p-1 shadow-(--pop-shadow) ${side === "top" ? "bottom-full mb-2" : "top-full mt-2"} ${align === "end" ? "right-0" : "left-0"} ${panelClassName}`}
        >
          {typeof children === "function" ? children(close) : children}
        </div>
      )}
    </div>
  );
}

export function MenuItem({
  children,
  onSelect,
  danger,
  disabled,
}: {
  children: ReactNode;
  onSelect(): void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-hover disabled:text-ink-4 ${danger ? "text-err" : "text-ink"}`}
    >
      {children}
    </button>
  );
}

export function SectionTitle({
  children,
  action,
  description,
}: {
  children: ReactNode;
  action?: ReactNode;
  description?: ReactNode;
}) {
  return (
    <div className="mb-3 flex items-end justify-between gap-4">
      <div className="min-w-0">
        <h2 className="text-md font-semibold text-ink">{children}</h2>
        {description && (
          <p className="mt-0.5 max-w-2xl text-sm text-ink-2">{description}</p>
        )}
      </div>
      {action}
    </div>
  );
}

export function EmptyState({
  title,
  children,
  icon,
}: {
  title: string;
  children?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      {icon && <div className="mb-4 text-ink-3">{icon}</div>}
      <p className="text-md font-medium text-ink">{title}</p>
      {children && (
        <div className="mt-1.5 max-w-md text-sm text-ink-2">{children}</div>
      )}
    </div>
  );
}

export function Loading({ label }: { label?: string }) {
  const { t } = useLocale();
  return (
    <div className="flex items-center gap-2 px-1 py-6 text-sm text-ink-3">
      <span className="relative block h-px w-16 overflow-hidden bg-line">
        <span className="travel absolute inset-y-0 left-0 w-1/3 bg-ink-3" />
      </span>
      {label ?? t("common.loading")}
    </div>
  );
}

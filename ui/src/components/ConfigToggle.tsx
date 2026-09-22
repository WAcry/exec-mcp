import { useLocale } from "../context/LocaleContext";
export function ConfigToggle({
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
  const { t } = useLocale();

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="inline-flex shrink-0 items-center gap-2 text-xs disabled:opacity-50 disabled:cursor-wait cursor-pointer"
    >
      <span
        className={`relative h-5 w-9 rounded-full transition-colors ${checked ? "bg-emerald-600" : "bg-zinc-300 dark:bg-zinc-700"}`}
      >
        <span
          className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${checked ? "translate-x-4" : "translate-x-0"}`}
        />
      </span>
      <span className="text-zinc-500">
        {checked ? t("common.enabled") : t("common.disabled")}
      </span>
    </button>
  );
}

import type { Locale, Translate } from "./locale";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function formatDuration(ms: number, t: Translate): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return t("unit.ms", Math.round(ms));
  const seconds = ms / 1000;
  if (seconds < 10) return t("unit.s", seconds.toFixed(1));
  if (seconds < 60) return t("unit.s", Math.floor(seconds));
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t("unit.min", minutes, Math.floor(seconds % 60));
  return t("unit.h", Math.floor(minutes / 60), minutes % 60);
}

/** Running clocks show whole seconds so the digits settle instead of flickering. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`;
}

export function formatAgo(ms: number, t: Translate): string {
  if (ms < 45_000) return t("time.justNow");
  if (ms < HOUR)
    return t("time.minutesAgo", Math.max(1, Math.round(ms / MINUTE)));
  if (ms < DAY) return t("time.hoursAgo", Math.floor(ms / HOUR));
  return t("time.daysAgo", Math.floor(ms / DAY));
}

export function clockTime(
  value: string | number | Date,
  locale: Locale,
  seconds = false,
): string {
  return new Date(value).toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
    ...(seconds ? { second: "2-digit" } : {}),
    hour12: false,
  });
}

export function fullTime(
  value: string | number | Date,
  locale: Locale,
): string {
  return new Date(value).toLocaleString(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function startOfDay(value: number): number {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function dayKey(value: string | number): number {
  return startOfDay(new Date(value).getTime());
}

export function dayLabel(
  value: string | number,
  now: number,
  locale: Locale,
  t: Translate,
): string {
  const day = startOfDay(new Date(value).getTime());
  const today = startOfDay(now);
  if (day === today) return t("time.today");
  if (day === today - DAY) return t("time.yesterday");
  return new Date(value).toLocaleDateString(locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/** Lists show a clock for today and a date otherwise, like a mail client. */
export function listTime(
  value: string | number,
  now: number,
  locale: Locale,
  t: Translate,
): string {
  const time = new Date(value).getTime();
  if (now - time < 45_000) return t("time.now");
  const day = startOfDay(time);
  const today = startOfDay(now);
  if (day === today) return clockTime(time, locale);
  if (day === today - DAY) return t("time.yesterday");
  return new Date(time).toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
  });
}

export function formatBytes(bytes: number, locale: Locale): string {
  const units = ["B", "KiB", "MiB", "GiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toLocaleString(locale, {
    maximumFractionDigits: unit === 0 || value >= 100 ? 0 : 1,
  })} ${units[unit]}`;
}

export function shortId(id: string, length = 6): string {
  return id.length > length ? id.slice(0, length) : id;
}

export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Shows control characters sent to a terminal instead of hiding them. */
export function visibleKeys(chars: string): string {
  return chars
    .replace(/\r\n|\n|\r/g, "⏎")
    .replace(/\t/g, "⇥")
    .replace(/\x1b/g, "⎋")
    .replace(/[\x00-\x1f]/g, (char) =>
      char.charCodeAt(0) === 0
        ? "^@"
        : `^${String.fromCharCode(char.charCodeAt(0) + 64)}`,
    );
}

import type { CallStatus } from "../../types";

/** Spinner artwork is centered in its own box and rotates around that center. */
export function Spinner({
  size = 14,
  className = "",
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      className={`spin shrink-0 ${className}`}
      aria-hidden="true"
    >
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.2"
        strokeWidth="2"
      />
      <path
        d="M8 2 A6 6 0 0 1 14 8"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Quiet for success, loud for failure: long timelines stay scannable. */
export function StatusNode({
  status,
  small = false,
}: {
  status: CallStatus;
  small?: boolean;
}) {
  if (status === "running")
    return <Spinner size={small ? 12 : 14} className="text-run" />;
  if (status === "error")
    return (
      <svg
        viewBox="0 0 16 16"
        width={small ? 12 : 14}
        height={small ? 12 : 14}
        aria-hidden="true"
      >
        <circle cx="8" cy="8" r="7" fill="var(--err)" />
        <path
          d="M5.6 5.6 10.4 10.4 M10.4 5.6 5.6 10.4"
          stroke="var(--surface)"
          strokeWidth="1.7"
          strokeLinecap="round"
        />
      </svg>
    );
  if (status === "yielding")
    return (
      <svg
        viewBox="0 0 16 16"
        width={small ? 11 : 13}
        height={small ? 11 : 13}
        aria-hidden="true"
      >
        <circle
          cx="8"
          cy="8"
          r="6"
          fill="none"
          stroke="var(--run)"
          strokeWidth="1.8"
          strokeDasharray="2.4 2.4"
        />
      </svg>
    );
  if (status === "terminated")
    return (
      <span
        className={`block rounded-[2px] bg-ink-3 ${small ? "h-1.5 w-1.5" : "h-2 w-2"}`}
      />
    );
  return (
    <span
      className={`block rounded-full bg-ok ${small ? "h-1.5 w-1.5" : "h-2 w-2"}`}
    />
  );
}

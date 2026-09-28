import { useMemo, type CSSProperties } from "react";
import {
  arcPath,
  BRAND_CORE,
  BRAND_RINGS,
  BRAND_STROKE,
  BRAND_TILE,
} from "../../../../src/brand-mark";
import { useTheme } from "../../context/ThemeContext";
import { UNSCOPED } from "../../lib/conversation";
import { sigilColor, sigilSpec } from "../../lib/sigil";

const OPACITY = [0.5, 0.75, 1];

/** A conversation's mark: three orbits derived from its hash, turning while it works. */
export function Sigil({
  id,
  size = 28,
  live = false,
  className = "",
}: {
  id: string;
  size?: number;
  live?: boolean;
  className?: string;
}) {
  const { resolvedTheme } = useTheme();
  const dark = resolvedTheme === "dark";
  const spec = useMemo(() => sigilSpec(id), [id]);
  if (id === UNSCOPED)
    return (
      <svg
        viewBox="0 0 24 24"
        width={size}
        height={size}
        className={`shrink-0 ${className}`}
        aria-hidden="true"
      >
        <circle
          cx="12"
          cy="12"
          r="9"
          fill="none"
          stroke="var(--ink-4)"
          strokeWidth="1.6"
          strokeDasharray="2.2 3"
          strokeLinecap="round"
        />
        <circle cx="12" cy="12" r="1.4" fill="var(--ink-3)" />
      </svg>
    );
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={`sigil shrink-0 ${className}`}
      data-live={live}
      aria-hidden="true"
    >
      {spec.rings.map((ring, index) => (
        <circle
          key={`track-${index}`}
          cx="12"
          cy="12"
          r={ring.radius}
          fill="none"
          stroke="var(--line)"
          strokeWidth="1.8"
        />
      ))}
      {spec.rings.map((ring, index) => (
        <g
          key={index}
          className="sigil-ring"
          data-reverse={ring.reverse}
          style={{ "--orbit": `${ring.period}s` } as CSSProperties}
        >
          <path
            d={arcPath(ring.radius, ring.start, ring.sweep)}
            fill="none"
            stroke={sigilColor(spec.hue, dark, OPACITY[index])}
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </g>
      ))}
      <circle cx="12" cy="12" r="1.3" fill={sigilColor(spec.hue, dark)} />
    </svg>
  );
}

/** The MCP icon's geometry in theme colors, so the tile inverts in dark mode. */
export function BrandMark({ size = 20 }: { size?: number }) {
  const inset = BRAND_TILE.inset;
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className="shrink-0"
      aria-hidden="true"
    >
      <rect
        x={inset}
        y={inset}
        width={24 - 2 * inset}
        height={24 - 2 * inset}
        rx={BRAND_TILE.radius}
        fill="var(--ink)"
      />
      {BRAND_RINGS.map((ring, index) => (
        <path
          key={index}
          d={arcPath(ring.radius, ring.start, ring.sweep)}
          fill="none"
          stroke="var(--bg)"
          strokeOpacity={ring.opacity}
          strokeWidth={BRAND_STROKE}
          strokeLinecap="round"
        />
      ))}
      <circle cx="12" cy="12" r={BRAND_CORE} fill="var(--bg)" />
    </svg>
  );
}

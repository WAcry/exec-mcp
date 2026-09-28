/** The EXEC MCP mark: three orbits on an ink tile, in a 24-unit square. Shared by the MCP icon and the Web console. */
export const BRAND_RINGS = [
  { radius: 3.4, start: 200, sweep: 250, opacity: 0.62 },
  { radius: 6.2, start: 20, sweep: 210, opacity: 0.82 },
  { radius: 9, start: 120, sweep: 170, opacity: 1 },
] as const;
export const BRAND_TILE = { inset: 0.5, radius: 6, color: "#1c1c20" };
export const BRAND_INK = "#f6f6f7";
export const BRAND_STROKE = 2.1;
export const BRAND_CORE = 1.3;

/** Angles are degrees clockwise from twelve o'clock. */
export function arcPath(
  radius: number,
  start: number,
  sweep: number,
  center = 12,
): string {
  const point = (degrees: number) => {
    const radians = ((degrees - 90) * Math.PI) / 180;
    return [
      (center + radius * Math.cos(radians)).toFixed(3),
      (center + radius * Math.sin(radians)).toFixed(3),
    ].join(" ");
  };
  const end = start + Math.min(sweep, 359.9);
  return `M ${point(start)} A ${radius} ${radius} 0 ${sweep > 180 ? 1 : 0} 1 ${point(end)}`;
}

export function brandMarkSvg(options: { badge?: string } = {}): string {
  const size = 24 - 2 * BRAND_TILE.inset;
  const arcs = BRAND_RINGS.map(
    (ring) =>
      `<path d="${arcPath(ring.radius, ring.start, ring.sweep)}" stroke="${BRAND_INK}" stroke-opacity="${ring.opacity}" stroke-width="${BRAND_STROKE}" stroke-linecap="round" fill="none"/>`,
  ).join("");
  const badge = options.badge
    ? `<circle cx="19.2" cy="4.8" r="4.4" fill="${options.badge}" stroke="#fafaf9" stroke-width="1.6"/>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect x="${BRAND_TILE.inset}" y="${BRAND_TILE.inset}" width="${size}" height="${size}" rx="${BRAND_TILE.radius}" fill="${BRAND_TILE.color}"/>${arcs}<circle cx="12" cy="12" r="${BRAND_CORE}" fill="${BRAND_INK}"/>${badge}</svg>`;
}

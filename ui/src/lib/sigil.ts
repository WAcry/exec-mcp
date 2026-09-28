/** Hues are spaced away from the red, amber and green reserved for state. */
const HUES = [212, 232, 254, 278, 302, 328, 190, 172, 96];
const RADII = [3.4, 6.2, 9];

export interface SigilRing {
  radius: number;
  start: number;
  sweep: number;
  period: number;
  reverse: boolean;
}

export interface SigilSpec {
  hue: number;
  rings: SigilRing[];
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function sequence(seed: number): () => number {
  let state = seed || 1;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function sigilSpec(id: string): SigilSpec {
  const next = sequence(fnv1a(id));
  const hue = HUES[Math.floor(next() * HUES.length)]!;
  return {
    hue,
    rings: RADII.map((radius, index) => ({
      radius,
      start: Math.floor(next() * 360),
      sweep: 110 + Math.floor(next() * 170),
      period: 2.2 + index * 1.3 + next(),
      reverse: index % 2 === 1,
    })),
  };
}

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

export function sigilColor(hue: number, dark: boolean, alpha = 1): string {
  return dark
    ? `hsl(${hue} 62% 68% / ${alpha})`
    : `hsl(${hue} 48% 46% / ${alpha})`;
}

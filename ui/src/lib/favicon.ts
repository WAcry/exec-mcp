import { arcPath } from "./sigil";

const MARK_RINGS = [
  { radius: 3.4, start: 200, sweep: 250 },
  { radius: 6.2, start: 20, sweep: 210 },
  { radius: 9, start: 120, sweep: 170 },
];

/** The same three orbits as the brand mark, drawn light on an ink tile. */
function markSvg(attention: boolean): string {
  const arcs = MARK_RINGS.map(
    (ring, index) =>
      `<path d="${arcPath(ring.radius, ring.start, ring.sweep)}" stroke="#f6f6f7" stroke-opacity="${[0.62, 0.82, 1][index]}" stroke-width="2.1" stroke-linecap="round" fill="none"/>`,
  ).join("");
  const dot = attention
    ? `<circle cx="19.2" cy="4.8" r="4.4" fill="#f2a93b" stroke="#fafaf9" stroke-width="1.6"/>`
    : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect x="0.5" y="0.5" width="23" height="23" rx="6" fill="#1c1c20"/>${arcs}<circle cx="12" cy="12" r="1.3" fill="#f6f6f7"/>${dot}</svg>`;
}

let current = "";

export function updateTabState(options: {
  attention: number;
  title: string;
}): void {
  const key = `${options.attention > 0}`;
  if (key !== current) {
    current = key;
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      document.head.appendChild(link);
    }
    link.type = "image/svg+xml";
    link.href = `data:image/svg+xml,${encodeURIComponent(markSvg(options.attention > 0))}`;
  }
  document.title = options.attention
    ? `(${options.attention}) ${options.title}`
    : options.title;
}

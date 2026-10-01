export interface AnsiStyle {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}

export interface AnsiSegment extends AnsiStyle {
  text: string;
}

// CSI (including SGR), OSC terminated by BEL or ST, and single-character escapes.
const ESCAPE =
  // eslint-disable-next-line no-control-regex -- matches terminal escape sequences
  /\x1b\[([0-9;?]*)([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

function paletteColor(index: number): string {
  if (index < 16) return `var(--ansi-${index})`;
  if (index >= 232) {
    const level = 8 + (index - 232) * 10;
    return `rgb(${level} ${level} ${level})`;
  }
  const cube = index - 16;
  const channel = (value: number) => (value === 0 ? 0 : 55 + value * 40);
  return `rgb(${channel(Math.floor(cube / 36))} ${channel(Math.floor(cube / 6) % 6)} ${channel(cube % 6)})`;
}

function applySgr(style: AnsiStyle, parameters: string): AnsiStyle {
  const codes = parameters === "" ? [0] : parameters.split(";").map(Number);
  let next: AnsiStyle = { ...style };
  for (let index = 0; index < codes.length; index++) {
    const code = codes[index];
    if (code === 0) next = {};
    else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 3) next.italic = true;
    else if (code === 4) next.underline = true;
    else if (code === 22) {
      delete next.bold;
      delete next.dim;
    } else if (code === 23) delete next.italic;
    else if (code === 24) delete next.underline;
    else if (code >= 30 && code <= 37) next.fg = paletteColor(code - 30);
    else if (code >= 90 && code <= 97) next.fg = paletteColor(code - 82);
    else if (code === 39) delete next.fg;
    else if (code >= 40 && code <= 47) next.bg = paletteColor(code - 40);
    else if (code >= 100 && code <= 107) next.bg = paletteColor(code - 92);
    else if (code === 49) delete next.bg;
    else if (code === 38 || code === 48) {
      const key = code === 38 ? "fg" : "bg";
      if (codes[index + 1] === 5 && codes[index + 2] !== undefined) {
        next[key] = paletteColor(codes[index + 2]);
        index += 2;
      } else if (codes[index + 1] === 2 && codes[index + 4] !== undefined) {
        next[key] =
          `rgb(${codes[index + 2]} ${codes[index + 3]} ${codes[index + 4]})`;
        index += 4;
      }
    }
  }
  return next;
}

/** Carriage returns redraw a line in a terminal; keep what the terminal would show. */
function collapseCarriageReturns(text: string): string {
  if (!text.includes("\r")) return text;
  return text
    .split("\n")
    .map((line) => {
      const parts = line.replace(/\r+$/, "").split("\r");
      return parts[parts.length - 1] ?? "";
    })
    .join("\n");
}

export function hasAnsi(text: string): boolean {
  return text.includes("\x1b") || text.includes("\r");
}

export function parseAnsi(input: string): AnsiSegment[] {
  const text = collapseCarriageReturns(input);
  const segments: AnsiSegment[] = [];
  let style: AnsiStyle = {};
  let last = 0;
  const push = (value: string) => {
    if (!value) return;
    const previous = segments[segments.length - 1];
    if (previous && sameStyle(previous, style)) previous.text += value;
    else segments.push({ ...style, text: value });
  };
  for (const match of text.matchAll(ESCAPE)) {
    push(text.slice(last, match.index));
    if (match[2] === "m") style = applySgr(style, match[1] ?? "");
    last = match.index + match[0].length;
  }
  push(text.slice(last));
  return segments;
}

function sameStyle(a: AnsiStyle, b: AnsiStyle): boolean {
  return (
    a.fg === b.fg &&
    a.bg === b.bg &&
    !!a.bold === !!b.bold &&
    !!a.dim === !!b.dim &&
    !!a.italic === !!b.italic &&
    !!a.underline === !!b.underline
  );
}

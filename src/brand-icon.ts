import { deflateSync } from "node:zlib";
import type { Icon } from "@modelcontextprotocol/server";
import {
  BRAND_CORE,
  BRAND_INK,
  BRAND_RINGS,
  BRAND_STROKE,
  BRAND_TILE,
  brandMarkSvg,
} from "./brand-mark.js";

type Ring = (typeof BRAND_RINGS)[number];

function rgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function tileDistance(x: number, y: number): number {
  const half = 12 - BRAND_TILE.inset - BRAND_TILE.radius;
  const qx = Math.abs(x - 12) - half;
  const qy = Math.abs(y - 12) - half;
  return (
    Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) +
    Math.min(Math.max(qx, qy), 0) -
    BRAND_TILE.radius
  );
}

/** Distance to a round-capped arc stroke, using the angles of arcPath. */
function ringDistance(x: number, y: number, ring: Ring): number {
  const dx = x - 12;
  const dy = y - 12;
  const degrees = ((Math.atan2(dy, dx) * 180) / Math.PI + 450) % 360;
  if ((degrees - ring.start + 720) % 360 <= ring.sweep)
    return Math.abs(Math.hypot(dx, dy) - ring.radius) - BRAND_STROKE / 2;
  const cap = (angle: number) => {
    const radians = ((angle - 90) * Math.PI) / 180;
    return Math.hypot(
      x - 12 - ring.radius * Math.cos(radians),
      y - 12 - ring.radius * Math.sin(radians),
    );
  };
  return (
    Math.min(cap(ring.start), cap(ring.start + ring.sweep)) - BRAND_STROKE / 2
  );
}

/** Anti-aliased RGBA pixels of the mark; every stroke lies inside the tile. */
export function renderBrandMark(size: number): Uint8Array {
  const unit = 24 / size;
  const coverage = (distance: number) =>
    Math.min(1, Math.max(0, 0.5 - distance / unit));
  const tile = rgb(BRAND_TILE.color);
  const ink = rgb(BRAND_INK);
  const pixels = new Uint8Array(size * size * 4);
  for (let row = 0; row < size; row++)
    for (let column = 0; column < size; column++) {
      const x = (column + 0.5) * unit;
      const y = (row + 0.5) * unit;
      const color = [...tile];
      const layers = [
        ...BRAND_RINGS.map(
          (ring) => coverage(ringDistance(x, y, ring)) * ring.opacity,
        ),
        coverage(Math.hypot(x - 12, y - 12) - BRAND_CORE),
      ];
      for (const alpha of layers)
        for (let channel = 0; channel < 3; channel++)
          color[channel] =
            color[channel]! * (1 - alpha) + ink[channel]! * alpha;
      const offset = (row * size + column) * 4;
      pixels[offset] = Math.round(color[0]!);
      pixels[offset + 1] = Math.round(color[1]!);
      pixels[offset + 2] = Math.round(color[2]!);
      pixels[offset + 3] = Math.round(coverage(tileDistance(x, y)) * 255);
    }
  return pixels;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++)
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes)
    value = CRC_TABLE[(value ^ byte) & 255]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

export function encodePng(size: number, rgba: Uint8Array): Buffer {
  const stride = size * 4;
  const scanlines = Buffer.alloc((stride + 1) * size);
  for (let row = 0; row < size; row++)
    scanlines.set(
      rgba.subarray(row * stride, (row + 1) * stride),
      row * (stride + 1) + 1,
    );
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(scanlines, { level: 9 })),
    chunk("IEND", new Uint8Array()),
  ]);
}

let icons: Icon[] | undefined;

/** PNG is what MCP clients must support; SVG is offered for those that scale it. */
export function brandIcons(): Icon[] {
  icons ??= [
    ...[64, 256].map((size) => ({
      src: `data:image/png;base64,${encodePng(size, renderBrandMark(size)).toString("base64")}`,
      mimeType: "image/png",
      sizes: [`${size}x${size}`],
    })),
    {
      src: `data:image/svg+xml;base64,${Buffer.from(brandMarkSvg()).toString("base64")}`,
      mimeType: "image/svg+xml",
      sizes: ["any"],
    },
  ];
  return icons;
}

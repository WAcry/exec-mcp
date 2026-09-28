import { inflateSync } from "node:zlib";
import { SERVER_INFO_META_KEY } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { brandIcons } from "../src/brand-icon.js";
import { BRAND_INK, BRAND_TILE } from "../src/brand-mark.js";
import { VERSION } from "../src/version.js";
import { connect } from "./helpers.js";

function png(src: string) {
  const bytes = Buffer.from(
    src.replace(/^data:image\/png;base64,/, ""),
    "base64",
  );
  const chunks = new Map<string, Buffer>();
  for (let offset = 8; offset < bytes.length; ) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    chunks.set(type, bytes.subarray(offset + 8, offset + 8 + length + 4));
    offset += length + 12;
  }
  const header = chunks.get("IHDR")!;
  const size = header.readUInt32BE(0);
  const rows = inflateSync(chunks.get("IDAT")!.subarray(0, -4));
  const pixel = (x: number, y: number) => {
    const offset = y * (size * 4 + 1) + 1 + x * 4;
    return [...rows.subarray(offset, offset + 4)];
  };
  return { bytes, chunks, header, size, rows, pixel };
}

const hex = (value: string) =>
  [1, 3, 5].map((index) => Number.parseInt(value.slice(index, index + 2), 16));

describe("brand icon", () => {
  it("encodes valid anti-aliased PNGs at every advertised size", () => {
    const icons = brandIcons();
    expect(icons.map((icon) => [icon.mimeType, icon.sizes])).toEqual([
      ["image/png", ["64x64"]],
      ["image/png", ["256x256"]],
      ["image/svg+xml", ["any"]],
    ]);
    for (const icon of icons.slice(0, 2)) {
      const image = png(icon.src);
      expect(image.bytes.subarray(0, 8)).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );
      expect(`${image.size}x${image.header.readUInt32BE(4)}`).toBe(
        icon.sizes![0],
      );
      expect([image.header[8], image.header[9]]).toEqual([8, 6]);
      expect(image.chunks.get("IEND")!.toString("hex")).toBe("ae426082");
      expect(image.rows).toHaveLength((image.size * 4 + 1) * image.size);
      const scale = image.size / 24;
      expect(image.pixel(0, 0)[3]).toBe(0);
      expect(
        image.pixel(Math.floor(20 * scale), Math.floor(20 * scale)),
      ).toEqual([...hex(BRAND_TILE.color), 255]);
      expect(image.pixel(image.size / 2, image.size / 2)).toEqual([
        ...hex(BRAND_INK),
        255,
      ]);
      const edge = Math.floor(BRAND_TILE.inset * scale);
      const alphas = new Set<number>();
      for (let x = 0; x < image.size; x++) alphas.add(image.pixel(x, edge)[3]!);
      expect([...alphas].some((alpha) => alpha > 0 && alpha < 255)).toBe(true);
    }
    const svg = Buffer.from(
      icons[2]!.src.replace(/^data:image\/svg\+xml;base64,/, ""),
      "base64",
    ).toString();
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    expect(brandIcons()).toBe(icons);
  });

  for (const legacy of [false, true])
    it(`advertises the icon in serverInfo but keeps it out of every tool result (${legacy ? "legacy" : "modern"} protocol)`, async () => {
      const connection = await connect({}, legacy);
      try {
        const info = connection.client.getServerVersion();
        expect(info).toMatchObject({
          name: "exec-mcp",
          title: "Exec MCP",
          version: VERSION,
        });
        expect(info?.icons).toEqual(brandIcons());
        const { tools } = await connection.client.listTools();
        expect(tools.map((tool) => tool.icons)).toEqual([undefined, undefined]);
        const result = await connection.client.callTool({
          name: "exec",
          arguments: { source: 'text("ok");' },
        });
        expect(result._meta?.[SERVER_INFO_META_KEY]).toEqual({
          name: "exec-mcp",
          title: "Exec MCP",
          version: VERSION,
        });
        expect(JSON.stringify(result).length).toBeLessThan(1000);
      } finally {
        await connection.close();
      }
    });
});

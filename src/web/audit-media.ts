import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

/** Raster formats a browser displays without running anything; others keep metadata only. */
const RENDERABLE = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export const AUDIT_MEDIA_BUDGET = 64 * 1024 * 1024;
export const AUDIT_MEDIA_ITEM_LIMIT = 16 * 1024 * 1024;

export interface AuditMediaItem {
  mimeType: string;
  data: Buffer;
}

interface Entry extends AuditMediaItem {
  owners: Set<string>;
}

/** Data properties only, so inspection never runs a getter. */
function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function without(value: object, omitted: string): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (key === omitted) continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    copy[key] =
      descriptor && "value" in descriptor ? descriptor.value : "[Accessor]";
  }
  return copy;
}

/**
 * Keeps the images that tool results carried so the console can show them.
 * Audit copies reference stored images by content hash instead of carrying base64.
 */
export class AuditMedia {
  private readonly items = new Map<string, Entry>();
  private bytes = 0;

  constructor(
    private readonly budget = AUDIT_MEDIA_BUDGET,
    private readonly itemLimit = AUDIT_MEDIA_ITEM_LIMIT,
  ) {}

  /** Returns a copy for the audit; the tool result itself is never modified. */
  extract(value: unknown, owner: string): unknown {
    try {
      const content = own(value, "content");
      if (!Array.isArray(content)) return value;
      let changed = false;
      const blocks = content.map((block: unknown) => {
        const next = this.block(block, owner);
        changed ||= next !== block;
        return next;
      });
      return changed
        ? { ...without(value as object, "content"), content: blocks }
        : value;
    } catch {
      return value;
    }
  }

  get(id: string): AuditMediaItem | undefined {
    const entry = this.items.get(id);
    return entry && { mimeType: entry.mimeType, data: entry.data };
  }

  release(owner: string): void {
    for (const [id, entry] of this.items)
      if (entry.owners.delete(owner) && !entry.owners.size) this.drop(id);
  }

  clear(): void {
    this.items.clear();
    this.bytes = 0;
  }

  private block(block: unknown, owner: string): unknown {
    const type = own(block, "type");
    const data = own(block, "data");
    if ((type === "image" || type === "audio") && typeof data === "string") {
      const bytes = Buffer.byteLength(data, "base64");
      const media =
        type === "image"
          ? this.store(data, bytes, own(block, "mimeType"), owner)
          : undefined;
      return {
        ...without(block as object, "data"),
        bytes,
        ...(media ? { media } : {}),
      };
    }
    const resource = own(block, "resource");
    const blob = own(resource, "blob");
    if (type === "resource" && typeof blob === "string")
      return {
        ...without(block as object, "resource"),
        resource: {
          ...without(resource as object, "blob"),
          bytes: Buffer.byteLength(blob, "base64"),
        },
      };
    return block;
  }

  private store(
    data: string,
    bytes: number,
    mimeType: unknown,
    owner: string,
  ): string | undefined {
    if (
      typeof mimeType !== "string" ||
      !RENDERABLE.has(mimeType) ||
      bytes > this.itemLimit
    )
      return undefined;
    const id = createHash("sha256").update(data).digest("hex");
    const existing = this.items.get(id);
    if (existing) {
      existing.owners.add(owner);
      this.items.delete(id);
      this.items.set(id, existing);
      return id;
    }
    const buffer = Buffer.from(data, "base64");
    this.items.set(id, { mimeType, data: buffer, owners: new Set([owner]) });
    this.bytes += buffer.length;
    for (const key of this.items.keys()) {
      if (this.bytes <= this.budget || key === id) break;
      this.drop(key);
    }
    return id;
  }

  private drop(id: string): void {
    const entry = this.items.get(id);
    if (!entry) return;
    this.items.delete(id);
    this.bytes -= entry.data.length;
  }
}

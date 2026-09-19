import { Buffer } from "node:buffer";

const DEFAULT_STRING_CHARS = 8 * 1024;
const DEFAULT_VALUE_CHARS = 16 * 1024;
const MAX_DEPTH = 8;
const MAX_NODES = 1000;
const MAX_COLLECTION_ITEMS = 100;
const arrayBufferBytes = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  "byteLength",
)!.get!;
const typedArrayPrototype = Object.getPrototypeOf(
  Uint8Array.prototype,
) as object;
const typedArrayBytes = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "byteLength",
)!.get!;
const typedArrayLength = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "length",
)!.get!;
const dataViewBytes = Object.getOwnPropertyDescriptor(
  DataView.prototype,
  "byteLength",
)!.get!;

export interface AuditSnapshot<T = unknown> {
  value: T;
  truncated: boolean;
}

export function truncateAuditText(
  value: string,
  maximum = DEFAULT_STRING_CHARS,
): AuditSnapshot<string> {
  maximum = Number.isSafeInteger(maximum) ? Math.max(0, maximum) : 0;
  if (value.length <= maximum) return { value, truncated: false };
  const length = codePointLength(value);
  if (length <= maximum) return { value, truncated: false };

  let marker = `\n…[审计记录省略 ${Math.max(0, length - maximum)} 个字符]…\n`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const available = Math.max(0, maximum - codePointLength(marker));
    const next = `\n…[审计记录省略 ${length - available} 个字符]…\n`;
    if (next === marker) break;
    marker = next;
  }
  if (codePointLength(marker) > maximum) {
    return {
      value: takeStart("…[审计记录已省略]…", maximum),
      truncated: true,
    };
  }
  const available = maximum - codePointLength(marker);
  const head = Math.ceil(available * 0.6);
  const tail = available - head;
  return {
    value: takeStart(value, head) + marker + takeEnd(value, tail),
    truncated: true,
  };
}

function codePointLength(value: string): number {
  let result = 0;
  for (let index = 0; index < value.length; index++, result++) {
    const current = value.charCodeAt(index);
    if (current >= 0xd800 && current <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) index++;
    }
  }
  return result;
}

function takeStart(value: string, count: number): string {
  if (count <= 0) return "";
  let index = 0;
  for (let seen = 0; index < value.length && seen < count; seen++) {
    const current = value.charCodeAt(index++);
    if (current >= 0xd800 && current <= 0xdbff && index < value.length) {
      const next = value.charCodeAt(index);
      if (next >= 0xdc00 && next <= 0xdfff) index++;
    }
  }
  return value.slice(0, index);
}

function takeEnd(value: string, count: number): string {
  if (count <= 0) return "";
  let index = value.length;
  for (let seen = 0; index > 0 && seen < count; seen++) {
    const current = value.charCodeAt(--index);
    if (current >= 0xdc00 && current <= 0xdfff && index > 0) {
      const previous = value.charCodeAt(index - 1);
      if (previous >= 0xd800 && previous <= 0xdbff) index--;
    }
  }
  return value.slice(index);
}

interface SnapshotContext {
  readonly seen: WeakSet<object>;
  readonly stringMaximum: number;
  nodes: number;
  truncated: boolean;
}

/** Snapshot observability data without invoking user-defined getters or toJSON.
 * Audit recording must never change a tool call's success or retain huge graphs.
 */
export function snapshotAuditValue(
  input: unknown,
  maximum = DEFAULT_VALUE_CHARS,
): AuditSnapshot {
  const context: SnapshotContext = {
    seen: new WeakSet(),
    stringMaximum: Math.max(
      128,
      Math.min(DEFAULT_STRING_CHARS, Math.floor(maximum / 2)),
    ),
    nodes: 0,
    truncated: false,
  };
  let value: unknown;
  try {
    value = normalize(input, 0, context);
  } catch {
    return { value: "[Audit inspection failed]", truncated: true };
  }
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    return { value: "[Audit serialization failed]", truncated: true };
  }
  if (json.length <= maximum && codePointLength(json) <= maximum)
    return { value, truncated: context.truncated };
  const preview = truncateAuditText(json, maximum);
  return {
    value: {
      truncated: true,
      originalCharacters: codePointLength(json),
      preview: preview.value,
    },
    truncated: true,
  };
}

function normalize(
  value: unknown,
  depth: number,
  context: SnapshotContext,
): unknown {
  if (++context.nodes > MAX_NODES) {
    context.truncated = true;
    return "[Audit node limit]";
  }
  if (value === null || typeof value === "boolean" || typeof value === "number")
    return value;
  if (typeof value === "string") {
    const snapshot = truncateAuditText(value, context.stringMaximum);
    context.truncated ||= snapshot.truncated;
    return snapshot.value;
  }
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "undefined") return "[undefined]";
  if (typeof value === "symbol") return `[symbol ${value.description ?? ""}]`;
  if (typeof value === "function") {
    const descriptor = Object.getOwnPropertyDescriptor(value, "name");
    const name =
      descriptor && "value" in descriptor ? descriptor.value : "anonymous";
    return `[function ${typeof name === "string" && name ? name : "anonymous"}]`;
  }

  if (Buffer.isBuffer(value)) return { type: "Buffer", bytes: value.length };
  if (value instanceof ArrayBuffer)
    return { type: "ArrayBuffer", bytes: arrayBufferBytes.call(value) };
  if (ArrayBuffer.isView(value)) {
    if (value instanceof DataView)
      return { type: "DataView", bytes: dataViewBytes.call(value) };
    return {
      type: "TypedArray",
      bytes: typedArrayBytes.call(value),
      length: typedArrayLength.call(value),
    };
  }
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    const size = Object.getOwnPropertyDescriptor(Blob.prototype, "size")!.get!;
    const type = Object.getOwnPropertyDescriptor(Blob.prototype, "type")!.get!;
    return {
      type: "Blob",
      bytes: size.call(value),
      mimeType: type.call(value),
    };
  }
  if (value instanceof Date) {
    try {
      return Date.prototype.toISOString.call(value);
    } catch {
      return "[Invalid Date]";
    }
  }
  if (value instanceof URL) return URL.prototype.toString.call(value);
  if (value instanceof Error) {
    const nameDescriptor = Object.getOwnPropertyDescriptor(value, "name");
    const messageDescriptor = Object.getOwnPropertyDescriptor(value, "message");
    const name =
      nameDescriptor && "value" in nameDescriptor
        ? String(nameDescriptor.value)
        : "Error";
    const rawMessage =
      messageDescriptor && "value" in messageDescriptor
        ? String(messageDescriptor.value)
        : "";
    const message = truncateAuditText(rawMessage, context.stringMaximum);
    context.truncated ||= message.truncated;
    return { name, message: message.value };
  }
  if (context.seen.has(value)) return "[Circular]";
  if (depth >= MAX_DEPTH) {
    context.truncated = true;
    return "[Audit depth limit]";
  }
  context.seen.add(value);

  if (value instanceof Map) {
    const entries: unknown[] = [];
    for (const [key, item] of Map.prototype.entries.call(value) as Iterable<
      [unknown, unknown]
    >) {
      if (entries.length >= MAX_COLLECTION_ITEMS) break;
      entries.push([
        normalize(key, depth + 1, context),
        normalize(item, depth + 1, context),
      ]);
    }
    const size = Object.getOwnPropertyDescriptor(Map.prototype, "size")!.get!;
    const omitted = Math.max(0, size.call(value) - entries.length);
    if (omitted) context.truncated = true;
    return { type: "Map", entries, ...(omitted ? { omitted } : {}) };
  }
  if (value instanceof Set) {
    const values: unknown[] = [];
    for (const item of Set.prototype.values.call(value) as Iterable<unknown>) {
      if (values.length >= MAX_COLLECTION_ITEMS) break;
      values.push(normalize(item, depth + 1, context));
    }
    const size = Object.getOwnPropertyDescriptor(Set.prototype, "size")!.get!;
    const omitted = Math.max(0, size.call(value) - values.length);
    if (omitted) context.truncated = true;
    return { type: "Set", values, ...(omitted ? { omitted } : {}) };
  }

  if (Array.isArray(value)) {
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    const length =
      typeof lengthDescriptor?.value === "number"
        ? Math.max(0, Math.trunc(lengthDescriptor.value))
        : 0;
    const output: unknown[] = [];
    const count = Math.min(length, MAX_COLLECTION_ITEMS);
    for (let index = 0; index < count; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      output.push(
        descriptor && "value" in descriptor
          ? normalize(descriptor.value, depth + 1, context)
          : descriptor
            ? "[Accessor]"
            : "[Empty]",
      );
    }
    if (length > count) {
      context.truncated = true;
      output.push(`[${length - count} more items]`);
    }
    return output;
  }

  const output = Object.create(null) as Record<string, unknown>;
  let count = 0;
  try {
    for (const key in value as object) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable) continue;
      if (count++ >= MAX_COLLECTION_ITEMS) {
        context.truncated = true;
        output["…"] = "[more keys]";
        break;
      }
      output[key] =
        "value" in descriptor
          ? normalize(descriptor.value, depth + 1, context)
          : "[Accessor]";
    }
  } catch {
    context.truncated = true;
    output["…"] = "[Uninspectable keys]";
  }
  return output;
}

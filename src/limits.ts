export const MAX_PAYLOAD_BYTES = 48 * 1024 * 1024;

/** This guards a serialized payload, not total process RSS or model context. */
export function encodePayload(
  value: unknown,
  limit = MAX_PAYLOAD_BYTES,
): Buffer {
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error("值不能编码为 JSON。");
  const bytes = Buffer.byteLength(json);
  if (bytes > limit)
    throw new Error(
      `编码载荷为 ${bytes} 字节，超过 ${limit} 字节的传输边界；未截断或落盘。`,
    );
  return Buffer.from(json);
}

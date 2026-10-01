export const MAX_PAYLOAD_BYTES = 48 * 1024 * 1024;

/** This guards a serialized payload, not total process RSS or model context. */
export function encodePayload(
  value: unknown,
  limit = MAX_PAYLOAD_BYTES,
): Buffer {
  const json = JSON.stringify(value);
  if (json === undefined)
    throw new Error("The value cannot be encoded as JSON.");
  const bytes = Buffer.byteLength(json);
  if (bytes > limit)
    throw new Error(
      `The encoded payload is ${bytes} bytes, above the ${limit}-byte transport limit. It was not truncated or written to a file. Return less data, for example by filtering it inside exec or writing it to a file.`,
    );
  return Buffer.from(json);
}

export const MAX_PAYLOAD_BYTES = 48 * 1024 * 1024;

/** Codex exec_command collection window, in milliseconds. */
export const COMMAND_YIELD_TIME_MS = { default: 10_000, max: 30_000 } as const;
/**
 * Codex write_stdin collection windows, in milliseconds. A write waits briefly
 * for its echo; an empty read polls longer. An explicit 0 reads at once.
 */
export const STDIN_YIELD_TIME_MS = {
  default: 250,
  write: { min: 250, max: 30_000 },
  read: { min: 5_000, max: 300_000 },
} as const;
/** Unread terminal output returned by one exec_command or write_stdin call. */
export const TERMINAL_READ_BYTES = 4 * 1024 * 1024;

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

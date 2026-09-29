import { USER_NOTE_TEXT_PREFIX } from "../../../src/session-notes-types.js";

export interface ParsedResult {
  /** The audit replaced the whole value with a bounded preview. */
  preview?: string;
  status?: string;
  wallSeconds?: number;
  text: string;
  notes: string[];
  structured?: unknown;
  media: MediaBlock[];
  isError: boolean;
}

export interface MediaBlock {
  type: string;
  label: string;
  bytes?: number;
  /** ID of the copy the audit kept; missing when the image was not retained. */
  media?: string;
}

const HEADER =
  /^(Script (?:completed|failed|terminated)|Script running with cell ID \S+)\nWall time ([\d.]+) seconds\nOutput:\n?/;

export function objectValue(
  value: unknown,
): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Splits a tool result into what the model read, notes that rode along, and media. */
export function parseToolResult(output: unknown): ParsedResult {
  const value = objectValue(output);
  const result: ParsedResult = {
    text: "",
    notes: [],
    media: [],
    isError: false,
  };
  if (!value) {
    result.text = asText(output);
    return result;
  }
  if (value.truncated === true && typeof value.preview === "string") {
    result.preview = value.preview;
    return result;
  }
  result.isError = value.isError === true;
  let structured = value.structuredContent;
  const wrapped = objectValue(structured);
  let blocks: unknown[] = Array.isArray(value.content) ? value.content : [];
  if (wrapped && Array.isArray(wrapped.user_notes) && "result" in wrapped) {
    result.notes.push(
      ...wrapped.user_notes.filter(
        (note): note is string => typeof note === "string",
      ),
    );
    structured = wrapped.result;
    if (Array.isArray(wrapped.result_content))
      blocks = [...wrapped.result_content, ...blocks];
  }
  if (structured !== undefined) result.structured = structured;
  const texts: string[] = [];
  for (const raw of blocks) {
    const block = objectValue(raw);
    if (!block) continue;
    if (block.type === "text" && typeof block.text === "string") {
      if (block.text.startsWith(USER_NOTE_TEXT_PREFIX)) {
        result.notes.push(block.text.slice(USER_NOTE_TEXT_PREFIX.length));
        continue;
      }
      let text = block.text;
      if (!texts.length && result.status === undefined) {
        const header = HEADER.exec(text);
        if (header) {
          result.status = header[1]!;
          result.wallSeconds = Number(header[2]);
          text = text.slice(header[0].length);
        }
      }
      texts.push(text);
    } else if (typeof block.type === "string") {
      const resource = objectValue(block.resource);
      const label =
        (typeof block.name === "string" && block.name) ||
        (typeof block.mimeType === "string" && block.mimeType) ||
        (typeof block.uri === "string" && block.uri) ||
        (typeof resource?.uri === "string" && resource.uri) ||
        block.type;
      const bytes = block.bytes ?? resource?.bytes;
      result.media.push({
        type: block.type,
        label,
        ...(typeof bytes === "number" ? { bytes } : {}),
        ...(typeof block.media === "string" ? { media: block.media } : {}),
      });
    }
  }
  result.text = texts.join("\n").replace(/^\n+/, "");
  return result;
}

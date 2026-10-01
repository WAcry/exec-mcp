/** Audit omission markers; the Web UI renders them as dividers instead of raw text. */
export const AUDIT_OMITTED_TEXT = "…[audit omitted text]…";

export function auditOmissionMarker(characters: number): string {
  return `\n…[audit omitted ${characters} characters]…\n`;
}

/** Matches auditOmissionMarker output; the capture group is the omitted character count. */
export const AUDIT_OMISSION_PATTERN =
  /\n…\[audit omitted (\d+) characters\]…\n/g;

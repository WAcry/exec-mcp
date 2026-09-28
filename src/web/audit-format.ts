/** Audit omission markers; the Web UI renders them as dividers instead of raw text. */
export const AUDIT_OMITTED_TEXT = "…[审计记录已省略]…";

export function auditOmissionMarker(characters: number): string {
  return `\n…[审计记录省略 ${characters} 个字符]…\n`;
}

/** Matches auditOmissionMarker output; the capture group is the omitted character count. */
export const AUDIT_OMISSION_PATTERN = /\n…\[审计记录省略 (\d+) 个字符\]…\n/g;

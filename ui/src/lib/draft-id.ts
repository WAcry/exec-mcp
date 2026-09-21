/** Available on HTTP LAN origins too; randomUUID requires a secure context. */
export function draftId(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

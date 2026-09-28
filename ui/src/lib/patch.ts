export type PatchLineKind = "context" | "add" | "remove" | "hunk";

export interface PatchLine {
  kind: PatchLineKind;
  text: string;
}

export interface PatchFile {
  operation: "add" | "update" | "delete";
  path: string;
  moveTo?: string;
  lines: PatchLine[];
  added: number;
  removed: number;
}

const FILE_HEADER = /^\*\*\* (Add|Update|Delete) File: (.+)$/;

/** Parses the Codex apply_patch envelope; anything unrecognized stays as context. */
export function parsePatch(patch: string): PatchFile[] {
  const files: PatchFile[] = [];
  let current: PatchFile | undefined;
  for (const raw of patch.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const header = FILE_HEADER.exec(line);
    if (header) {
      current = {
        operation: header[1]!.toLowerCase() as PatchFile["operation"],
        path: header[2]!.trim(),
        lines: [],
        added: 0,
        removed: 0,
      };
      files.push(current);
      continue;
    }
    if (
      line === "*** Begin Patch" ||
      line === "*** End Patch" ||
      line === "*** End of File"
    )
      continue;
    if (!current) continue;
    if (line.startsWith("*** Move to: ")) {
      current.moveTo = line.slice("*** Move to: ".length).trim();
      continue;
    }
    if (line.startsWith("@@")) {
      current.lines.push({ kind: "hunk", text: line.slice(2).trim() });
    } else if (line.startsWith("+")) {
      current.added++;
      current.lines.push({ kind: "add", text: line.slice(1) });
    } else if (line.startsWith("-")) {
      current.removed++;
      current.lines.push({ kind: "remove", text: line.slice(1) });
    } else {
      current.lines.push({
        kind: "context",
        text: line.startsWith(" ") ? line.slice(1) : line,
      });
    }
  }
  return files;
}

/** Five blocks, GitHub style: the share of additions and deletions at a glance. */
export function diffBlocks(
  added: number,
  removed: number,
): ("add" | "remove" | "none")[] {
  const total = added + removed;
  if (!total) return ["none", "none", "none", "none", "none"];
  const addBlocks = Math.round((added / total) * 5);
  const removeBlocks = Math.min(
    5 - addBlocks,
    Math.round((removed / total) * 5),
  );
  return [
    ...Array<"add">(addBlocks).fill("add"),
    ...Array<"remove">(removeBlocks).fill("remove"),
    ...Array<"none">(Math.max(0, 5 - addBlocks - removeBlocks)).fill("none"),
  ];
}

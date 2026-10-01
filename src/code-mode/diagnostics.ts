import { createHash } from "node:crypto";
import { parse } from "acorn";

/** Best-effort explanation after the native engine has already rejected syntax.
 * This parser never gates execution or pretends to be the authoritative V8 version.
 */
export function syntaxDiagnostic(
  source: string,
  nativeError: string,
  requestId: string,
): string | undefined {
  if (!/\bSyntaxError\b/.test(nativeError)) return undefined;
  const fingerprint = createHash("sha256").update(source).digest("hex");
  const identity = `Request ${requestId}; received source SHA-256 ${fingerprint}`;
  try {
    parse(source, {
      ecmaVersion: "latest",
      sourceType: "module",
      locations: true,
    });
  } catch (error) {
    const syntax = error as {
      loc?: { line: number; column: number };
      pos?: number;
    };
    if (syntax.loc && typeof syntax.pos === "number") {
      const start = Math.max(
        source.lastIndexOf("\n", syntax.pos - 1) + 1,
        syntax.pos - 100,
      );
      let end = source.indexOf("\n", syntax.pos);
      if (end < 0) end = source.length;
      end = Math.min(end, syntax.pos + 140);
      const snippet = source
        .slice(start, end)
        .replaceAll("\r", "")
        .replaceAll("\t", " ");
      return `JavaScript parse error at line ${syntax.loc.line}, column ${syntax.loc.column + 1} (UTF-16 code units, both counted from 1).\n${identity}\n${start > 0 && source[start - 1] !== "\n" ? "…" : ""}${snippet}\n${" ".repeat(Math.min(100, syntax.pos - start))}^`;
    }
  }
  return `The native engine reported a SyntaxError, but a separate parse of the received source could not locate it. ${identity}.`;
}

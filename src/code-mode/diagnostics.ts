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
  const identity = `请求 ${requestId}；接收源码 SHA-256 ${fingerprint}`;
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
      return `JavaScript 解析阶段定位：第 ${syntax.loc.line} 行，第 ${syntax.loc.column + 1} 列（UTF-16，均从 1 开始）。\n${identity}\n${start > 0 && source[start - 1] !== "\n" ? "…" : ""}${snippet}\n${" ".repeat(Math.min(100, syntax.pos - start))}^`;
    }
  }
  return `原生引擎返回 SyntaxError，接收源码的独立语法检查未能定位；${identity}。`;
}

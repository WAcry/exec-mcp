import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { syntaxDiagnostic } from "../src/code-mode/diagnostics.js";
import { CodeModeService } from "../src/code-mode/service.js";
import { texts } from "./helpers.js";

const services: CodeModeService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
});
describe("exact received-source syntax diagnostics", () => {
  it("locates a mismatched push closing bracket and fingerprints the unmodified request", async () => {
    const source =
      '// @exec: {"yield_time_ms":10000}\nconst observations=[];\nobservations.push({id:8},{id:9}]);text(observations);';
    const service = new CodeModeService();
    services.push(service);
    const result = await service.exec({
      source,
      tools: [],
      requestId: "call-fixture",
    });
    expect(result.isError).toBe(true);
    const output = texts(result).join("\n");
    expect(output).toContain("SyntaxError");
    expect(output).toContain("解析阶段");
    expect(output).toContain("第 3 行");
    expect(output).toContain("call-fixture");
    expect(output).toContain(createHash("sha256").update(source).digest("hex"));
    expect(output).toContain("observations.push");
    expect(output).toContain("^");
  });
  it("keeps excerpts short even for a single enormous line, without applying a code rewrite", () => {
    const source = 'const x="' + "汉😀".repeat(20000) + '";text(x]);';
    const result = syntaxDiagnostic(
      source,
      "SyntaxError: bad input",
      "fixture",
    )!;
    expect(result.length).toBeLessThan(600);
    expect(result).toContain(createHash("sha256").update(source).digest("hex"));
    expect(result).toContain("第 1 行");
    expect(source.endsWith("text(x]);")).toBe(true);
  });
  it("does not relabel a runtime SyntaxError as a verified parsing failure", () => {
    const result = syntaxDiagnostic(
      'throw new SyntaxError("intentional")',
      "SyntaxError: intentional",
      "fixture",
    )!;
    expect(result).toContain("独立语法检查未能定位");
    expect(result).not.toContain("解析阶段定位");
    expect(
      syntaxDiagnostic("text(1)", "Error: runtime failure", "fixture"),
    ).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import ts from "typescript";
import { schemaType, toolDeclaration } from "../src/tool-descriptions.js";

describe("Codex tool declarations", () => {
  it("resolves local references, quotes property names and keeps descriptions valid TypeScript", () => {
    const schema = {
      type: "object",
      properties: {
        "a-b": {
          $ref: "#/$defs/value",
          description: "First line\nSecond line",
        },
        optional: { type: ["string", "null"] },
      },
      required: ["a-b"],
      $defs: { value: { enum: ["one", "two"] } },
    };
    const type = schemaType(schema);
    expect(type).toContain('"a-b": "one" | "two";');
    expect(type).toContain("optional?: string | null;");
    const declaration = toolDeclaration("lookup", type, "unknown");
    const source = declaration.split("```ts\n")[1]!.split("\n```")[0]!;
    const result = ts.transpileModule(source, { reportDiagnostics: true });
    expect(result.diagnostics).toEqual([]);
  });

  it("keeps recursive schemas finite and does not resolve a nested resource against its outer root", () => {
    const recursive = schemaType({
      type: "object",
      properties: { next: { $ref: "#" } },
    });
    expect(recursive).toContain("next?: unknown;");
    const nested = schemaType({
      $defs: { value: { type: "number" } },
      properties: {
        nested: { $id: "https://example.test/schema", $ref: "#/$defs/value" },
      },
    });
    expect(nested).toContain("nested?: unknown;");
  });
});

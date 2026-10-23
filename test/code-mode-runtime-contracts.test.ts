import { afterEach, describe, expect, it, vi } from "vitest";
import { CodeModeService } from "../src/code-mode/service.js";
import { cellId, jsonOutput, texts } from "./helpers.js";

const services: CodeModeService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
});
function service() {
  const value = new CodeModeService();
  services.push(value);
  return value;
}

describe("Codex 0.164 runtime compatibility", () => {
  it.each([
    'try { exit(); } catch { text("caught"); } finally { store("phase","finally"); text("finally"); }',
    'await Promise.all([Promise.resolve().then(() => exit()), Promise.resolve().then(() => store("phase","sibling"))]);',
    'setTimeout(() => { try { exit(); } finally { store("phase","timer"); } }, 0); await new Promise(() => {});',
    'try { image({get image_url() { exit(); }}); } catch { text("caught"); }',
  ])(
    "stops the whole cell and commits only writes before exit: %s",
    async (source) => {
      const value = service();
      const effect = vi.fn(async () => null);
      const result = await value.exec({
        source: `store("phase","before"); text("before"); ${source} await tools.effect({});`,
        sessionScope: "exit",
        tools: [
          { name: "effect", description: "Records an effect.", call: effect },
        ],
      });
      expect(result.isError).not.toBe(true);
      expect(texts(result).slice(1)).toEqual(["before"]);
      expect(effect).not.toHaveBeenCalled();
      expect(
        jsonOutput(
          await value.exec({
            source: 'text(JSON.stringify(load("phase")));',
            sessionScope: "exit",
            tools: [],
          }),
        ),
      ).toBe("before");
    },
  );

  it("exits successfully after yielding and receiving a tool response", async () => {
    const value = service();
    const first = await value.exec({
      source:
        'yield_control(); await tools.echo({}); store("phase","after tool"); exit(); store("phase","late");',
      sessionScope: "yield-exit",
      tools: [
        {
          name: "echo",
          description: "Returns its input.",
          call: async (input) => input,
        },
      ],
    });
    const result = await value.wait({
      cellId: cellId(first),
      sessionScope: "yield-exit",
    });
    expect(result.isError).not.toBe(true);
    expect(texts(result)[0]).toContain("completed");
    expect(
      jsonOutput(
        await value.exec({
          source: 'text(JSON.stringify(load("phase")));',
          sessionScope: "yield-exit",
          tools: [],
        }),
      ),
    ).toBe("after tool");
  });

  it("cancels during image JSON fallback without interrupting another session", async () => {
    const value = service();
    await value.exec({
      source: 'store("kept",42);',
      sessionScope: "other",
      tools: [],
    });
    const first = await value.exec({
      source: `let reads = 0;
        const imageValue = { get image_url() {
          if (++reads === 1) throw new Error("enter JSON fallback");
          text("getter running"); yield_control(); while (true) {}
        }};
        try { image(imageValue); } catch { text("continued after cancellation"); }`,
      sessionScope: "image",
      tools: [],
    });
    expect(texts(first).join("\n")).toContain("getter running");
    const stopped = await value.wait({
      cellId: cellId(first),
      sessionScope: "image",
      terminate: true,
    });
    expect(texts(stopped)[0]).toContain("terminated");
    expect(texts(stopped).join("\n")).not.toContain(
      "continued after cancellation",
    );
    expect(
      jsonOutput(
        await value.exec({
          source: 'text(load("kept"));',
          sessionScope: "other",
          tools: [],
        }),
      ),
    ).toBe(42);
  });

  it("rejects reserved JSON object keys without poisoning stored values or the session", async () => {
    const value = service();
    const result = await value.exec({
      source: `store("kept",42);
        const keys = ["$serde_json::private::RawValue", "$serde_json::private::Number"];
        const errors = [];
        for (const key of keys) {
          try { store("kept", { [key]: "null" }); } catch (error) { errors.push(String(error)); }
        }
        store("literal", keys); text({errors, kept:load("kept"), literal:load("literal")});`,
      sessionScope: "json",
      tools: [],
    });
    expect(result.isError).not.toBe(true);
    expect(jsonOutput(result)).toEqual({
      errors: [
        expect.stringContaining("reserved JSON object key"),
        expect.stringContaining("reserved JSON object key"),
      ],
      kept: 42,
      literal: [
        "$serde_json::private::RawValue",
        "$serde_json::private::Number",
      ],
    });
    expect(
      jsonOutput(
        await value.exec({
          source: 'text(load("kept"));',
          sessionScope: "json",
          tools: [],
        }),
      ),
    ).toBe(42);
  });
});

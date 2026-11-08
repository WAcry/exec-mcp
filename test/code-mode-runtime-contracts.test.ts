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

/** Valid mono PCM WAV; a low sample rate gives long duration without a large fixture. */
function pcm16Wav(sampleRate: number, frames: number): string {
  const dataBytes = frames * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataBytes, 40);
  return buffer.toString("base64");
}

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5xkAAAAASUVORK5CYII=";

describe("pinned Codex runtime compatibility", () => {
  it.each(["exec", "wait", "terminate"] as const)(
    "retains image detail and long audio at zero text budget on %s",
    async (observation) => {
      // 1001 seconds costs 10,010 native audio tokens, exceeding the host's
      // ordinary 10,000-token default. The WAV itself is only about 32 KiB.
      const audio = pcm16Wav(16, 16_016);
      const value = service();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let markReady!: () => void;
      const ready = new Promise<void>((resolve) => {
        markReady = resolve;
      });
      const output = `image({image_url:"data:image/png;base64,${PNG}",detail:"original"});
        text("hidden body");
        audio({type:"audio",mimeType:"audio/wav",data:${JSON.stringify(audio)}});`;
      let result = await value.exec({
        tools: [
          {
            name: "resume",
            description: "Waits for the test to observe the initial yield.",
            call: async () => {
              await gate;
              return null;
            },
          },
          {
            name: "ready",
            description: "Confirms the preceding audio has reached the actor.",
            call: async () => {
              markReady();
              return null;
            },
          },
        ],
        maxOutputTokens: 0,
        source:
          observation === "exec"
            ? output
            : `yield_control(); await tools.resume({}); ${output}
            ${observation === "terminate" ? "await tools.ready({}); await new Promise(() => {});" : ""}`,
      });
      release();
      if (observation !== "exec") {
        if (observation === "terminate") await ready;
        result = await value.wait({
          cellId: cellId(result),
          maxTokens: 0,
          terminate: observation === "terminate",
        });
      }
      expect(result.isError).not.toBe(true);
      expect(result.content.map((item) => item.type)).toEqual([
        "text",
        "image",
        "audio",
      ]);
      expect(result.content.find((item) => item.type === "image")).toEqual({
        type: "image",
        data: PNG,
        mimeType: "image/png",
        _meta: { "openai/imageDetail": "original" },
      });
      expect(result.content.find((item) => item.type === "audio")).toEqual({
        type: "audio",
        mimeType: "audio/wav",
        data: audio,
      });
      expect(texts(result).join("\n")).not.toContain("hidden body");
    },
  );

  it("reports an oversized image at zero text budget and still delivers a fitting image", async () => {
    const result = await service().exec({
      tools: [],
      maxOutputTokens: 0,
      // A wire fixture exceeds the 8 MiB encoded URL allowance before any
      // image decoder sees it. Rejection must not consume the media capacity.
      source: `image("data:image/png;base64," + "A".repeat(8 * 1024 * 1024));
        image({image_url:"data:image/png;base64,${PNG}",detail:"original"});`,
    });
    expect(result.isError).not.toBe(true);
    expect(result.content.filter((item) => item.type === "image")).toEqual([
      {
        type: "image",
        data: PNG,
        mimeType: "image/png",
        _meta: { "openai/imageDetail": "original" },
      },
    ]);
    expect(texts(result)[0]).toContain(
      "Code Mode session output limit reached",
    );
    expect(texts(result)[0]).toContain("1 images");
  });

  it("bounds aggregate image output while keeping stored results available for a later exec", async () => {
    const value = service();
    const imageBytes = 4 * 1024 * 1024;
    const first = await value.exec({
      tools: [],
      sessionScope: "media-recovery",
      maxOutputTokens: 0,
      // Both images fit individually, but their data URL prefixes push the
      // combined bytes over 8 MiB. Explicit output does not truncate store.
      source: `const picture = {image_url:"data:image/png;base64," + "A".repeat(${imageBytes}),detail:"original"};
        store("pictures", [picture, picture]); image(picture); image(picture);`,
    });
    expect(first.isError).not.toBe(true);
    expect(first.content.filter((item) => item.type === "image")).toHaveLength(
      1,
    );
    expect(texts(first)[0]).toContain("1 images");
    const recovered = await value.exec({
      tools: [],
      sessionScope: "media-recovery",
      maxOutputTokens: 0,
      source: 'image(load("pictures")[1]);',
    });
    expect(recovered.isError).not.toBe(true);
    expect(
      recovered.content.filter((item) => item.type === "image"),
    ).toHaveLength(1);
    const image = recovered.content.find((item) => item.type === "image");
    expect(image?.data).toHaveLength(imageBytes);
    expect(image?._meta).toEqual({ "openai/imageDetail": "original" });
    expect(texts(recovered).join("\n")).not.toContain("output limit reached");
  });

  it("resets image retention after an observed yield instead of applying a lifetime allowance", async () => {
    const value = service();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const imageBytes = 5 * 1024 * 1024;
    const first = await value.exec({
      tools: [
        {
          name: "resume",
          description: "Waits for the preceding observation to finish.",
          call: async () => {
            await gate;
            return null;
          },
        },
      ],
      maxOutputTokens: 0,
      source: `const picture = {image_url:"data:image/png;base64," + "A".repeat(${imageBytes}),detail:"original"};
        image(picture); yield_control(); await tools.resume({}); image(picture);`,
    });
    release();
    const final = await value.wait({ cellId: cellId(first), maxTokens: 0 });
    for (const result of [first, final]) {
      expect(result.isError).not.toBe(true);
      expect(
        result.content.filter((item) => item.type === "image"),
      ).toHaveLength(1);
      expect(
        result.content.find((item) => item.type === "image")?.data,
      ).toHaveLength(imageBytes);
      expect(texts(result).join("\n")).not.toContain("output limit reached");
    }
  });

  it("keeps the native text-retention warning visible when the caller suppresses all text", async () => {
    const result = await service().exec({
      tools: [],
      maxOutputTokens: 0,
      source:
        'text("hidden head" + "x".repeat(2 * 1024 * 1024) + "hidden tail");',
    });
    expect(result.isError).not.toBe(true);
    expect(texts(result)[0]).toContain(
      "Code Mode session output limit reached",
    );
    expect(texts(result)[0]).toMatch(/omitted [1-9][0-9]* text bytes/);
    expect(texts(result).join("\n")).not.toContain("hidden head");
    expect(texts(result).join("\n")).not.toContain("hidden tail");
  });

  it.each([false, true])(
    "renders terminal errors exactly once (yielded=%s)",
    async (yielded) => {
      const value = service();
      let result = await value.exec({
        tools: [],
        source: `${yielded ? "yield_control();" : ""}throw new Error("compatibility failure");`,
      });
      while (texts(result)[0]?.startsWith("Script running"))
        result = await value.wait({ cellId: cellId(result) });
      expect(result.isError).toBe(true);
      expect(
        texts(result).filter((item) => item.startsWith("Script error:\n")),
      ).toHaveLength(1);
      expect(texts(result).join("\n")).toContain("compatibility failure");
    },
  );

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

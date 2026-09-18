import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { cellId, connect, jsonOutput, texts } from "./helpers.js";

const connections: Awaited<ReturnType<typeof connect>>[] = [];
const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await Promise.all(connections.splice(0).map((c) => c.close()));
});
const call = (
  client: Client,
  name: string,
  args: Record<string, unknown>,
  scope = "a",
) =>
  client.callTool({
    name,
    arguments: args,
    _meta: { "openai/session": scope },
  });

describe.each([false, true])(
  "helper contracts over real MCP (legacy=%s)",
  (legacy) => {
    it("reuses storage across connections and keeps other conversations isolated", async () => {
      const connection = await connect({}, legacy);
      connections.push(connection);
      await call(connection.client, "exec", {
        source: 'store("cached",{rows:[3,4]});text("saved");',
      });
      await connection.client.close();
      const second = new Client(
        { name: "new-connection", version: "1" },
        { versionNegotiation: { mode: legacy ? "legacy" : "auto" } },
      );
      clients.push(second);
      await second.connect(
        new StreamableHTTPClientTransport(new URL(connection.url)),
      );
      expect(
        jsonOutput(
          await call(second, "exec", { source: 'text(load("cached"));' }),
        ),
      ).toEqual({ rows: [3, 4] });
      expect(
        jsonOutput(
          await call(
            second,
            "exec",
            { source: 'text({missing:load("cached")===undefined});' },
            "b",
          ),
        ),
      ).toEqual({ missing: true });
      const noScope = await second.callTool({
        name: "exec",
        arguments: { source: 'load("cached");' },
      });
      expect(noScope.isError).toBe(true);
    });

    it("enforces explicit budgets through schemas and does not inherit them into later waits", async () => {
      const connection = await connect({}, legacy);
      connections.push(connection);
      const first = await call(connection.client, "exec", {
        source:
          'store("raw","x".repeat(12000));text("before".repeat(200));yield_control();await new Promise(r=>setTimeout(r,30));text("after".repeat(3000));',
        max_output_tokens: 0,
      });
      expect(texts(first)).toHaveLength(1);
      expect(texts(first)[0]).toContain("截断");
      const finished = await call(connection.client, "wait", {
        cell_id: cellId(first),
      });
      expect(texts(finished).at(-1)).toBe("after".repeat(3000));
      expect(
        jsonOutput(
          await call(connection.client, "exec", {
            source: 'text(load("raw").length);',
          }),
        ),
      ).toBe(12000);
      const pending = await call(connection.client, "exec", {
        source: 'yield_control();text("output".repeat(100));',
      });
      const limited = await call(connection.client, "wait", {
        cell_id: cellId(pending),
        max_tokens: 1,
      });
      expect(texts(limited)[0]).toContain("截断");
      expect(limited.structuredContent).toBeUndefined();
      const invalid = await call(connection.client, "exec", {
        source: 'store("should_not_run",true);',
        max_output_tokens: -1,
      });
      expect(invalid.isError).toBe(true);
      expect(
        jsonOutput(
          await call(connection.client, "exec", {
            source: 'text(load("should_not_run")===undefined);',
          }),
        ),
      ).toBe(true);
    });

    it("forwards generatedImage and output_hint as unique native content", async () => {
      const connection = await connect({}, legacy);
      connections.push(connection);
      const png =
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5xkAAAAASUVORK5CYII=";
      const result = await call(connection.client, "exec", {
        source: `generatedImage({image_url:${JSON.stringify(png)},output_hint:"图片说明"});`,
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toBeUndefined();
      expect(result.content.filter((b) => b.type === "image")).toHaveLength(1);
      expect(texts(result).filter((t) => t === "图片说明")).toHaveLength(1);
    });
  },
);

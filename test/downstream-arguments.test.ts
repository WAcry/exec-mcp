import { describe, expect, it } from "vitest";

import type { NestedToolCallContext } from "../src/code-mode/types.js";
import { ToolDiscovery } from "../src/downstream/discovery.js";
import type { DownstreamMcpRegistry } from "../src/downstream/registry.js";
import type { DownstreamTool } from "../src/types.js";

function discovery(inputSchema: DownstreamTool["tool"]["inputSchema"]) {
  const sent: unknown[] = [];
  const tool: DownstreamTool = {
    id: "fixture/search",
    codeName: "mcp__fixture__search",
    serverId: "fixture",
    tool: { name: "search", inputSchema },
  };
  const registry = {
    bindingSnapshot: () => [tool],
    callTool: async (_id: string, args: unknown) => {
      sent.push(args);
      return { content: [] };
    },
  } as unknown as DownstreamMcpRegistry;
  const [definition] = new ToolDiscovery(registry).snapshot();
  const context = {
    signal: new AbortController().signal,
  } as NestedToolCallContext;
  return {
    sent,
    call: (args: unknown) => definition!.call(args, context),
  };
}

describe("downstream argument errors", () => {
  it("name each field and what the schema expects, without the argument values", async () => {
    const { call, sent } = discovery({
      type: "object",
      properties: {
        query: { type: "string" },
        mode: { enum: ["fast", "full"] },
        limit: { type: "integer", minimum: 1 },
      },
      required: ["query"],
      additionalProperties: false,
    });

    const error = await call({
      mode: "SECRET_MODE_VALUE",
      limit: "SECRET_LIMIT_VALUE",
      extra: "SECRET_EXTRA_VALUE",
    }).catch((caught: unknown) => caught as Error);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      [
        "The arguments for tools.mcp__fixture__search do not match its input schema. The request was not sent. Fix these fields, then call again:",
        '- /: missing required property "query"',
        '- /: property "extra" is not allowed; remove it',
        '- /mode: must be one of "fast", "full"',
        "- /limit: must be of type integer",
      ].join("\n"),
    );
    expect((error as Error).message).not.toContain("SECRET");
    expect(sent).toEqual([]);
  });

  it("shortens long lists of allowed values", async () => {
    const values = Array.from({ length: 25 }, (_, index) => `v${index}`);
    const { call } = discovery({
      type: "object",
      properties: { pick: { enum: values } },
    });

    await expect(call({ pick: "other" })).rejects.toThrow(
      '- /pick: must be one of "v0", "v1", "v2", "v3", "v4", "v5", "v6", "v7", "v8", "v9", "v10", "v11", "v12", "v13", "v14", "v15", "v16", "v17", "v18", "v19", and 5 more in the input schema',
    );
  });

  it("sends valid arguments unchanged", async () => {
    const { call, sent } = discovery({
      type: "object",
      properties: { query: { type: "string" } },
    });
    await call({ query: "ok" });
    expect(sent).toEqual([{ query: "ok" }]);
  });
});

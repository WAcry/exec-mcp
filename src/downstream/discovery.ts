import { isDeepStrictEqual } from "node:util";
import { Ajv, type ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import formats from "ajv-formats";
import type { CodeModeToolDefinition } from "../code-mode/types.js";
import type { DownstreamTool } from "../types.js";
import { DownstreamMcpRegistry } from "./registry.js";
import { buildToolSearchIndex, type ToolSearchIndex } from "./search.js";

interface Prepared {
  tool: DownstreamTool;
  definition: CodeModeToolDefinition;
}
export class ToolDiscovery {
  private cached = new Map<string, Prepared>();
  private indexed: readonly Prepared[] = [];
  private index: ToolSearchIndex | undefined;
  constructor(private readonly registry: DownstreamMcpRegistry) {}
  snapshot(): CodeModeToolDefinition[] {
    return this.prepare(this.registry.catalogSnapshot()).map(
      (entry) => entry.definition,
    );
  }
  async search(
    query: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<{
    tools: { name: string; description: string }[];
    errors: Record<string, string>;
    note: string;
  }> {
    const inventory = await this.registry.inventory(signal);
    const prepared = this.prepare(inventory.tools);
    if (
      this.index === undefined ||
      prepared.length !== this.indexed.length ||
      prepared.some((entry, i) => entry !== this.indexed[i])
    ) {
      this.index = buildToolSearchIndex(prepared.map((entry) => entry.tool));
      this.indexed = prepared;
    }
    const matching = this.index.search(query, { limit });
    return {
      tools: matching.map((tool) => {
        const definition = this.cached.get(tool.codeName)!.definition;
        return { name: definition.name, description: definition.description };
      }),
      errors: inventory.errors,
      note: "新发现或更新的工具从下一次 exec 可调用；本次 ALL_TOOLS 与 tools 绑定保持不变。",
    };
  }
  private prepare(tools: readonly DownstreamTool[]): Prepared[] {
    const next = new Map<string, Prepared>();
    for (const tool of tools) {
      if (next.has(tool.codeName))
        throw new Error(`工具规范化名称冲突：${tool.codeName}`);
      const old = this.cached.get(tool.codeName);
      if (old && (old.tool === tool || isDeepStrictEqual(old.tool, tool))) {
        next.set(tool.codeName, old);
        continue;
      }
      const schema = tool.tool.inputSchema;
      let validate: ValidateFunction | undefined;
      const description = [
        `来源：${tool.serverId}。${tool.namespaceInstructions ? `服务说明（原文）：${tool.namespaceInstructions}\n` : ""}${tool.tool.description ?? ""}`,
        `调用：await tools.${tool.codeName}(args)。args 必须满足以下 JSON Schema：`,
        JSON.stringify(schema),
        `返回 MCP CallToolResult；先检查 isError，优先使用 structuredContent，content 保留不同文本及媒体。`,
        ...(tool.tool.outputSchema
          ? [
              `structuredContent 契约：${JSON.stringify(tool.tool.outputSchema)}`,
            ]
          : []),
        ...(tool.tool.annotations
          ? [`上游提示（非授权）：${JSON.stringify(tool.tool.annotations)}`]
          : []),
      ].join("\n");
      const definition: CodeModeToolDefinition = {
        name: tool.codeName,
        description,
        inputSchema: schema,
        call: async (args, context) => {
          if (validate === undefined) {
            const ajv =
              typeof schema.$schema === "string" &&
              schema.$schema.includes("draft-07")
                ? new Ajv({ strict: false, allErrors: true })
                : new Ajv2020({ strict: false, allErrors: true });
            formats.default(ajv);
            try {
              validate = ajv.compile(schema);
            } catch {
              throw new Error(
                `无法校验工具输入契约：${tool.codeName}；未发送调用。`,
              );
            }
          }
          if (!validate(args))
            throw new Error(
              `工具 ${tool.codeName} 参数不符：${validate.errors?.map((error) => `${error.instancePath || "/"} ${error.keyword}`).join(", ")}；未发送调用。`,
            );
          return this.registry.callTool(
            tool.id,
            args as Record<string, unknown>,
            context.signal,
            undefined,
            tool.tool,
          );
        },
      };
      next.set(tool.codeName, { tool, definition });
    }
    this.cached = next;
    return [...next.values()];
  }
}

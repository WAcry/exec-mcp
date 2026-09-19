import { isDeepStrictEqual } from "node:util";
import { Ajv, type ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import formats from "ajv-formats";
import type { CodeModeToolDefinition } from "../code-mode/types.js";
import type { DownstreamTool } from "../types.js";
import {
  DownstreamMcpRegistry,
  type DownstreamStartupEvent,
} from "./registry.js";
import { ToolSearchIndex, type ToolDescriptor } from "./search.js";

interface Prepared {
  tool: DownstreamTool;
  definition: CodeModeToolDefinition;
}
export class ToolDiscovery {
  private cached = new Map<string, Prepared>();
  constructor(private readonly registry: DownstreamMcpRegistry) {}
  async initialize(
    signal?: AbortSignal,
    onProgress?: (event: DownstreamStartupEvent) => void,
  ): Promise<void> {
    await this.registry.initialize(signal, onProgress);
    this.snapshot(); // Compile every input contract before declaring the instance ready.
  }
  snapshot(): CodeModeToolDefinition[] {
    return this.prepare(this.registry.bindingSnapshot()).map(
      (entry) => entry.definition,
    );
  }
  /** Capture exactly one exec's callable catalog; search never refreshes or binds tools.
   * Keep metadata only: a long-lived search must not retain another call's callbacks.
   */
  searchFor(tools: readonly Omit<CodeModeToolDefinition, "call">[]) {
    const visible = new Map<string, { name: string; description: string }>();
    const descriptors: ToolDescriptor[] = tools.map((tool) => {
      if (visible.has(tool.name)) throw new Error(`工具名称冲突：${tool.name}`);
      visible.set(tool.name, {
        name: tool.name,
        description: tool.description,
      });
      const downstream = this.cached.get(tool.name)?.tool;
      return (
        downstream ?? {
          id: tool.name,
          codeName: tool.name,
          serverId: "exec-mcp",
          tool: {
            name: tool.name,
            description: tool.description,
            ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
            ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
          },
        }
      );
    });
    // Most execs call known tools. Build BM25 only when this snapshot is searched.
    let index: ToolSearchIndex | undefined;
    return (query: string, limit: number, signal?: AbortSignal) => {
      signal?.throwIfAborted();
      index ??= new ToolSearchIndex(descriptors);
      return {
        tools: index
          .search(query, { limit })
          .map((tool) => ({ ...visible.get(tool.codeName)! })),
        errors: this.registry.catalogErrors(),
      };
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
      const ajv =
        typeof schema.$schema === "string" &&
        schema.$schema.includes("draft-07")
          ? new Ajv({ strict: false, allErrors: true })
          : new Ajv2020({ strict: false, allErrors: true });
      formats.default(ajv);
      let validate: ValidateFunction;
      try {
        validate = ajv.compile(schema);
      } catch {
        throw new Error(
          `无法校验工具输入契约：${tool.codeName}；请修正下游 schema 后重启，未发送工具调用。`,
        );
      }
      const description = [
        `来源：${tool.serverId}。${tool.namespaceInstructions ? `服务说明（原文）：${tool.namespaceInstructions}\n` : ""}${tool.tool.description ?? ""}`,
        `调用：await tools.${tool.codeName}(args)。args 必须满足以下 JSON Schema：`,
        JSON.stringify(schema),
        `返回 MCP CallToolResult：{content,structuredContent?,isError?}。`,
        ...(tool.tool.outputSchema
          ? [
              `structuredContent 契约：${JSON.stringify(tool.tool.outputSchema)}`,
            ]
          : []),
        ...(tool.tool.annotations
          ? [`上游工具提示：${JSON.stringify(tool.tool.annotations)}`]
          : []),
      ].join("\n");
      const definition: CodeModeToolDefinition = {
        name: tool.codeName,
        description,
        inputSchema: schema,
        call: async (args, context) => {
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

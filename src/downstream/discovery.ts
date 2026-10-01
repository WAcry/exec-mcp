import { isDeepStrictEqual } from "node:util";
import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import formats from "ajv-formats";
import type { CodeModeToolDefinition } from "../code-mode/types.js";
import type { DownstreamTool } from "../types.js";
import {
  DownstreamMcpRegistry,
  type DownstreamStartupEvent,
} from "./registry.js";

const MAX_ISSUES = 20;
const MAX_ALLOWED_VALUES = 20;
const MAX_VALUE_TEXT = 200;

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
  private prepare(tools: readonly DownstreamTool[]): Prepared[] {
    const next = new Map<string, Prepared>();
    for (const tool of tools) {
      if (next.has(tool.codeName))
        throw new Error(
          `Two downstream tools have the same code name ${tool.codeName}.`,
        );
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
      } catch (error) {
        throw new Error(
          `The input schema of tool ${JSON.stringify(tool.tool.name)} on downstream MCP server ${JSON.stringify(tool.serverId)} is not valid JSON Schema (${clip(error instanceof Error ? error.message : String(error))}), so exec-mcp cannot check its arguments. Fix the schema on the server, or set enabled_tools to leave this tool out, then restart exec-mcp.`,
        );
      }
      const description = [
        `MCP server: ${tool.serverId}. ${tool.namespaceInstructions ? `Server instructions: ${tool.namespaceInstructions}\n` : ""}${tool.tool.description ?? ""}`,
        `Call: await tools.${tool.codeName}(args)\nInput JSON Schema:`,
        JSON.stringify(schema),
        `Returns CallToolResult: {content, structuredContent?, isError?}.`,
        ...(tool.tool.outputSchema
          ? [
              `structuredContent JSON Schema: ${JSON.stringify(tool.tool.outputSchema)}`,
            ]
          : []),
        ...(tool.tool.annotations
          ? [`Tool annotations: ${JSON.stringify(tool.tool.annotations)}`]
          : []),
      ].join("\n");
      const definition: CodeModeToolDefinition = {
        name: tool.codeName,
        description,
        inputSchema: schema,
        call: async (args, context) => {
          if (!validate(args))
            throw new Error(argumentError(tool.codeName, validate.errors));
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

/**
 * Name each failed field with the schema's expectation. The messages come
 * from Ajv and the tool's schema; they never repeat the argument values.
 */
export function argumentError(
  codeName: string,
  errors: readonly ErrorObject[] | null | undefined,
): string {
  const issues = (errors ?? []).map(describeIssue);
  const unique = [...new Set(issues)];
  const shown = unique.slice(0, MAX_ISSUES);
  const more =
    unique.length > shown.length
      ? [`- and ${unique.length - shown.length} more`]
      : [];
  return [
    `The arguments for tools.${codeName} do not match its input schema. The request was not sent. Fix these fields, then call again:`,
    ...shown.map((issue) => `- ${issue}`),
    ...more,
  ].join("\n");
}

function describeIssue(error: ErrorObject): string {
  const at = error.instancePath || "/";
  const params = error.params as Record<string, unknown>;
  switch (error.keyword) {
    case "required":
      return `${at}: missing required property ${JSON.stringify(params.missingProperty)}`;
    case "additionalProperties":
      return `${at}: property ${JSON.stringify(params.additionalProperty)} is not allowed; remove it`;
    case "unevaluatedProperties":
      return `${at}: property ${JSON.stringify(params.unevaluatedProperty)} is not allowed; remove it`;
    case "enum":
      return `${at}: must be one of ${allowed(params.allowedValues)}`;
    case "const":
      return `${at}: must be ${clip(JSON.stringify(params.allowedValue))}`;
    case "type":
      return `${at}: must be of type ${Array.isArray(params.type) ? params.type.join(" or ") : String(params.type)}`;
    default:
      return `${at}: ${error.message ?? `fails "${error.keyword}"`}`;
  }
}

function allowed(values: unknown): string {
  const list = Array.isArray(values) ? values : [];
  const shown = list
    .slice(0, MAX_ALLOWED_VALUES)
    .map((value) => clip(JSON.stringify(value)));
  return list.length > shown.length
    ? `${shown.join(", ")}, and ${list.length - shown.length} more in the input schema`
    : shown.join(", ");
}

function clip(text: string | undefined): string {
  const value = text ?? "undefined";
  return value.length > MAX_VALUE_TEXT
    ? `${value.slice(0, MAX_VALUE_TEXT)}…`
    : value;
}

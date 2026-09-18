import type { CallToolResult } from "@modelcontextprotocol/client";

export type CodeModeToolKind = "function" | "freeform";

export interface CodeModeToolName {
  name: string;
  namespace?: string;
}

/** A tool made available inside the isolated Code Mode runtime. */
export interface CodeModeToolDefinition {
  /** Raw catalog name. The host normalizes it to a JavaScript identifier. */
  name: string;
  toolName?: CodeModeToolName;
  description: string;
  kind?: CodeModeToolKind;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  call(input: unknown, context: NestedToolCallContext): Promise<unknown>;
}

export interface NestedToolCallContext {
  cellId: string;
  invocationId: string;
  runtimeToolCallId: string;
  sessionScope?: string;
  signal: AbortSignal;
  toolName: CodeModeToolName;
}

export type CodeModeOutputItem =
  | { type: "text"; text: string }
  | {
      type: "image";
      imageUrl: string;
      detail?: "auto" | "low" | "high" | "original";
    }
  | { type: "audio"; audioUrl: string };

export interface CodeModeExecRequest {
  source: string;
  tools: readonly CodeModeToolDefinition[];
  /** Opaque OpenAI conversation scope. It is correlation state, not auth. */
  sessionScope?: string;
  signal?: AbortSignal;
  maxOutputTokens?: number;
  /** Public MCP yield_time_ms. It overrides an optional source pragma. */
  yieldTimeMs?: number;
}

export interface CodeModeWaitRequest {
  cellId: string;
  sessionScope?: string;
  signal?: AbortSignal;
  maxTokens?: number;
  terminate?: boolean;
  yieldTimeMs?: number;
}

export type CodeModeToolResult = CallToolResult;

export interface CodeModeServiceOptions {
  sessionIdleMs?: number;
  defaultExecYieldTimeMs?: number;
  defaultWaitYieldTimeMs?: number;
  hostBinary?: string;
  maxHeapSizeBytes?: number;
  maxYieldTimeMs?: number;
  onError?: (error: Error) => void;
  startupTimeoutMs?: number;
  transportTimeoutMs?: number;
}

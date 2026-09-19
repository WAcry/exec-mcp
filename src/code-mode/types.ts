import type { CallToolResult } from "@modelcontextprotocol/client";
import type { MemoryReader } from "../host/process-memory.js";

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
  /** Correlate diagnostics with the Web call record; not supplied by the model. */
  requestId?: string;
  /** 服务端原生附件出口，不是 V8 全局或模型提供的回调。 */
  takeAttachments?: () => CallToolResult["content"];
  tools: readonly CodeModeToolDefinition[];
  /** Opaque OpenAI conversation scope. It is correlation state, not auth. */
  sessionScope?: string;
  signal?: AbortSignal;
  maxOutputTokens?: number;
  /** Public MCP yield_time_ms. It overrides an optional source pragma. */
  yieldTimeMs?: number;
  /** Internal observability hook; failures must not affect execution. */
  onState?: (state: "yielded" | "completed" | "terminated") => void;
}

export interface CodeModeWaitRequest {
  cellId: string;
  sessionScope?: string;
  signal?: AbortSignal;
  maxTokens?: number;
  terminate?: boolean;
  yieldTimeMs?: number;
  /** Internal observability hook; failures must not affect execution. */
  onState?: (state: "yielded" | "completed" | "terminated") => void;
}

export type CodeModeToolResult = CallToolResult;

export interface CodeModeServiceOptions {
  sessionIdleMs?: number;
  memoryHighWaterBytes?: number;
  memoryCheckIntervalMs?: number;
  memoryCloseTimeoutMs?: number;
  memoryReader?: MemoryReader;
  defaultExecYieldTimeMs?: number;
  defaultWaitYieldTimeMs?: number;
  hostBinary?: string;
  maxHeapSizeBytes?: number;
  maxYieldTimeMs?: number;
  onError?: (error: Error) => void;
  startupTimeoutMs?: number;
  transportTimeoutMs?: number;
}

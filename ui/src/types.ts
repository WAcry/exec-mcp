export type {
  ActivityStats,
  CallListItem,
  CallRecord,
  CallStatus,
  CallStepSummary,
  CodeModeMemoryStatus,
  NativeSessionItem,
  PaginatedResult,
  SessionSummary,
  SubCallRecord,
} from "../../src/web/types.js";
import type {
  ActivityStats,
  CodeModeMemoryStatus,
  PaginatedResult,
  SessionSummary,
} from "../../src/web/types.js";

export interface SessionPage extends PaginatedResult<SessionSummary> {
  pendingQuestionsTotal: number;
}

export interface SystemStatus {
  status: string;
  generation?: number;
  version: string;
  uptime: number;
  isLoopback: boolean;
  mcp: {
    host: string;
    port: number;
    access: string;
    public_url?: string;
  };
  web: {
    host: string;
    port: number;
    exposed: boolean;
    loopbackUrl: string;
    lanUrls: string[];
  };
  stats: ActivityStats;
  memory?: CodeModeMemoryStatus | undefined;
  system: {
    hostname?: string;
    platform: string;
    arch: string;
    nodeVersion: string;
  };
}

export interface TerminalItem {
  id: string;
  command?: string;
  cwd?: string;
  owner?: string;
  exitCode?: number;
  touched: number;
  observers: number;
  kind: "pipe" | "pty";
  pid?: number;
  bufferBytes: number;
  bufferCapacityBytes: number;
  omittedBytes: number;
}

export interface SkillItem {
  name: string;
  description?: string;
  path: string;
  implicit: boolean;
  enabled?: boolean;
}

export interface SkillsResponse {
  skills: SkillItem[];
  warnings: string[];
  maxChars: number;
  totalChars: number;
  count: number;
}

export interface McpServerItem {
  name: string;
  transport: "stdio" | "streamable-http";
  command?: string;
  argsCount?: number;
  envKeys?: string[];
  headerNames?: string[];
  cwd?: string;
  url?: string;
  enabledTools?: string[];
  startupTimeoutMs?: number;
  toolTimeoutMs?: number;
  enabled?: boolean;
  active?: boolean;
}

export interface McpToolItem {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpServersResponse {
  servers: McpServerItem[];
  tools: McpToolItem[];
  errors: Record<string, string>;
}

export interface ArtifactItem {
  id: string;
  name: string;
  mime_type: string;
  size: number;
  sha256: string;
  expires_at: string;
  uri: string;
  conversation?: string;
}

export interface ConfigResponse {
  config_path?: string;
  config_file?: string;
  config_exists?: boolean;
  [key: string]: unknown;
}

export type LiveEvent =
  | { type: "connected" }
  | { type: "call:start"; callId: string; sessionId: string }
  | { type: "call:subcall"; callId: string; subcallId: string }
  | { type: "call:finish"; callId: string; status: string }
  | { type: "call:clear" }
  | {
      type: "session:notes";
      sessionId: string;
      questionRequest?: { id: string; count: number };
      agentMessage?: { id: string };
    };

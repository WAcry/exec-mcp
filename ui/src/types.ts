export type CallStatus =
  | "running"
  | "completed"
  | "error"
  | "yielding"
  | "terminated";

export interface SubCallRecord {
  id: string;
  name: string;
  timestamp: string;
  durationMs: number;
  input: unknown;
  output?: unknown;
  error?: string;
  status: "success" | "error";
}

export interface CallRecord {
  id: string;
  sessionId: string;
  tool: "exec" | "wait";
  status: CallStatus;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  args: {
    source?: string;
    workdir?: string;
    yield_time_ms?: number;
    max_output_tokens?: number;
    files?: { name?: string; size?: number; type?: string }[];
    cell_id?: string;
    terminate?: boolean;
    [key: string]: unknown;
  };
  subcalls: SubCallRecord[];
  omittedSubcalls?: number;
  truncatedFields?: number;
  output?: unknown;
  error?: string;
}

export interface CallSummary {
  id: string;
  sessionId: string;
  tool: "exec" | "wait";
  status: CallStatus;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  args: { source?: string; cell_id?: string };
  subcallCount: number;
  truncated: boolean;
}

export interface SessionSummary {
  id: string;
  callCount: number;
  errorCount: number;
  firstSeen: string;
  lastActive: string;
  lastCall?: {
    id: string;
    tool: string;
    status: CallStatus;
    durationMs?: number;
    timestamp: string;
    preview: string;
  };
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface CodeModeMemoryStatus {
  highWaterBytes: number;
  highWaterMib: number;
  rssBytes?: number | undefined;
  sampledAt?: string | undefined;
  status: "normal" | "elevated" | "exceeded" | "unsampled";
  hostPid?: number | undefined;
  idleRetentionHours: number;
}

export interface NativeSessionItem {
  id: string;
  scope?: string | undefined;
  users: number;
  idleSince: number;
  lastUsed: number;
  generation: number;
  activeCellCount: number;
  activeCellIds: string[];
  retired?: "memory" | "idle" | "failure" | "shutdown" | "unscoped" | undefined;
  isOldestIdle: boolean;
  isOldestActive: boolean;
}

export interface SystemStatus {
  status: string;
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
  memory?: CodeModeMemoryStatus;
  system: {
    platform: string;
    arch: string;
    nodeVersion: string;
  };
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

export interface ActivityStats {
  totalCalls: number;
  activeSessions: number;
  errorCalls: number;
  runningCalls: number;
  avgDurationMs: number;
  truncatedFields: number;
  omittedSubcalls: number;
}

export interface McpToolItem {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpServersResponse {
  servers: McpServerItem[];
  tools: McpToolItem[];
}

export interface TerminalSessionItem {
  id: string;
  exitCode?: number;
  touched: number;
  observers: number;
  kind: "pipe" | "pty";
  pid?: number;
  bufferBytes: number;
  bufferCapacityBytes: number;
  omittedBytes: number;
}

export interface ArtifactItem {
  id: string;
  name: string;
  mime_type: string;
  size: number;
  sha256: string;
  expires_at: string;
  uri: string;
}

export interface ConfigResponse {
  config_path?: string;
  config_file?: string;
  config_exists?: boolean;
  [key: string]: unknown;
}

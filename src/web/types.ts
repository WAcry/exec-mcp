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
  output?: unknown | undefined;
  error?: string | undefined;
  status: "success" | "error";
}

export interface CallRecord {
  id: string;
  sessionId: string;
  tool: string;
  status: CallStatus;
  startedAt: string;
  endedAt?: string | undefined;
  durationMs?: number | undefined;
  args: {
    source?: string | undefined;
    workdir?: string | undefined;
    yield_time_ms?: number | undefined;
    max_output_tokens?: number | undefined;
    files?:
      | {
          name?: string | undefined;
          size?: number | undefined;
          type?: string | undefined;
        }[]
      | undefined;
    cell_id?: string | undefined;
    terminate?: boolean | undefined;
    [key: string]: unknown;
  };
  subcalls: SubCallRecord[];
  omittedSubcalls?: number | undefined;
  truncatedFields?: number | undefined;
  output?: unknown | undefined;
  error?: string | undefined;
}

export interface SessionSummary {
  id: string;
  callCount: number;
  errorCount: number;
  firstSeen: string;
  lastActive: string;
  lastCall?:
    | {
        id: string;
        tool: string;
        status: CallStatus;
        durationMs?: number | undefined;
        timestamp: string;
        preview: string;
      }
    | undefined;
}

export interface CallFilterOptions {
  sessionId?: string | undefined;
  status?: string | undefined;
  tool?: string | undefined;
  search?: string | undefined;
  page?: number | undefined;
  pageSize?: number | undefined;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
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

export interface TerminalSessionItem {
  id: string;
  exitCode?: number | undefined;
  touched: number;
  observers: number;
  kind: "pipe" | "pty";
  pid?: number | undefined;
  bufferBytes: number;
  bufferCapacityBytes: number;
  omittedBytes: number;
}

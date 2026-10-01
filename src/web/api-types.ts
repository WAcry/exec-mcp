/**
 * The Web console HTTP contract, shared by the server and the browser.
 * Type-only imports keep this module free of Node APIs, so the UI can use it.
 */
import type {
  ActivityEvent,
  ActivityStats,
  CallListItem,
  CallRecord,
  CodeModeMemoryStatus,
  NativeSessionItem,
  PaginatedResult,
  SessionSummary,
} from "./types.js";
import type {
  SessionNote,
  SessionNotesEvent,
  SessionNotesPage,
} from "../session-notes-types.js";
import type { UserQuestionsPage } from "../user-questions-types.js";

/** Stable failure codes. The UI translates them; `message` is a diagnostic. */
export const API_ERROR_CODES = [
  "unauthorized",
  "invalid_token",
  "forbidden_origin",
  "missing_action_header",
  "loopback_only",
  "invalid_url",
  "invalid_json",
  "invalid_request",
  "body_too_large",
  "not_found",
  "method_not_allowed",
  "call_not_found",
  "media_not_found",
  "conversation_not_found",
  "question_not_found",
  "note_not_found",
  "note_invalid_id",
  "note_empty",
  "note_too_long",
  "note_changed",
  "note_attached",
  "label_too_long",
  "invalid_option",
  "answer_required",
  "answer_too_long",
  "answer_changed",
  "question_answered",
  "notes_full",
  "message_too_long",
  "web_unavailable",
  "conversation_unknown",
  "request_key_changed",
  "management_unavailable",
  "restart_in_progress",
  "config_conflict",
  "config_unreadable",
  "config_entry_missing",
  "config_unsafe_edit",
  "too_many_event_clients",
  "internal_error",
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export interface ApiErrorBody {
  error: ApiErrorCode;
  message: string;
  needAuth?: true;
}

export type ServiceState = "ready" | "restarting" | "error" | "stopped";

/** MCP wire traffic since the process started, to decide when 2025-era support can go. */
export interface ProtocolStats {
  since: string;
  /** 2025-era Streamable HTTP with initialize and Mcp-Session-Id. */
  legacy: {
    requests: number;
    sessions: number;
    openSessions: number;
    lastRequestAt?: string;
  };
  /** Stateless per-request envelope era; it has no sessions. */
  modern: { requests: number; lastRequestAt?: string };
}

export interface StatusResponse {
  status: ServiceState;
  generation: number;
  version: string;
  uptime: number;
  isLoopback: boolean;
  mcp: {
    host: string;
    port: number;
    access: string;
    public_url?: string | undefined;
    protocol?: ProtocolStats | undefined;
  };
  web: {
    host: string;
    port: number;
    exposed: boolean;
    loopbackUrl: string;
    lanUrls: string[];
  };
  stats: ActivityStats;
  memory: CodeModeMemoryStatus;
  system: {
    hostname: string;
    platform: string;
    arch: string;
    nodeVersion: string;
  };
}

export interface VerifyResponse {
  valid: true;
}
export interface SuccessResponse {
  success: true;
}
export interface RestartResponse {
  accepted: true;
}
export interface RegenerateTokenResponse {
  success: true;
  lanUrls: string[];
}

export interface SessionsResponse extends PaginatedResult<SessionSummary> {
  pendingQuestionsTotal: number;
}
export type NotesResponse = SessionNotesPage;
export type NoteResponse = SessionNote;
export type QuestionsResponse = UserQuestionsPage;
export type CallsResponse = PaginatedResult<CallListItem>;
export type CallResponse = CallRecord;

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
  /** The name of the environment variable with the bearer token, never its value. */
  bearerTokenEnvVar?: string;
  cwd?: string;
  url?: string;
  enabledTools?: readonly string[] | undefined;
  startupTimeoutMs?: number | undefined;
  toolTimeoutMs?: number | undefined;
  enabled?: boolean;
  active?: boolean;
}
export interface McpToolItem {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown> | undefined;
}
export interface McpServersResponse {
  servers: McpServerItem[];
  tools: McpToolItem[];
  errors: Record<string, string>;
}

export interface ManagementResponse {
  available: boolean;
  revision?: string;
  pending?: boolean;
  state?: ServiceState;
  generation?: number;
  error?: string;
  servers?: { name: string; enabled: boolean; active: boolean }[];
  settings?: { login: boolean; web: boolean };
}

export interface TerminalItem {
  id: string;
  command: string;
  cwd: string;
  owner?: string | undefined;
  exitCode?: number | undefined;
  touched: number;
  observers: number;
  kind: "pipe" | "pty";
  pid?: number | undefined;
  bufferBytes: number;
  bufferCapacityBytes: number;
  omittedBytes: number;
}
export interface TerminalsResponse {
  sessions: TerminalItem[];
}
export interface NativeSessionsResponse {
  sessions: NativeSessionItem[];
  memory: CodeModeMemoryStatus;
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
export interface ArtifactsResponse {
  artifacts: ArtifactItem[];
}

/** What the running instance loaded, with credentials and private paths hidden. */
export interface ConfigResponse {
  config_path?: string;
  config_file?: string;
  config_exists: boolean;
  server: {
    host: string;
    port: number;
    access: string;
    public_url?: string;
  };
  web: { enabled: boolean; host: string; port: number };
  auth?: object;
  tunnel?: object;
  execution?: object | undefined;
  memory: object;
  skills: { max_chars: number; config: object[] };
  files?: object | undefined;
  mcp_servers: McpServerItem[];
}

export type ConfigToggleRequest =
  | { kind: "mcp"; name: string; enabled: boolean; revision: string }
  | {
      kind: "skill";
      path: string;
      workdir?: string;
      enabled: boolean;
      revision: string;
    }
  | {
      kind: "setting";
      name: "execution.login" | "web.enabled";
      enabled: boolean;
      revision: string;
    };

/** Sent after an execution-service restart starts, finishes, or fails. */
export interface RuntimeEvent {
  type: "runtime";
  state: ServiceState;
  generation: number;
}

export type LiveEvent =
  | { type: "connected"; timestamp: string }
  | ActivityEvent
  | SessionNotesEvent
  | RuntimeEvent;

import { randomUUID } from "node:crypto";
import { callPreview } from "../tool-names.js";
import type {
  CallRecord,
  CallStatus,
  CallFilterOptions,
  PaginatedResult,
  SessionSummary,
  SubCallRecord,
  ActivityStats,
} from "./types.js";
import { snapshotAuditValue, truncateAuditText } from "./snapshot.js";

export type ActivityEvent =
  | { type: "call:start"; callId: string; sessionId: string }
  | { type: "call:subcall"; callId: string; subcallId: string }
  | { type: "call:finish"; callId: string; status: CallStatus }
  | { type: "call:clear" };

export interface ActiveCallController {
  id: string;
  call: CallRecord;
  recordSubcall(
    subcall: Omit<SubCallRecord, "id" | "timestamp"> & {
      id?: string;
      timestamp?: string;
    },
  ): SubCallRecord;
  finish(result: {
    status: CallStatus;
    output?: unknown;
    error?: string;
  }): CallRecord;
}

export class ActivityStore {
  private readonly maxCalls: number;
  private readonly maxSubcalls: number;
  private enabled: boolean;
  private calls: CallRecord[] = [];
  private callsById = new Map<string, CallRecord>();
  private sessions = new Map<string, SessionSummary>();
  private listeners = new Set<(event: ActivityEvent) => void>();

  constructor(
    options: {
      maxCalls?: number;
      maxSubcalls?: number;
      enabled?: boolean;
    } = {},
  ) {
    this.maxCalls = options.maxCalls ?? 200;
    this.maxSubcalls = options.maxSubcalls ?? 50;
    this.enabled = options.enabled ?? true;
    if (!Number.isSafeInteger(this.maxCalls) || this.maxCalls < 1)
      throw new Error("活动审计 maxCalls 必须是正安全整数。");
    if (!Number.isSafeInteger(this.maxSubcalls) || this.maxSubcalls < 2)
      throw new Error("活动审计 maxSubcalls 必须至少为 2。");
  }

  subscribe(listener: (event: ActivityEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: ActivityEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* Ignore listener errors */
      }
    }
  }

  startCall(params: {
    tool: string;
    sessionId: string;
    args: CallRecord["args"];
  }): ActiveCallController {
    if (!this.enabled) return disabledCall(params);
    const id = `call_${randomUUID()}`;
    const startTime = Date.now();
    const startedAt = new Date(startTime).toISOString();
    const sessionId = params.sessionId || "default";

    const capturedArgs = this.snapshotArgs(params.args);
    const args = capturedArgs.value;
    const call: CallRecord = {
      id,
      sessionId,
      tool: params.tool,
      status: "running",
      startedAt,
      args,
      subcalls: [],
      ...(capturedArgs.truncatedFields
        ? { truncatedFields: capturedArgs.truncatedFields }
        : {}),
    };

    this.calls.unshift(call);
    this.callsById.set(id, call);

    if (this.calls.length > this.maxCalls) {
      const removed = this.calls.pop();
      if (removed) {
        this.callsById.delete(removed.id);
        this.rebuildSession(removed.sessionId);
      }
    }

    let session = this.sessions.get(sessionId);
    if (!session) {
      session = {
        id: sessionId,
        callCount: 0,
        errorCount: 0,
        firstSeen: startedAt,
        lastActive: startedAt,
      };
      this.sessions.set(sessionId, session);
    }
    session.callCount++;
    session.lastActive = startedAt;
    session.lastCall = {
      id,
      tool: params.tool,
      status: "running",
      timestamp: startedAt,
      preview: this.extractPreview(params.tool, args),
    };

    this.emit({ type: "call:start", callId: id, sessionId });

    let finished = false;

    return {
      id,
      call,
      recordSubcall: (subcallInput) => {
        const input = snapshotAuditValue(subcallInput.input, 4096);
        const output =
          subcallInput.output === undefined
            ? undefined
            : snapshotAuditValue(subcallInput.output, 8192);
        const error =
          subcallInput.error === undefined
            ? undefined
            : truncateAuditText(subcallInput.error, 4096);
        const subcall: SubCallRecord = {
          id: subcallInput.id ?? `sub_${randomUUID()}`,
          timestamp: subcallInput.timestamp ?? new Date().toISOString(),
          name: subcallInput.name,
          durationMs: subcallInput.durationMs,
          input: input.value,
          ...(output === undefined ? {} : { output: output.value }),
          ...(error === undefined ? {} : { error: error.value }),
          status: subcallInput.status,
        };
        if (input.truncated || output?.truncated || error?.truncated)
          call.truncatedFields = (call.truncatedFields ?? 0) + 1;
        if (this.callsById.has(id)) this.pushSubcall(call, subcall);
        this.emit({ type: "call:subcall", callId: id, subcallId: subcall.id });
        return subcall;
      },
      finish: ({ status, output, error }) => {
        if (finished) return call;
        finished = true;
        const endTime = Date.now();
        call.status = status;
        call.endedAt = new Date(endTime).toISOString();
        call.durationMs = endTime - startTime;
        if (output !== undefined && this.callsById.has(id)) {
          const snapshot = snapshotAuditValue(output, 16 * 1024);
          call.output = snapshot.value;
          if (snapshot.truncated)
            call.truncatedFields = (call.truncatedFields ?? 0) + 1;
        }
        if (error !== undefined && this.callsById.has(id)) {
          const snapshot = truncateAuditText(error, 4096);
          call.error = snapshot.value;
          if (snapshot.truncated)
            call.truncatedFields = (call.truncatedFields ?? 0) + 1;
        }

        const currentSession = this.sessions.get(sessionId);
        if (currentSession && this.callsById.has(id)) {
          if (status === "error") {
            currentSession.errorCount++;
          }
          currentSession.lastActive = call.endedAt;
          if (currentSession.lastCall?.id === id) {
            currentSession.lastCall.status = status;
            currentSession.lastCall.durationMs = call.durationMs;
          }
        }

        this.emit({ type: "call:finish", callId: id, status });
        return call;
      },
    };
  }

  getCall(id: string): CallRecord | undefined {
    return this.callsById.get(id);
  }

  getCalls(options: CallFilterOptions = {}): PaginatedResult<CallRecord> {
    const requestedPage = Math.max(1, options.page ?? 1);
    const pageSize = Math.max(1, Math.min(100, options.pageSize ?? 20));

    let filtered = this.calls;

    if (options.sessionId && options.sessionId !== "all") {
      filtered = filtered.filter((c) => c.sessionId === options.sessionId);
    }

    if (options.status && options.status !== "all") {
      filtered = filtered.filter((c) => c.status === options.status);
    }

    if (options.tool && options.tool !== "all") {
      filtered = filtered.filter((c) => c.tool === options.tool);
    }

    if (options.search && options.search.trim()) {
      const q = options.search.trim().toLowerCase();
      filtered = filtered.filter((c) => {
        if (c.id.toLowerCase().includes(q)) return true;
        if (c.sessionId.toLowerCase().includes(q)) return true;
        if (c.tool.toLowerCase().includes(q)) return true;
        if (
          Object.values(c.args).some(
            (value) =>
              typeof value === "string" && value.toLowerCase().includes(q),
          )
        )
          return true;
        if (c.error && c.error.toLowerCase().includes(q)) return true;
        if (
          c.subcalls.some(
            (s) =>
              s.name.toLowerCase().includes(q) ||
              JSON.stringify(s.input).toLowerCase().includes(q) ||
              (s.output && JSON.stringify(s.output).toLowerCase().includes(q)),
          )
        ) {
          return true;
        }
        if (c.output && JSON.stringify(c.output).toLowerCase().includes(q)) {
          return true;
        }
        return false;
      });
    }

    const total = filtered.length;
    const totalPages = Math.ceil(total / pageSize) || 1;
    const page = Math.min(requestedPage, totalPages);
    const offset = (page - 1) * pageSize;
    const items = filtered.slice(offset, offset + pageSize);

    return {
      items,
      total,
      page,
      pageSize,
      totalPages,
    };
  }

  getSessions(
    options: {
      search?: string;
      page?: number;
      pageSize?: number;
    } = {},
  ): PaginatedResult<SessionSummary> {
    const requestedPage = Math.max(1, options.page ?? 1);
    const pageSize = Math.max(1, Math.min(100, options.pageSize ?? 20));

    let list = Array.from(this.sessions.values()).sort(
      (a, b) =>
        new Date(b.lastActive).getTime() - new Date(a.lastActive).getTime(),
    );

    if (options.search && options.search.trim()) {
      const q = options.search.trim().toLowerCase();
      list = list.filter(
        (s) =>
          s.id.toLowerCase().includes(q) ||
          (s.lastCall?.preview && s.lastCall.preview.toLowerCase().includes(q)),
      );
    }

    const total = list.length;
    const totalPages = Math.ceil(total / pageSize) || 1;
    const page = Math.min(requestedPage, totalPages);
    const offset = (page - 1) * pageSize;
    const items = list.slice(offset, offset + pageSize);

    return {
      items,
      total,
      page,
      pageSize,
      totalPages,
    };
  }

  getStats(): ActivityStats {
    let errorCalls = 0;
    let runningCalls = 0;
    let totalDuration = 0;
    let finishedCount = 0;

    for (const call of this.calls) {
      if (call.status === "error") errorCalls++;
      else if (call.status === "running") runningCalls++;

      if (call.durationMs !== undefined) {
        totalDuration += call.durationMs;
        finishedCount++;
      }
    }

    return {
      totalCalls: this.calls.length,
      activeSessions: this.sessions.size,
      errorCalls,
      runningCalls,
      avgDurationMs:
        finishedCount > 0 ? Math.round(totalDuration / finishedCount) : 0,
      truncatedFields: this.calls.reduce(
        (total, call) => total + (call.truncatedFields ?? 0),
        0,
      ),
      omittedSubcalls: this.calls.reduce(
        (total, call) => total + (call.omittedSubcalls ?? 0),
        0,
      ),
    };
  }

  clear(): void {
    this.calls = [];
    this.callsById.clear();
    this.sessions.clear();
    this.emit({ type: "call:clear" });
  }

  disable(): void {
    if (!this.enabled) return;
    this.enabled = false;
    this.clear();
  }

  private extractPreview(tool: string, args: CallRecord["args"]): string {
    return callPreview(tool, args).slice(0, 80);
  }

  private snapshotArgs(args: CallRecord["args"]): {
    value: CallRecord["args"];
    truncatedFields: number;
  } {
    const result: CallRecord["args"] = {};
    let truncated = 0;
    for (const [key, value] of Object.entries(args)) {
      if (value === undefined) continue;
      if (key === "source" && typeof value === "string") {
        const snapshot = truncateAuditText(value, 16 * 1024);
        result.source = snapshot.value;
        if (snapshot.truncated) truncated++;
        continue;
      }
      const snapshot = snapshotAuditValue(value, 8192);
      result[key] = snapshot.value;
      if (snapshot.truncated) truncated++;
    }
    return { value: result, truncatedFields: truncated };
  }

  private pushSubcall(call: CallRecord, subcall: SubCallRecord): void {
    if (call.subcalls.length < this.maxSubcalls) {
      call.subcalls.push(subcall);
      return;
    }
    const head = Math.max(1, Math.floor(this.maxSubcalls / 5));
    call.subcalls.splice(head, 1);
    call.subcalls.push(subcall);
    call.omittedSubcalls = (call.omittedSubcalls ?? 0) + 1;
  }

  private rebuildSession(sessionId: string): void {
    const calls = this.calls.filter((call) => call.sessionId === sessionId);
    if (!calls.length) {
      this.sessions.delete(sessionId);
      return;
    }
    const newest = calls[0]!;
    const oldest = calls.at(-1)!;
    this.sessions.set(sessionId, {
      id: sessionId,
      callCount: calls.length,
      errorCount: calls.filter((call) => call.status === "error").length,
      firstSeen: oldest.startedAt,
      lastActive: newest.endedAt ?? newest.startedAt,
      lastCall: {
        id: newest.id,
        tool: newest.tool,
        status: newest.status,
        ...(newest.durationMs === undefined
          ? {}
          : { durationMs: newest.durationMs }),
        timestamp: newest.startedAt,
        preview: this.extractPreview(newest.tool, newest.args),
      },
    });
  }
}

function disabledCall(params: {
  tool: string;
  sessionId: string;
  args: CallRecord["args"];
}): ActiveCallController {
  const call: CallRecord = {
    id: "audit-disabled",
    sessionId: params.sessionId || "unscoped",
    tool: params.tool,
    status: "running",
    startedAt: "",
    args: {},
    subcalls: [],
  };
  return {
    id: call.id,
    call,
    recordSubcall(subcall) {
      return {
        id: subcall.id ?? "audit-disabled",
        timestamp: subcall.timestamp ?? "",
        name: subcall.name,
        durationMs: subcall.durationMs,
        input: "[审计已关闭]",
        status: subcall.status,
        ...(subcall.error === undefined ? {} : { error: "[审计已关闭]" }),
      };
    },
    finish(result) {
      call.status = result.status;
      return call;
    },
  };
}

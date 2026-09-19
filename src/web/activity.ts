import type {
  CallRecord,
  CallStatus,
  CallFilterOptions,
  PaginatedResult,
  SessionSummary,
  SubCallRecord,
  ActivityStats,
} from "./types.js";

export type ActivityEvent =
  | { type: "call:start"; call: CallRecord }
  | { type: "call:subcall"; callId: string; subcall: SubCallRecord }
  | { type: "call:finish"; call: CallRecord }
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
  private calls: CallRecord[] = [];
  private callsById = new Map<string, CallRecord>();
  private sessions = new Map<string, SessionSummary>();
  private listeners = new Set<(event: ActivityEvent) => void>();

  constructor(options: { maxCalls?: number } = {}) {
    this.maxCalls = options.maxCalls ?? 1000;
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
    tool: "exec" | "wait";
    sessionId: string;
    args: CallRecord["args"];
  }): ActiveCallController {
    const id = `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const startTime = Date.now();
    const startedAt = new Date(startTime).toISOString();
    const sessionId = params.sessionId || "default";

    const call: CallRecord = {
      id,
      sessionId,
      tool: params.tool,
      status: "running",
      startedAt,
      args: params.args,
      subcalls: [],
    };

    this.calls.unshift(call);
    this.callsById.set(id, call);

    if (this.calls.length > this.maxCalls) {
      const removed = this.calls.pop();
      if (removed) {
        this.callsById.delete(removed.id);
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
      preview: this.extractPreview(params.tool, params.args),
    };

    this.emit({ type: "call:start", call });

    let finished = false;

    return {
      id,
      call,
      recordSubcall: (subcallInput) => {
        const subcall: SubCallRecord = {
          id:
            subcallInput.id ??
            `sub_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          timestamp: subcallInput.timestamp ?? new Date().toISOString(),
          name: subcallInput.name,
          durationMs: subcallInput.durationMs,
          input: subcallInput.input,
          ...(subcallInput.output !== undefined
            ? { output: subcallInput.output }
            : {}),
          ...(subcallInput.error !== undefined
            ? { error: subcallInput.error }
            : {}),
          status: subcallInput.status,
        };
        call.subcalls.push(subcall);
        this.emit({ type: "call:subcall", callId: id, subcall });
        return subcall;
      },
      finish: ({ status, output, error }) => {
        if (finished) return call;
        finished = true;
        const endTime = Date.now();
        call.status = status;
        call.endedAt = new Date(endTime).toISOString();
        call.durationMs = endTime - startTime;
        if (output !== undefined) call.output = output;
        if (error !== undefined) call.error = error;

        const currentSession = this.sessions.get(sessionId);
        if (currentSession) {
          if (status === "error") {
            currentSession.errorCount++;
          }
          currentSession.lastActive = call.endedAt;
          if (currentSession.lastCall?.id === id) {
            currentSession.lastCall.status = status;
            currentSession.lastCall.durationMs = call.durationMs;
          }
        }

        this.emit({ type: "call:finish", call });
        return call;
      },
    };
  }

  getCall(id: string): CallRecord | undefined {
    return this.callsById.get(id);
  }

  getCalls(options: CallFilterOptions = {}): PaginatedResult<CallRecord> {
    const page = Math.max(1, options.page ?? 1);
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
        if (c.args.source && c.args.source.toLowerCase().includes(q))
          return true;
        if (c.args.cell_id && c.args.cell_id.toLowerCase().includes(q))
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
    const page = Math.max(1, options.page ?? 1);
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
    };
  }

  clear(): void {
    this.calls = [];
    this.callsById.clear();
    this.sessions.clear();
    this.emit({ type: "call:clear" });
  }

  private extractPreview(tool: string, args: CallRecord["args"]): string {
    if (tool === "exec" && args.source) {
      const line = args.source.split("\n")[0]?.trim() ?? "";
      return line.slice(0, 80);
    }
    if (tool === "wait") {
      return `wait(${args.cell_id ?? "unknown"})`;
    }
    return `${tool}()`;
  }
}

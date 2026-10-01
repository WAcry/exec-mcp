import crypto from "node:crypto";
import { performance } from "node:perf_hooks";

import { encodePayload } from "../limits.js";
import { randomHandle, throwIfAborted } from "../util.js";
import { WeightedAdmissionQueue } from "./admission.js";
import { CellRegistry, type CellOwner } from "./cell-registry.js";
import {
  DEFAULT_EXEC_YIELD_TIME_MS,
  DEFAULT_WAIT_YIELD_TIME_MS,
  hostSource,
  MAX_EXEC_YIELD_TIME_MS,
  MAX_WAIT_YIELD_TIME_MS,
  parseExecSource,
  validateNonNegativeSafeInteger,
  validateYieldTime,
} from "./exec-source.js";
import { CodeModeHostProcess } from "./host-process.js";
import { MemoryReclaimer, type MemoryStatus } from "./memory-reclaimer.js";
import {
  elapsedSeconds,
  renderModelResult,
  undeliverableResult,
} from "./render.js";
import { CodeModeSession, type RuntimeOutcome } from "./session.js";
import {
  SessionPool,
  MEMORY_RECLAIMED_TEXT,
  SESSION_IDLE_MS,
  type RetirementReason,
  type SessionLease,
} from "./session-pool.js";
import { MEMORY_DEFAULTS, MiB } from "../memory.js";
import { readProcessMemory } from "../host/process-memory.js";
import { validateOutputBudget } from "./output-budget.js";
import { syntaxDiagnostic } from "./diagnostics.js";
import type {
  CodeModeExecRequest,
  CodeModeServiceOptions,
  CodeModeToolResult,
  CodeModeWaitRequest,
} from "./types.js";

export {
  DEFAULT_EXEC_YIELD_TIME_MS,
  DEFAULT_WAIT_YIELD_TIME_MS,
  MAX_EXEC_YIELD_TIME_MS,
  MAX_WAIT_YIELD_TIME_MS,
  parseExecSource,
} from "./exec-source.js";
export { INVALIDATED_CELL_RETENTION_MS } from "./cell-registry.js";
export const INDETERMINATE_CELL_TEXT =
  "The Code Mode host stopped during execution. The result is unknown, and tool side effects may have happened. Check the current state before you run the work again; do not retry automatically.";

/** Host failures and memory restarts go to the service's stderr by default. */
function logError(error: Error): void {
  process.stderr.write(`${error.message}\n`);
}

export class CodeModeService {
  readonly #admission = new WeightedAdmissionQueue();
  readonly #cellIdleMs: number;
  readonly #cellSweep: NodeJS.Timeout;
  readonly #cells = new CellRegistry(MEMORY_RECLAIMED_TEXT);
  readonly #defaultExecYieldTimeMs: number;
  readonly #defaultWaitYieldTimeMs: number;
  readonly #host: CodeModeHostProcess;
  readonly #maxHeapSizeBytes: number | undefined;
  readonly #maxYieldTimeMs: number | undefined;
  readonly #memory: MemoryReclaimer;
  readonly #pool: SessionPool;
  readonly #startupTimeoutMs: number;
  readonly #transportTimeoutMs: number;
  #closePromise: Promise<void> | undefined;
  #stopping = false;

  constructor(options: CodeModeServiceOptions = {}) {
    this.#defaultExecYieldTimeMs =
      options.defaultExecYieldTimeMs ?? DEFAULT_EXEC_YIELD_TIME_MS;
    this.#defaultWaitYieldTimeMs =
      options.defaultWaitYieldTimeMs ?? DEFAULT_WAIT_YIELD_TIME_MS;
    // The pinned native host ignores max_heap_size_bytes; don't advertise it as protection.
    this.#maxHeapSizeBytes = options.maxHeapSizeBytes;
    this.#maxYieldTimeMs = options.maxYieldTimeMs;
    this.#startupTimeoutMs = options.startupTimeoutMs ?? 60_000;
    this.#transportTimeoutMs = options.transportTimeoutMs ?? 60_000;
    validateNonNegativeSafeInteger(this.#startupTimeoutMs, "startupTimeoutMs");
    validateNonNegativeSafeInteger(
      this.#transportTimeoutMs,
      "transportTimeoutMs",
    );
    validateYieldTime(
      this.#defaultExecYieldTimeMs,
      "defaultExecYieldTimeMs",
      MAX_EXEC_YIELD_TIME_MS,
    );
    validateYieldTime(
      this.#defaultWaitYieldTimeMs,
      "defaultWaitYieldTimeMs",
      MAX_WAIT_YIELD_TIME_MS,
    );
    if (this.#maxHeapSizeBytes !== undefined) {
      validateNonNegativeSafeInteger(
        this.#maxHeapSizeBytes,
        "maxHeapSizeBytes",
      );
    }
    if (this.#maxYieldTimeMs !== undefined) {
      validateNonNegativeSafeInteger(this.#maxYieldTimeMs, "maxYieldTimeMs");
    }
    const onError = options.onError ?? logError;
    const memoryHighWater =
      options.memoryHighWaterBytes ??
      MEMORY_DEFAULTS.code_mode_high_water_mib * MiB;
    const memoryCloseTimeout = options.memoryCloseTimeoutMs ?? 5000;
    const memoryInterval = options.memoryCheckIntervalMs ?? 5000;
    for (const [name, value] of Object.entries({
      memoryHighWaterBytes: memoryHighWater,
      memoryCloseTimeoutMs: memoryCloseTimeout,
      memoryCheckIntervalMs: memoryInterval,
    }))
      if (!Number.isSafeInteger(value) || value <= 0)
        throw new Error(`${name} must be a positive safe integer.`);

    this.#pool = new SessionPool(
      () => this.#openSession(),
      options.sessionIdleMs,
      (session, reason) =>
        this.#cells.retireSession(
          session,
          reason === "memory" ? MEMORY_RECLAIMED_TEXT : INDETERMINATE_CELL_TEXT,
        ),
    );
    this.#host = new CodeModeHostProcess({
      ...(options.hostBinary === undefined
        ? {}
        : { binary: options.hostBinary }),
      onUnexpectedExit: (error) => {
        try {
          onError(error);
        } catch {
          // Observability must not interfere with automatic host recovery.
        }
        this.#invalidateSessions();
      },
      startupTimeoutMs: this.#startupTimeoutMs,
    });
    this.#memory = new MemoryReclaimer({
      closeTimeoutMs: memoryCloseTimeout,
      highWaterBytes: memoryHighWater,
      host: this.#host,
      intervalMs: memoryInterval,
      invalidateAll: () => this.#invalidateSessions("memory"),
      onError:
        options.onError ??
        ((error) => process.stderr.write(`${error.message}\n`)),
      onTick: () => this.#cells.cleanupExpired(),
      pool: this.#pool,
      reader: options.memoryReader ?? readProcessMemory,
    });
    // A yielded cell holds its session lease until wait collects the result.
    // Stop cells nobody observes so their sessions follow idle retention.
    this.#cellIdleMs = options.sessionIdleMs ?? SESSION_IDLE_MS;
    this.#cellSweep = setInterval(
      () => this.#stopUnobservedCells(),
      Math.min(this.#cellIdleMs, 60_000),
    );
    this.#cellSweep.unref();
  }

  async exec(request: CodeModeExecRequest): Promise<CodeModeToolResult> {
    this.#requireRunning();
    throwIfAborted(
      request.signal,
      "Code Mode execution was aborted before it started",
    );
    encodePayload({
      source: request.source,
      tools: request.tools.map(({ call: _call, ...definition }) => definition),
    });
    const parsed = parseExecSource(request.source);
    const yieldTimeMs =
      request.yieldTimeMs ?? parsed.yieldTimeMs ?? this.#defaultExecYieldTimeMs;
    validateYieldTime(yieldTimeMs, "yield_time_ms", MAX_EXEC_YIELD_TIME_MS);
    const maxOutputTokens = request.maxOutputTokens ?? parsed.maxOutputTokens;
    validateOutputBudget(maxOutputTokens, "max_output_tokens");
    // A host-wide emergency reset has a short barrier. It never replays a command
    // already sent to an old session, and it never requires a new metadata scope.
    await this.#memory.restarting;
    this.#requireRunning();
    const scope = sessionScopeKey(request.sessionScope);
    const lease = await this.#pool.acquire(scope);
    const session = lease.session;
    const startedAt = performance.now();
    try {
      this.#requireRunning();
      throwIfAborted(
        request.signal,
        "Code Mode execution was aborted before it started",
      );
      lease.assertActive();
      const requestId = request.requestId ?? randomHandle("exec");
      const hostOutcome = await session.execute({
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        source: hostSource(parsed.code, scope !== undefined),
        toolCallId: requestId,
        tools: request.tools,
        yieldTimeMs,
      });
      if (hostOutcome.state === "completed" && hostOutcome.errorText) {
        const diagnostic = syntaxDiagnostic(
          request.source,
          hostOutcome.errorText,
          requestId,
        );
        if (diagnostic) hostOutcome.errorText += `\n${diagnostic}`;
      }
      const outcome = this.#trackOutcome(
        lease,
        scope,
        hostOutcome,
        undefined,
        request.takeAttachments,
      );
      notifyState(request.onState, outcome.state);
      return this.#modelResult(
        outcome,
        elapsedSeconds(startedAt, performance.now()),
        maxOutputTokens,
        request.takeAttachments,
        lease.newSession && scope !== undefined
          ? "New native session: store was empty when this exec started.\n"
          : undefined,
      );
    } catch (error) {
      lease.release();
      throw lease.reclaimed ? new Error(MEMORY_RECLAIMED_TEXT) : error;
    }
  }

  async wait(request: CodeModeWaitRequest): Promise<CodeModeToolResult> {
    this.#requireRunning();
    validateOutputBudget(request.maxTokens, "max_tokens");
    const yieldTimeMs = request.yieldTimeMs ?? this.#defaultWaitYieldTimeMs;
    validateYieldTime(yieldTimeMs, "yield_time_ms", MAX_WAIT_YIELD_TIME_MS);
    const scope = sessionScopeKey(request.sessionScope);
    const owner = this.#cells.owner(request.cellId, scope);
    const endObservation = this.#cells.observe(owner);
    const startedAt = performance.now();
    const observe = async (): Promise<CodeModeToolResult> => {
      try {
        // Retire a cancelled observer before admitting the next one. Queue time
        // counts against this request's budget, not a second full wait window.
        this.#cells.owner(request.cellId, scope);
        owner.lease.touch();
        const remaining = Math.max(
          0,
          Math.floor(yieldTimeMs - (performance.now() - startedAt)),
        );
        const hostOutcome =
          request.terminate === true
            ? await owner.session.terminate(owner.hostCellId, request.signal)
            : await owner.session.wait({
                cellId: owner.hostCellId,
                ...(request.signal === undefined
                  ? {}
                  : { signal: request.signal }),
                yieldTimeMs: remaining,
              });
        const outcome = this.#trackOutcome(
          owner.lease,
          owner.scope,
          hostOutcome,
          request.cellId,
          owner.takeAttachments,
        );
        notifyState(request.onState, outcome.state);
        return this.#modelResult(
          outcome,
          elapsedSeconds(startedAt, performance.now()),
          request.maxTokens,
          owner.takeAttachments,
        );
      } catch (error) {
        throw owner.lease.reclaimed ? new Error(MEMORY_RECLAIMED_TEXT) : error;
      }
    };
    try {
      if (request.terminate === true) return await observe();
      return await owner.observer.run(
        request.signal ?? new AbortController().signal,
        observe,
      );
    } finally {
      endObservation();
    }
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#close();
    return this.#closePromise;
  }

  getNativeSessions() {
    return this.#pool.getNativeSessions();
  }

  async getMemoryStatus(): Promise<
    MemoryStatus & { idleRetentionHours: number }
  > {
    return {
      ...(await this.#memory.status()),
      idleRetentionHours: Math.round(this.#pool.retentionIdleMs / 3_600_000),
    };
  }

  /** Also callable by tests/embedding code; this is maintenance, not a model tool. */
  checkMemory(): Promise<void> {
    if (this.#stopping) return Promise.resolve();
    this.#cells.cleanupExpired();
    return this.#memory.check();
  }

  async #close(): Promise<void> {
    this.#stopping = true;
    clearInterval(this.#cellSweep);
    await this.#memory.stop();
    this.#cells.clear();
    await this.#pool.close();
    this.#admission.close();
    await this.#host.stop();
  }

  async #openSession(): Promise<CodeModeSession> {
    const client = await this.#host.start();
    this.#requireRunning();
    const session = await CodeModeSession.open({
      client,
      ...(this.#maxHeapSizeBytes === undefined
        ? {}
        : { maxHeapSizeBytes: this.#maxHeapSizeBytes }),
      ...(this.#maxYieldTimeMs === undefined
        ? {}
        : { maxYieldTimeMs: this.#maxYieldTimeMs }),
      admission: this.#admission,
      onFailure: (failedSession) => {
        this.#invalidateSession(failedSession);
      },
      startupTimeoutMs: this.#startupTimeoutMs,
      transportTimeoutMs: this.#transportTimeoutMs,
    });
    if (this.#stopping) {
      await session.close();
      this.#requireRunning();
    }
    return session;
  }

  #trackOutcome(
    lease: SessionLease,
    scope: string | undefined,
    outcome: RuntimeOutcome,
    publicCellId?: string,
    takeAttachments?: CodeModeExecRequest["takeAttachments"],
  ): RuntimeOutcome {
    const session = lease.session;
    lease.assertActive();
    if (outcome.state === "yielded") {
      if (!this.#pool.has(session)) throw new Error(INDETERMINATE_CELL_TEXT);
      const handle = this.#cells.track(publicCellId, {
        hostCellId: outcome.cellId,
        ...(scope === undefined ? {} : { scope }),
        session,
        lease,
        ...(takeAttachments === undefined ? {} : { takeAttachments }),
      });
      return { ...outcome, cellId: handle };
    }
    if (publicCellId !== undefined) this.#cells.finish(publicCellId);
    lease.release();
    return publicCellId === undefined
      ? outcome
      : { ...outcome, cellId: publicCellId };
  }

  #modelResult(
    outcome: RuntimeOutcome,
    wallTimeSeconds: number,
    maxTokens?: number,
    takeAttachments?: CodeModeExecRequest["takeAttachments"],
    notice?: string,
  ): CodeModeToolResult {
    const attachments = takeAttachments?.() ?? [];
    try {
      return renderModelResult(
        outcome,
        wallTimeSeconds,
        maxTokens,
        attachments,
        notice,
      );
    } catch (error) {
      this.#discardUnrepresentableCell(outcome);
      return undeliverableResult(error, attachments);
    }
  }

  #discardUnrepresentableCell(outcome: RuntimeOutcome): void {
    if (outcome.state !== "yielded") return;
    const owner = this.#cells.take(outcome.cellId);
    if (owner === undefined) return;
    void this.#terminateOwner(owner);
  }

  #stopUnobservedCells(): void {
    if (this.#stopping) return;
    const message = `This exec cell was stopped because no wait call observed it for ${formatDuration(this.#cellIdleMs)}. Its unread output is lost, and side effects are not rolled back. Check the current state before you run the work again.`;
    for (const owner of this.#cells.takeUnobserved(this.#cellIdleMs, message))
      void this.#terminateOwner(owner);
  }

  async #terminateOwner(owner: CellOwner): Promise<void> {
    try {
      await owner.session.terminate(owner.hostCellId);
    } catch {
      this.#invalidateSession(owner.session);
    } finally {
      owner.lease.release();
    }
  }

  #invalidateSessions(reason: RetirementReason = "failure"): void {
    this.#cells.retireAll(
      reason === "memory" ? MEMORY_RECLAIMED_TEXT : INDETERMINATE_CELL_TEXT,
    );
    this.#pool.reset(reason);
  }

  #invalidateSession(session: CodeModeSession): void {
    this.#cells.retireSession(session, INDETERMINATE_CELL_TEXT);
    this.#pool.invalidate(session);
  }

  #requireRunning(): void {
    if (this.#stopping) throw new Error("Code Mode service is shutting down");
  }
}

function formatDuration(milliseconds: number): string {
  const units: [number, string][] = [
    [3_600_000, "hour"],
    [60_000, "minute"],
    [1_000, "second"],
  ];
  for (const [size, unit] of units) {
    if (milliseconds >= size) {
      const value = Math.round(milliseconds / size);
      return `${value} ${unit}${value === 1 ? "" : "s"}`;
    }
  }
  return `${milliseconds} ms`;
}

function notifyState(
  observer:
    | ((state: "yielded" | "completed" | "terminated") => void)
    | undefined,
  state: "yielded" | "completed" | "terminated",
): void {
  try {
    observer?.(state);
  } catch {
    /* Web observability must never change execution semantics. */
  }
}

export function sessionScopeKey(scope: string | undefined): string | undefined {
  if (scope === undefined || scope === "") return undefined;
  return crypto.createHash("sha256").update(scope, "utf8").digest("base64url");
}

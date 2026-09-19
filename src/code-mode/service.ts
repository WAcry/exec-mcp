import crypto from "node:crypto";
import { performance } from "node:perf_hooks";

import { encodePayload } from "../limits.js";
import { randomHandle } from "../util.js";
import { CancellableMutex, WeightedAdmissionQueue } from "./admission.js";
import { CodeModeHostProcess, type HostIdentity } from "./host-process.js";
import { outputItemsToCallToolResult } from "./result.js";
import { CodeModeSession, type RuntimeOutcome } from "./session.js";
import {
  SessionPool,
  MEMORY_RECLAIMED_TEXT,
  type RetirementReason,
  type SessionLease,
} from "./session-pool.js";
import { MEMORY_DEFAULTS, MiB } from "../memory.js";
import {
  readProcessMemory,
  type MemoryReader,
} from "../host/process-memory.js";
import { applyOutputBudget, validateOutputBudget } from "./output-budget.js";
import type {
  CodeModeExecRequest,
  CodeModeOutputItem,
  CodeModeServiceOptions,
  CodeModeToolResult,
  CodeModeWaitRequest,
} from "./types.js";

export const DEFAULT_EXEC_YIELD_TIME_MS = 10_000;
export const DEFAULT_WAIT_YIELD_TIME_MS = 110_000;
export const MAX_EXEC_YIELD_TIME_MS = 30_000;
export const MAX_WAIT_YIELD_TIME_MS = 110_000;
export const INVALIDATED_CELL_RETENTION_MS = 24 * 60 * 60 * 1_000;
const MAX_INVALIDATED_CELLS = 4096;
export const INDETERMINATE_CELL_TEXT =
  "Code Mode host 在执行期间退出；结果不确定，工具副作用可能已发生，请先检查状态，勿自动重试。";

// Unsupported helpers must fail explicitly; retain the native ALL_TOOLS catalog.
const CODE_MODE_SOURCE_PRELUDE = "delete globalThis.notify;";
const UNSCOPED_STORE_PRELUDE =
  'globalThis.store = globalThis.load = () => { throw new Error("store/load 需要宿主提供 openai/session 对话标识；本次不可跨 exec 存储。"); };';

interface ParsedExecSource {
  code: string;
  yieldTimeMs?: number;
  maxOutputTokens?: number;
}

interface CellOwner {
  hostCellId: string;
  scope?: string;
  session: CodeModeSession;
  observer: CancellableMutex;
  lease: SessionLease;
  takeAttachments?: CodeModeExecRequest["takeAttachments"];
}

interface InvalidatedCell {
  expiresAt: number;
  scope?: string;
  message: string;
}

export class CodeModeService {
  readonly #admission = new WeightedAdmissionQueue();
  readonly #defaultExecYieldTimeMs: number;
  readonly #defaultWaitYieldTimeMs: number;
  readonly #host: CodeModeHostProcess;
  readonly #maxHeapSizeBytes: number | undefined;
  readonly #maxYieldTimeMs: number | undefined;
  readonly #resultPreparation = new CancellableMutex();
  readonly #startupTimeoutMs: number;
  readonly #transportTimeoutMs: number;
  #cellOwners = new Map<string, CellOwner>();
  #closePromise: Promise<void> | undefined;
  #invalidatedCells = new Map<string, InvalidatedCell>();
  readonly #pool: SessionPool;
  #stopping = false;
  readonly #memoryHighWater: number;
  readonly #memoryReader: MemoryReader;
  readonly #memoryCloseTimeout: number;
  readonly #memoryTimer: NodeJS.Timeout;
  readonly #onMemoryError: (error: Error) => void;
  #memoryCheck: Promise<void> | undefined;
  #restarting: Promise<void> | undefined;
  #memoryErrorReported = false;

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
    const onError = options.onError ?? (() => undefined);
    this.#memoryHighWater =
      options.memoryHighWaterBytes ??
      MEMORY_DEFAULTS.code_mode_high_water_mib * MiB;
    this.#memoryReader = options.memoryReader ?? readProcessMemory;
    this.#memoryCloseTimeout = options.memoryCloseTimeoutMs ?? 5000;
    const memoryInterval = options.memoryCheckIntervalMs ?? 5000;
    for (const [name, value] of Object.entries({
      memoryHighWaterBytes: this.#memoryHighWater,
      memoryCloseTimeoutMs: this.#memoryCloseTimeout,
      memoryCheckIntervalMs: memoryInterval,
    }))
      if (!Number.isSafeInteger(value) || value <= 0)
        throw new Error(`${name} 必须是正安全整数。`);
    this.#onMemoryError =
      options.onError ??
      ((error) => process.stderr.write(`${error.message}\n`));

    this.#pool = new SessionPool(
      (scope) => this.#openSession(scope),
      options.sessionIdleMs,
      (session, reason) =>
        this.#retireCells(
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
    this.#memoryTimer = setInterval(() => {
      void this.checkMemory();
    }, memoryInterval);
    this.#memoryTimer.unref();
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
    validateYieldTime(yieldTimeMs, "yield-time_ms", MAX_EXEC_YIELD_TIME_MS);
    const maxOutputTokens = request.maxOutputTokens ?? parsed.maxOutputTokens;
    validateOutputBudget(request.maxOutputTokens);
    validateOutputBudget(maxOutputTokens);
    // A host-wide emergency reset has a short barrier. It never replays a command
    // already sent to an old session, and it never requires a new metadata scope.
    await this.#restarting;
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
      const hostOutcome = await session.execute({
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        source: `${CODE_MODE_SOURCE_PRELUDE}${scope === undefined ? UNSCOPED_STORE_PRELUDE : ""}${parsed.code}`,
        toolCallId: randomHandle("exec"),
        tools: request.tools,
        yieldTimeMs,
      });
      const outcome = this.#trackOutcome(
        lease,
        scope,
        hostOutcome,
        undefined,
        request.takeAttachments,
      );
      notifyState(request.onState, outcome.state);
      return await this.#modelResult(
        outcome,
        elapsedSeconds(startedAt),
        maxOutputTokens,
        request.takeAttachments,
        lease.newSession && scope !== undefined
          ? "新建原生执行会话；本次开始时 store 为空。\n"
          : undefined,
      );
    } catch (error) {
      lease.release();
      throw lease.reclaimed ? new Error(MEMORY_RECLAIMED_TEXT) : error;
    }
  }

  async wait(request: CodeModeWaitRequest): Promise<CodeModeToolResult> {
    this.#requireRunning();
    validateOutputBudget(request.maxTokens);
    const yieldTimeMs = request.yieldTimeMs ?? this.#defaultWaitYieldTimeMs;
    validateNonNegativeSafeInteger(yieldTimeMs, "yield_time_ms");
    validateYieldTime(yieldTimeMs, "yield-time_ms", MAX_WAIT_YIELD_TIME_MS);
    const owner = await this.#ownerForWait(
      request.cellId,
      sessionScopeKey(request.sessionScope),
    );
    const startedAt = performance.now();
    const observe = async (): Promise<CodeModeToolResult> => {
      try {
        // Retire a cancelled observer before admitting the next one. Queue time
        // counts against this request's budget, not a second full wait window.
        await this.#ownerForWait(
          request.cellId,
          sessionScopeKey(request.sessionScope),
        );
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
          elapsedSeconds(startedAt),
          request.maxTokens,
          owner.takeAttachments,
        );
      } catch (error) {
        throw owner.lease.reclaimed ? new Error(MEMORY_RECLAIMED_TEXT) : error;
      }
    };
    if (request.terminate === true) return observe();
    return owner.observer.run(
      request.signal ?? new AbortController().signal,
      observe,
    );
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#close();
    return this.#closePromise;
  }

  getNativeSessions() {
    return this.#pool.getNativeSessions();
  }

  async getMemoryStatus(): Promise<{
    highWaterBytes: number;
    highWaterMib: number;
    rssBytes?: number | undefined;
    sampledAt?: string | undefined;
    status: "normal" | "elevated" | "exceeded" | "unsampled";
    hostPid?: number | undefined;
    idleRetentionHours: number;
  }> {
    const host = this.#host.identity;
    const highWaterBytes = this.#memoryHighWater;
    const highWaterMib = Math.round(highWaterBytes / (1024 * 1024));
    const idleRetentionHours = Math.round(
      this.#pool.retentionIdleMs / 3_600_000,
    );
    if (!host) {
      return {
        highWaterBytes,
        highWaterMib,
        status: "unsampled",
        idleRetentionHours,
      };
    }
    try {
      const bytes = await this.#readMemory(host);
      const lowWater = highWaterBytes * 0.75;
      let status: "normal" | "elevated" | "exceeded" = "normal";
      if (bytes > highWaterBytes) {
        status = "exceeded";
      } else if (bytes > lowWater) {
        status = "elevated";
      }
      return {
        highWaterBytes,
        highWaterMib,
        rssBytes: bytes,
        sampledAt: new Date().toISOString(),
        status,
        hostPid: host.pid,
        idleRetentionHours,
      };
    } catch {
      return {
        highWaterBytes,
        highWaterMib,
        status: "unsampled",
        hostPid: host.pid,
        idleRetentionHours,
      };
    }
  }

  /** Also callable by tests/embedding code; this is maintenance, not a model tool. */
  checkMemory(): Promise<void> {
    if (this.#stopping) return Promise.resolve();
    this.#memoryCheck ??= this.#checkMemory()
      .catch((error) => {
        if (!this.#memoryErrorReported) {
          this.#memoryErrorReported = true;
          try {
            this.#onMemoryError(
              error instanceof Error
                ? error
                : new Error("Code Mode 内存检查失败。"),
            );
          } catch {
            /* Observability is not execution control. */
          }
        }
      })
      .finally(() => {
        this.#memoryCheck = undefined;
      });
    return this.#memoryCheck;
  }

  async #checkMemory(): Promise<void> {
    this.#cleanupExpiredInvalidatedCells();
    if (this.#restarting) return;
    const host = this.#host.identity;
    if (!host) return;
    const generations = this.#pool.generation;
    const current = () => !this.#stopping && this.#host.identity === host;
    let bytes = await this.#readMemory(host);
    if (!current()) return;
    this.#memoryErrorReported = false;
    if (bytes <= this.#memoryHighWater) return;

    // Only this pass's old generations are candidates. A same-scope replacement
    // created while an old session closes cannot become its next victim.
    const lowWater = this.#memoryHighWater * 0.75;
    while (current() && bytes > lowWater) {
      let closing = this.#pool.reclaimOldest(true, generations);
      if (!closing) {
        // Below high water, never sacrifice an active session just to reach 75%.
        if (bytes <= this.#memoryHighWater) return;
        closing = this.#pool.reclaimOldest(false, generations);
      }
      if (!closing) {
        // Empty but resident allocator state can be released by replacing the host.
        // Live replacement generations are deliberately left to the next sample.
        if (this.#pool.size === 0 && current()) await this.#restartHost(host);
        return;
      }
      let timeout: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          closing,
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(
              () => reject(new Error("Code Mode 会话关闭超时。")),
              this.#memoryCloseTimeout,
            );
            timeout.unref();
          }),
        ]);
      } catch {
        // Native memory may already be freed while a cancelled external tool is
        // still unwinding. Don't reset healthy siblings just for slow cleanup.
        if (current()) {
          const remaining = await this.#readMemory(host);
          if (current() && remaining > this.#memoryHighWater)
            await this.#restartHost(host);
        }
        return;
      } finally {
        if (timeout) clearTimeout(timeout);
      }
      if (!current()) return;
      // Allow completed native cleanup to reach the OS before choosing another victim.
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (!current()) return;
      bytes = await this.#readMemory(host);
    }
  }

  async #readMemory(host: HostIdentity): Promise<number> {
    const bytes = await this.#memoryReader(host.pid);
    if (!Number.isSafeInteger(bytes) || bytes <= 0)
      throw new Error("Code Mode 内存采样无效；不据此回收会话。");
    return bytes;
  }

  #restartHost(host: HostIdentity): Promise<void> {
    if (this.#restarting) return this.#restarting;
    if (this.#stopping || this.#host.identity !== host)
      return Promise.resolve();
    this.#restarting = (async () => {
      this.#invalidateSessions("memory");
      await this.#host.stop();
      // The next exec lazily opens a new host. Stable metadata scopes are untouched.
    })().finally(() => {
      this.#restarting = undefined;
    });
    return this.#restarting;
  }

  async #close(): Promise<void> {
    this.#stopping = true;
    clearInterval(this.#memoryTimer);
    await this.#memoryCheck;
    await this.#restarting?.catch(() => undefined);
    this.#cellOwners.clear();
    this.#invalidatedCells.clear();
    await this.#pool.close();
    this.#resultPreparation.close();
    this.#admission.close();
    await this.#host.stop();
  }

  async #openSession(scope: string | undefined): Promise<CodeModeSession> {
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
      resultPreparation: this.#resultPreparation,
      ...(scope === undefined ? {} : { scope }),
      startupTimeoutMs: this.#startupTimeoutMs,
      transportTimeoutMs: this.#transportTimeoutMs,
    });
    if (this.#stopping) {
      await session.close();
      this.#requireRunning();
    }
    return session;
  }

  async #ownerForWait(
    cellId: string,
    requestedScope: string | undefined,
  ): Promise<CellOwner> {
    this.#cleanupExpiredInvalidatedCells();
    const owner = this.#cellOwners.get(cellId);
    if (owner !== undefined) {
      if (owner.scope !== undefined && owner.scope !== requestedScope) {
        throw new Error("exec cell 属于其他 ChatGPT 会话");
      }
      return owner;
    }
    const invalidated = this.#invalidatedCells.get(cellId);
    if (invalidated !== undefined) {
      assertMatchingScope(invalidated.scope, requestedScope);
      throw new Error(invalidated.message);
    }
    throw new Error(`未知或已结束的 exec cell：${cellId}`);
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
      const handle = publicCellId ?? randomHandle("cell");
      this.#cellOwners.set(handle, {
        observer:
          this.#cellOwners.get(handle)?.observer ?? new CancellableMutex(),
        hostCellId: outcome.cellId,
        ...(scope === undefined ? {} : { scope }),
        session,
        lease,
        ...(takeAttachments === undefined ? {} : { takeAttachments }),
      });
      return { ...outcome, cellId: handle };
    } else {
      if (publicCellId !== undefined) {
        this.#cellOwners.delete(publicCellId);
        this.#invalidatedCells.delete(publicCellId);
      }
      lease.release();
    }
    return publicCellId === undefined
      ? outcome
      : { ...outcome, cellId: publicCellId };
  }

  async #modelResult(
    outcome: RuntimeOutcome,
    wallTimeSeconds: number,
    maxTokens?: number,
    takeAttachments?: CodeModeExecRequest["takeAttachments"],
    notice?: string,
  ): Promise<CodeModeToolResult> {
    const attachments = takeAttachments?.() ?? [];
    const items: CodeModeOutputItem[] = [...outcome.items];
    if (outcome.state === "completed" && outcome.errorText !== undefined) {
      items.push({ type: "text", text: `Script error:\n${outcome.errorText}` });
    }
    try {
      const budgeted = applyOutputBudget(items, maxTokens);
      const status =
        statusHeader(outcome, wallTimeSeconds) +
        (notice ?? "") +
        (budgeted.truncated
          ? `文本已按 ${maxTokens} token 预算截断；后续 wait 不补发被省略内容。\n`
          : "");
      const result = outputItemsToCallToolResult(
        [{ type: "text", text: status }, ...budgeted.items],
        outcome.state === "completed" && outcome.errorText !== undefined,
      );
      result.content.push(...attachments);
      encodePayload(result);
      return result;
    } catch (error) {
      this.#discardUnrepresentableCell(outcome);
      return {
        content: [
          {
            type: "text",
            text: `结果不可交付；操作可能已生效，请勿自动重试。${error instanceof Error ? error.message : String(error)}`,
          },
          ...attachments,
        ],
        isError: true,
      };
    }
  }

  #discardUnrepresentableCell(outcome: RuntimeOutcome): void {
    if (outcome.state !== "yielded") return;
    const owner = this.#cellOwners.get(outcome.cellId);
    if (owner === undefined) return;
    this.#cellOwners.delete(outcome.cellId);
    void (async () => {
      try {
        await owner.session.terminate(owner.hostCellId);
      } catch {
        this.#invalidateSession(owner.session);
      } finally {
        owner.lease.release();
      }
    })().catch(() => undefined);
  }

  #invalidateSessions(reason: RetirementReason = "failure"): void {
    this.#cleanupExpiredInvalidatedCells();
    for (const [cellId, owner] of this.#cellOwners) {
      this.#recordInvalidatedCell(
        cellId,
        owner.scope,
        reason === "memory" ? MEMORY_RECLAIMED_TEXT : INDETERMINATE_CELL_TEXT,
      );
      owner.lease.release();
    }
    this.#cellOwners.clear();
    this.#pool.reset(reason);
  }

  #invalidateSession(session: CodeModeSession): void {
    this.#retireCells(session, INDETERMINATE_CELL_TEXT);
    this.#pool.invalidate(session);
  }

  #retireCells(session: CodeModeSession, message: string): void {
    for (const [cellId, owner] of this.#cellOwners) {
      if (owner.session !== session) continue;
      this.#recordInvalidatedCell(cellId, owner.scope, message);
      this.#cellOwners.delete(cellId);
      owner.lease.release();
    }
  }

  #recordInvalidatedCell(
    cellId: string,
    scope: string | undefined,
    message: string,
  ): void {
    if (this.#invalidatedCells.get(cellId)?.message === MEMORY_RECLAIMED_TEXT)
      return;
    while (this.#invalidatedCells.size >= MAX_INVALIDATED_CELLS)
      this.#invalidatedCells.delete(
        this.#invalidatedCells.keys().next().value!,
      );
    this.#invalidatedCells.set(cellId, {
      message,
      expiresAt: Date.now() + INVALIDATED_CELL_RETENTION_MS,
      ...(scope === undefined ? {} : { scope }),
    });
  }

  #cleanupExpiredInvalidatedCells(now = Date.now()): void {
    for (const [cellId, invalidated] of this.#invalidatedCells) {
      if (invalidated.expiresAt <= now) this.#invalidatedCells.delete(cellId);
    }
  }

  #requireRunning(): void {
    if (this.#stopping) throw new Error("Code Mode service is shutting down");
  }
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

function assertMatchingScope(
  ownerScope: string | undefined,
  requestedScope: string | undefined,
): void {
  if (ownerScope !== undefined && ownerScope !== requestedScope) {
    throw new Error("exec cell 属于其他 ChatGPT 会话");
  }
}

function throwIfAborted(
  signal: AbortSignal | undefined,
  message: string,
): void {
  if (signal?.aborted !== true) return;
  const error = new Error(message, { cause: signal.reason });
  error.name = "AbortError";
  throw error;
}

export function parseExecSource(input: string): ParsedExecSource {
  if (input.trim() === "") {
    throw new Error(
      'exec expects raw JavaScript source text; optionally prefix it with // @exec: {"yield_time_ms":10000}',
    );
  }
  const firstNewline = input.indexOf("\n");
  const firstLine = firstNewline < 0 ? input : input.slice(0, firstNewline);
  const trimmed = firstLine.trimStart();
  if (!trimmed.startsWith("// @exec:")) return { code: input };

  const code = firstNewline < 0 ? "" : input.slice(firstNewline + 1);
  if (code.trim() === "") {
    throw new Error(
      "exec pragma must be followed by JavaScript source on subsequent lines",
    );
  }
  const directive = trimmed.slice("// @exec:".length).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(directive) as unknown;
  } catch (error) {
    throw new Error(`exec pragma must be valid JSON: ${String(error)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("exec pragma must be a JSON object");
  }
  const object = parsed as Record<string, unknown>;
  for (const key of Object.keys(object)) {
    if (key !== "yield_time_ms" && key !== "max_output_tokens") {
      throw new Error(`exec pragma does not support field ${key}`);
    }
  }
  const yieldTimeMs = optionalNonNegativeSafeInteger(
    object.yield_time_ms,
    "yield_time_ms",
  );
  const maxOutputTokens = object.max_output_tokens;
  validateOutputBudget(maxOutputTokens);
  return {
    code,
    ...(yieldTimeMs === undefined ? {} : { yieldTimeMs }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
  };
}

function statusHeader(
  outcome: RuntimeOutcome,
  wallTimeSeconds: number,
): string {
  const status =
    outcome.state === "yielded"
      ? `Script running with cell ID ${outcome.cellId}`
      : outcome.state === "terminated"
        ? "Script terminated"
        : outcome.errorText === undefined
          ? "Script completed"
          : "Script failed";
  return `${status}\nWall time ${wallTimeSeconds.toFixed(1)} seconds\nOutput:\n`;
}

function elapsedSeconds(startedAt: number): number {
  return Math.round(((performance.now() - startedAt) / 1_000) * 10) / 10;
}

function optionalNonNegativeSafeInteger(
  value: unknown,
  name: string,
): number | undefined {
  if (value === undefined) return undefined;
  validateNonNegativeSafeInteger(value, name);
  return Number(value);
}

function validateNonNegativeSafeInteger(value: unknown, name: string): void {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
}

function validateYieldTime(
  value: unknown,
  name: string,
  maximum: number,
): void {
  validateNonNegativeSafeInteger(value, name);
  if (Number(value) > maximum) {
    throw new Error(`${name} must be at most ${maximum}`);
  }
}

export function sessionScopeKey(scope: string | undefined): string | undefined {
  if (scope === undefined || scope === "") return undefined;
  return crypto.createHash("sha256").update(scope, "utf8").digest("base64url");
}

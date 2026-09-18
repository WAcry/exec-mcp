import crypto from "node:crypto";
import { performance } from "node:perf_hooks";

import { CELL_HEAP_BYTES, encodePayload } from "../limits.js";
import { randomHandle } from "../util.js";
import { CancellableMutex, WeightedAdmissionQueue } from "./admission.js";
import { CodeModeHostProcess } from "./host-process.js";
import { outputItemsToCallToolResult } from "./result.js";
import { CodeModeSession, type RuntimeOutcome } from "./session.js";
import { SessionPool, type SessionLease } from "./session-pool.js";
import { ConversationStore, type StoreLease } from "./conversation-store.js";
import { collectStoreWrites, storeBridge } from "./store-bridge.js";
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
const MAX_INVALIDATED_CELLS = 1024;
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
  store?: StoreLease;
  takeAttachments?: CodeModeExecRequest["takeAttachments"];
}

interface InvalidatedCell {
  expiresAt: number;
  scope?: string;
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
  readonly #store: ConversationStore;
  readonly #maintenance: NodeJS.Timeout;
  #stopping = false;

  constructor(options: CodeModeServiceOptions = {}) {
    this.#defaultExecYieldTimeMs =
      options.defaultExecYieldTimeMs ?? DEFAULT_EXEC_YIELD_TIME_MS;
    this.#defaultWaitYieldTimeMs =
      options.defaultWaitYieldTimeMs ?? DEFAULT_WAIT_YIELD_TIME_MS;
    this.#maxHeapSizeBytes = options.maxHeapSizeBytes ?? CELL_HEAP_BYTES;
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

    this.#pool = new SessionPool(
      (scope) => this.#openSession(scope),
      options.maxCells,
    );
    this.#store = new ConversationStore({
      ...options.storeLimits,
      ...(options.sessionIdleMs === undefined
        ? {}
        : { idleMs: options.sessionIdleMs }),
    });
    this.#maintenance = setInterval(
      () => this.#cleanupExpiredInvalidatedCells(),
      60_000,
    );
    this.#maintenance.unref();
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
  }

  get resources() {
    return {
      active_cells: this.#pool.size,
      invalidated_cells: this.#invalidatedCells.size,
      store: this.#store.usage,
    };
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
    const scope = sessionScopeKey(request.sessionScope);
    const lease = await this.#pool.acquire(scope);
    const session = lease.session;
    let store: StoreLease | undefined;
    const startedAt = performance.now();
    try {
      this.#requireRunning();
      throwIfAborted(
        request.signal,
        "Code Mode execution was aborted before it started",
      );
      store = scope === undefined ? undefined : this.#store.begin(scope);
      const bridge =
        store === undefined
          ? undefined
          : storeBridge(store, this.#store.limits);
      const hostOutcome = await session.execute({
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        source: `${CODE_MODE_SOURCE_PRELUDE}${bridge?.source ?? UNSCOPED_STORE_PRELUDE}${parsed.code}`,
        toolCallId: randomHandle("exec"),
        tools:
          bridge === undefined
            ? request.tools
            : [bridge.tool, ...request.tools],
        yieldTimeMs,
      });
      const outcome = await this.#trackOutcome(
        lease,
        scope,
        hostOutcome,
        undefined,
        request.takeAttachments,
        store,
      );
      return await this.#modelResult(
        outcome,
        elapsedSeconds(startedAt),
        maxOutputTokens,
        request.takeAttachments,
      );
    } catch (error) {
      store?.release();
      lease.release();
      throw error;
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
      // Retire a cancelled observer before admitting the next one. Queue time
      // counts against this request's budget, not a second full wait window.
      await this.#ownerForWait(
        request.cellId,
        sessionScopeKey(request.sessionScope),
      );
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
      const outcome = await this.#trackOutcome(
        owner.lease,
        owner.scope,
        hostOutcome,
        request.cellId,
        owner.takeAttachments,
        owner.store,
      );
      return this.#modelResult(
        outcome,
        elapsedSeconds(startedAt),
        request.maxTokens,
        owner.takeAttachments,
      );
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

  async #close(): Promise<void> {
    this.#stopping = true;
    clearInterval(this.#maintenance);
    for (const owner of this.#cellOwners.values()) owner.store?.release();
    this.#cellOwners.clear();
    this.#invalidatedCells.clear();
    await this.#pool.close();
    this.#store.close();
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
      throw new Error(INDETERMINATE_CELL_TEXT);
    }
    throw new Error(`未知或已结束的 exec cell：${cellId}`);
  }

  async #trackOutcome(
    lease: SessionLease,
    scope: string | undefined,
    outcome: RuntimeOutcome,
    publicCellId?: string,
    takeAttachments?: CodeModeExecRequest["takeAttachments"],
    store?: StoreLease,
  ): Promise<RuntimeOutcome> {
    const session = lease.session;
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
        ...(store === undefined ? {} : { store }),
        ...(takeAttachments === undefined ? {} : { takeAttachments }),
      });
      return { ...outcome, cellId: handle };
    } else {
      if (publicCellId !== undefined) {
        this.#cellOwners.delete(publicCellId);
        this.#invalidatedCells.delete(publicCellId);
      }
      try {
        if (outcome.state === "completed" && store)
          store.commit(await collectStoreWrites(session));
      } catch (error) {
        outcome = {
          ...outcome,
          state: "completed",
          errorText: `${outcome.state === "completed" && outcome.errorText ? `${outcome.errorText}\n` : ""}store 提交失败：${error instanceof Error ? error.message : String(error)} 已有缓存保留；工具副作用不回滚，不要自动重跑脚本。`,
        };
      } finally {
        store?.release();
        lease.release();
      }
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
        owner.store?.release();
        owner.lease.release();
      }
    })().catch(() => undefined);
  }

  #invalidateSessions(): void {
    this.#cleanupExpiredInvalidatedCells();
    for (const [cellId, owner] of this.#cellOwners) {
      this.#recordInvalidatedCell(cellId, owner.scope);
      owner.store?.release();
      owner.lease.release();
    }
    this.#cellOwners.clear();
    this.#pool.reset();
  }

  #invalidateSession(session: CodeModeSession): void {
    for (const [cellId, owner] of this.#cellOwners) {
      if (owner.session !== session) continue;
      this.#recordInvalidatedCell(cellId, owner.scope);
      owner.store?.release();
      this.#cellOwners.delete(cellId);
      owner.lease.release();
    }
    this.#pool.invalidate(session);
  }

  #recordInvalidatedCell(cellId: string, scope: string | undefined): void {
    while (this.#invalidatedCells.size >= MAX_INVALIDATED_CELLS) {
      this.#invalidatedCells.delete(
        this.#invalidatedCells.keys().next().value!,
      );
    }
    this.#invalidatedCells.set(cellId, {
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

function sessionScopeKey(scope: string | undefined): string | undefined {
  if (scope === undefined || scope === "") return undefined;
  return crypto.createHash("sha256").update(scope, "utf8").digest("base64url");
}

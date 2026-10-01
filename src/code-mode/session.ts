import crypto from "node:crypto";

import type * as grpc from "@grpc/grpc-js";

import { errorMessage } from "../util.js";
import {
  CancellableMutex,
  nestedToolReservationBytes,
  WeightedAdmissionQueue,
} from "./admission.js";
import { prepareNestedToolResult } from "./result.js";
import {
  firstStreamMessage,
  grpcError,
  monitorStreamFailure,
  streamReady,
  type CodeModeHostClient,
  type ProtoMessage,
  unaryCall,
} from "./protocol.js";
import type { CodeModeToolDefinition } from "./types.js";
import {
  decodeOptionalJson,
  decodeOutcome,
  decodeToolName,
  decodeWaitResponse,
  encodeToolDefinition,
  numberField,
  optionalStringField,
  recordField,
  stringField,
  toolKey,
  toolMap,
  validateIdentifier,
  type RuntimeOutcome,
} from "./wire.js";

export type { RuntimeOutcome } from "./wire.js";

interface ExecutionState {
  /** Set by the caller's signal. New tool calls from this execution do not run. */
  cancelled?: boolean;
  cellId?: string;
  tools: Map<string, CodeModeToolDefinition>;
}

/** Cancellations that arrive before their tool call. The host normally sends the call soon after. */
const MAX_EARLY_CANCELLATIONS = 1024;

interface CellState {
  finalSequence?: number;
  highestSequence: number;
  pendingInvocations: Set<string>;
}

interface PendingInvocation {
  abort: AbortController;
  cellId: string;
}

export class CodeModeSession {
  readonly #admission: WeightedAdmissionQueue;
  readonly #client: CodeModeHostClient;
  readonly #eventStream: grpc.ClientReadableStream<ProtoMessage>;
  readonly #onFailure:
    | ((session: CodeModeSession, error: Error) => void)
    | undefined;
  readonly #scope: string | undefined;
  readonly #toolStream: grpc.ClientReadableStream<ProtoMessage>;
  readonly #transportTimeoutMs: number;
  readonly #resultPreparation: CancellableMutex;
  readonly id: string;
  #cells = new Map<string, CellState>();
  #cancelledInvocations = new Set<string>();
  #closed = false;
  #closePromise: Promise<void> | undefined;
  #earlyClosures = new Map<string, number>();
  #failure: Error | undefined;
  #executions = new Map<string, ExecutionState>();
  #pendingInvocations = new Map<string, PendingInvocation>();
  #toolTasks = new Set<Promise<void>>();
  #waits = new Set<string>();

  private constructor(options: {
    admission: WeightedAdmissionQueue;
    client: CodeModeHostClient;
    eventStream: grpc.ClientReadableStream<ProtoMessage>;
    id: string;
    onFailure?: (session: CodeModeSession, error: Error) => void;
    resultPreparation: CancellableMutex;
    scope?: string;
    toolStream: grpc.ClientReadableStream<ProtoMessage>;
    transportTimeoutMs: number;
  }) {
    this.#admission = options.admission;
    this.#client = options.client;
    this.#eventStream = options.eventStream;
    this.id = options.id;
    this.#onFailure = options.onFailure;
    this.#resultPreparation = options.resultPreparation;
    this.#scope = options.scope;
    this.#toolStream = options.toolStream;
    this.#transportTimeoutMs = options.transportTimeoutMs;
    this.#attachStreams();
    this.#eventStream.resume();
  }

  get usable(): boolean {
    return !this.#closed && this.#failure === undefined;
  }

  get activeCellCount(): number {
    return this.#cells.size;
  }

  get activeCellIds(): string[] {
    return [...this.#cells.keys()];
  }

  static async open(options: {
    admission?: WeightedAdmissionQueue;
    client: CodeModeHostClient;
    maxHeapSizeBytes?: number;
    maxYieldTimeMs?: number;
    onFailure?: (session: CodeModeSession, error: Error) => void;
    resultPreparation?: CancellableMutex;
    scope?: string;
    startupTimeoutMs: number;
    transportTimeoutMs: number;
  }): Promise<CodeModeSession> {
    const limits: ProtoMessage = {};
    if (options.maxHeapSizeBytes !== undefined) {
      limits.maxHeapSizeBytes = options.maxHeapSizeBytes;
    }
    if (options.maxYieldTimeMs !== undefined) {
      limits.maxYieldTimeMs = options.maxYieldTimeMs;
    }
    const request: ProtoMessage = {};
    if (Object.keys(limits).length > 0) request.cellExecutionLimits = limits;

    const eventStream = options.client.openSession(request);
    const eventMonitor = monitorStreamFailure(eventStream, "session lease");
    let id: string;
    try {
      const opened = await firstStreamMessage(
        eventStream,
        options.startupTimeoutMs,
        "session opening",
      );
      const openedPayload = recordField(
        opened,
        "opened",
        "session opening event",
      );
      id = stringField(openedPayload, "sessionId", "session ID");
      validateIdentifier(id, "session ID");
    } catch (error) {
      eventStream.cancel();
      throw error;
    }

    const toolStream = options.client.subscribeToToolCalls({
      sessionId: id,
      toolNames: [],
    });
    const toolMonitor = monitorStreamFailure(toolStream, "tool subscription");
    try {
      await streamReady(
        toolStream,
        options.startupTimeoutMs,
        "tool subscription",
      );
      eventMonitor.throwIfFailed();
      toolMonitor.throwIfFailed();
    } catch (error) {
      toolStream.cancel();
      eventStream.cancel();
      throw error;
    }

    const session = new CodeModeSession({
      admission: options.admission ?? new WeightedAdmissionQueue(),
      client: options.client,
      eventStream,
      id,
      ...(options.onFailure === undefined
        ? {}
        : { onFailure: options.onFailure }),
      resultPreparation: options.resultPreparation ?? new CancellableMutex(),
      ...(options.scope === undefined ? {} : { scope: options.scope }),
      toolStream,
      transportTimeoutMs: options.transportTimeoutMs,
    });
    eventMonitor.release();
    toolMonitor.release();
    return session;
  }

  async execute(options: {
    signal?: AbortSignal;
    source: string;
    toolCallId: string;
    tools: readonly CodeModeToolDefinition[];
    yieldTimeMs?: number;
  }): Promise<RuntimeOutcome> {
    if (options.signal?.aborted === true) throw executionAbortError();
    this.#requireOpen();
    const executionId = crypto.randomUUID();
    const state: ExecutionState = { tools: toolMap(options.tools) };
    const request: ProtoMessage = {
      sessionId: this.id,
      executionId,
      toolCallId: options.toolCallId,
      source: options.source,
      enabledTools: options.tools.map(encodeToolDefinition),
    };
    if (options.yieldTimeMs !== undefined)
      request.yieldTimeMs = options.yieldTimeMs;
    this.#executions.set(executionId, state);
    let stream: grpc.ClientReadableStream<ProtoMessage>;
    try {
      stream = this.#client.execute(request, {
        deadline:
          Date.now() +
          (options.yieldTimeMs ?? 10_000) +
          this.#transportTimeoutMs +
          1_000,
      });
    } catch (error) {
      this.#executions.delete(executionId);
      throw error;
    }
    try {
      return await this.#readExecutionStream(
        stream,
        executionId,
        state,
        options.signal,
      );
    } catch (error) {
      // A cancellation before the host reported the cell is cleaned up by the
      // stream reader once the cell ID arrives. It does not affect the session.
      if (state.cancelled === true && state.cellId === undefined) throw error;
      try {
        if (state.cellId !== undefined) await this.terminate(state.cellId);
        else
          this.#fail(
            new Error(
              "The execution stream failed before the host reported a cell ID. The session state is unknown.",
            ),
          );
      } catch {
        this.#fail(
          new Error(
            "Could not confirm that the failed cell was terminated. The session state is unknown.",
          ),
        );
      }
      this.#executions.delete(executionId);
      throw error;
    }
  }

  async wait(options: {
    cellId: string;
    signal?: AbortSignal;
    yieldTimeMs: number;
  }): Promise<RuntimeOutcome> {
    this.#requireOpen();
    if (this.#waits.has(options.cellId)) {
      throw new Error(
        `exec cell ${options.cellId} already has an active observer`,
      );
    }
    this.#waits.add(options.cellId);
    const waitId = crypto.randomUUID();
    try {
      const response = await unaryCall(
        (callOptions, callback) =>
          this.#client.wait(
            {
              sessionId: this.id,
              cellId: options.cellId,
              waitId,
              yieldTimeMs: options.yieldTimeMs,
            },
            callOptions,
            callback,
          ),
        options.yieldTimeMs + this.#transportTimeoutMs + 1_000,
        options.signal,
      );
      return decodeWaitResponse(response, options.cellId);
    } catch (error) {
      if (options.signal?.aborted === true) {
        await this.#cancelWait(waitId);
      }
      throw error;
    } finally {
      this.#waits.delete(options.cellId);
    }
  }

  async terminate(
    cellId: string,
    signal?: AbortSignal,
  ): Promise<RuntimeOutcome> {
    this.#requireOpen();
    const response = await unaryCall(
      (options, callback) =>
        this.#client.terminate(
          { sessionId: this.id, cellId },
          options,
          callback,
        ),
      this.#transportTimeoutMs,
      signal,
    );
    return decodeWaitResponse(response, cellId);
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#close();
    return this.#closePromise;
  }

  async #close(): Promise<void> {
    this.#closed = true;
    for (const invocation of this.#pendingInvocations.values())
      invocation.abort.abort();
    try {
      await unaryCall(
        (options, callback) =>
          this.#client.closeSession({ sessionId: this.id }, options, callback),
        this.#transportTimeoutMs,
      );
    } catch {
      // Stream cancellation still releases the lease if graceful close raced host exit.
    } finally {
      this.#eventStream.cancel();
      this.#toolStream.cancel();
      this.#cells.clear();
      this.#cancelledInvocations.clear();
      this.#earlyClosures.clear();
      this.#executions.clear();
    }
    while (this.#toolTasks.size > 0) {
      await Promise.allSettled([...this.#toolTasks]);
    }
    this.#pendingInvocations.clear();
  }

  #attachStreams(): void {
    this.#eventStream.on("data", (event: ProtoMessage) =>
      this.#handleSessionEvent(event),
    );
    this.#eventStream.on("error", (error: Error) =>
      this.#fail(grpcError(error, "session lease")),
    );
    this.#eventStream.on("end", () =>
      this.#fail(
        new Error("Code Mode session lease stream ended unexpectedly"),
      ),
    );
    this.#toolStream.on("data", (call: ProtoMessage) =>
      this.#handleToolCall(call),
    );
    this.#toolStream.on("error", (error: Error) =>
      this.#fail(grpcError(error, "tool subscription")),
    );
    this.#toolStream.on("end", () =>
      this.#fail(
        new Error("Code Mode tool subscription stream ended unexpectedly"),
      ),
    );
  }

  #readExecutionStream(
    stream: grpc.ClientReadableStream<ProtoMessage>,
    expectedExecutionId: string,
    state: ExecutionState,
    signal?: AbortSignal,
  ): Promise<RuntimeOutcome> {
    return new Promise((resolve, reject) => {
      monitorStreamFailure(stream, "execution");
      const session = this;
      let cellId: string | undefined;
      let settled = false;
      // Set when the caller cancelled before the host reported the cell.
      let startTimer: NodeJS.Timeout | undefined;
      const detach = (): void => {
        if (startTimer !== undefined) clearTimeout(startTimer);
        signal?.removeEventListener("abort", abort);
        stream.removeListener("data", onData);
        stream.removeListener("error", onError);
        stream.removeListener("end", onEnd);
      };
      const finish = (error?: Error, outcome?: RuntimeOutcome): void => {
        if (settled) return;
        settled = true;
        detach();
        if (error !== undefined) reject(error);
        else resolve(outcome!);
      };
      /** After an early cancellation, the stream is read only to find and stop the cell. */
      const failPendingStart = (error: Error): void => {
        detach();
        stream.cancel();
        session.#executions.delete(expectedExecutionId);
        session.#fail(error);
      };
      const abort = (): void => {
        state.cancelled = true;
        if (state.cellId !== undefined) {
          finish(executionAbortError());
          stream.cancel();
          return;
        }
        // Return the cancellation now, but keep reading until the host reports
        // the cell ID, then terminate that cell. Only a missing report is unknown.
        settled = true;
        signal?.removeEventListener("abort", abort);
        reject(executionAbortError());
        startTimer = setTimeout(
          () =>
            failPendingStart(
              new Error(
                "The host did not report the cell of a cancelled exec. The session state is unknown.",
              ),
            ),
          session.#transportTimeoutMs,
        );
        startTimer.unref();
      };

      if (signal?.aborted === true) {
        abort();
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });
      function onData(event: ProtoMessage): void {
        try {
          if (event.event === "started") {
            if (cellId !== undefined)
              throw new Error("host repeated the execution start event");
            const started = recordField(
              event,
              "started",
              "execution start event",
            );
            const executionId = stringField(
              started,
              "executionId",
              "execution ID",
            );
            if (executionId !== expectedExecutionId) {
              throw new Error(
                `host returned execution ${executionId} instead of ${expectedExecutionId}`,
              );
            }
            cellId = stringField(started, "cellId", "cell ID");
            validateIdentifier(cellId, "cell ID");
            state.cellId = cellId;
            const cell = session.#cellState(cellId);
            session.#maybeRetireCell(cellId, cell);
            if (settled && state.cancelled === true) {
              detach();
              stream.cancel();
              session.#terminateCancelledCell(expectedExecutionId, cellId);
            }
            return;
          }

          if (event.event !== "outcome" || cellId === undefined) {
            throw new Error("host returned an unexpected execution event");
          }
          const outcome = decodeOutcome(
            recordField(event, "outcome", "execution outcome"),
          );
          if (outcome.cellId !== cellId) {
            throw new Error(
              `host returned cell ${outcome.cellId} instead of ${cellId}`,
            );
          }
          finish(undefined, outcome);
        } catch (error) {
          const failure =
            error instanceof Error ? error : new Error(String(error));
          if (settled) failPendingStart(failure);
          else finish(failure);
        }
      }
      function onError(error: Error): void {
        if (settled) failPendingStart(grpcError(error, "execution"));
        else finish(grpcError(error, "execution"));
      }
      function onEnd(): void {
        const error = new Error(
          "host ended execution before returning an outcome",
        );
        if (settled) failPendingStart(error);
        else finish(error);
      }
      stream.on("data", onData);
      stream.on("error", onError);
      stream.on("end", onEnd);
    });
  }

  /** Stops a cell whose exec was cancelled before the host reported it. */
  #terminateCancelledCell(executionId: string, cellId: string): void {
    void this.terminate(cellId)
      .catch(() => {
        this.#fail(
          new Error(
            "Could not confirm that a cancelled cell was terminated. The session state is unknown.",
          ),
        );
      })
      .finally(() => this.#executions.delete(executionId));
  }

  /** Returns the cell's state, creating it and applying an early closure if needed. */
  #cellState(cellId: string): CellState {
    let cell = this.#cells.get(cellId);
    if (cell !== undefined) return cell;
    const finalSequence = this.#earlyClosures.get(cellId);
    cell = {
      highestSequence: 0,
      pendingInvocations: new Set(),
      ...(finalSequence === undefined ? {} : { finalSequence }),
    };
    this.#earlyClosures.delete(cellId);
    this.#cells.set(cellId, cell);
    return cell;
  }

  #handleSessionEvent(event: ProtoMessage): void {
    try {
      if (event.event === "toolCallCancelled") {
        const cancelled = recordField(
          event,
          "toolCallCancelled",
          "tool cancellation",
        );
        const invocationId = stringField(
          cancelled,
          "invocationId",
          "invocation ID",
        );
        const pending = this.#pendingInvocations.get(invocationId);
        if (pending !== undefined) {
          pending.abort.abort();
          return;
        }
        if (this.#cancelledInvocations.size >= MAX_EARLY_CANCELLATIONS) {
          const oldest = this.#cancelledInvocations.values().next().value;
          if (oldest !== undefined) this.#cancelledInvocations.delete(oldest);
        }
        this.#cancelledInvocations.add(invocationId);
        return;
      }
      if (event.event === "notification") {
        const notification = recordField(event, "notification", "notification");
        const notificationId = stringField(
          notification,
          "notificationId",
          "notification ID",
        );
        void unaryCall(
          (options, callback) =>
            this.#client.acknowledgeNotification(
              { sessionId: this.id, notificationId },
              options,
              callback,
            ),
          this.#transportTimeoutMs,
        ).catch((error: unknown) =>
          this.#fail(grpcError(error, "notification ACK")),
        );
        return;
      }
      if (event.event === "notificationCancelled") return;
      if (event.event === "cellClosed") {
        const closed = recordField(event, "cellClosed", "cell closure");
        const cellId = stringField(closed, "cellId", "cell ID");
        const finalSequence =
          closed.finalToolCallSequence === undefined
            ? 0
            : numberField(
                closed,
                "finalToolCallSequence",
                "final tool-call sequence",
              );
        const cell = this.#cells.get(cellId);
        if (cell === undefined) {
          // The start event uses another stream and can arrive later. Keep the
          // closure only while its execution is still known to this session.
          const executionId = optionalStringField(
            closed,
            "executionId",
            "execution ID",
          );
          if (executionId !== undefined && this.#executions.has(executionId))
            this.#earlyClosures.set(cellId, finalSequence);
          return;
        }
        cell.finalSequence = finalSequence;
        this.#maybeRetireCell(cellId, cell);
        return;
      }
      if (event.event === "opened") {
        throw new Error("host repeated the session opening event");
      }
      throw new Error("host returned an empty session event");
    } catch (error) {
      this.#fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  #handleToolCall(call: ProtoMessage): void {
    let task!: Promise<void>;
    task = this.#dispatchToolCall(call)
      .catch((error: unknown) => {
        this.#fail(error instanceof Error ? error : new Error(String(error)));
      })
      .finally(() => {
        this.#toolTasks.delete(task);
      });
    this.#toolTasks.add(task);
  }

  async #dispatchToolCall(call: ProtoMessage): Promise<void> {
    this.#requireOpen();
    const sessionId = stringField(call, "sessionId", "session ID");
    if (sessionId !== this.id)
      throw new Error("host routed a tool call to the wrong session");

    const executionId = stringField(call, "executionId", "execution ID");
    const cellId = stringField(call, "cellId", "cell ID");
    const invocationId = stringField(call, "invocationId", "invocation ID");
    const runtimeToolCallId = stringField(
      call,
      "runtimeToolCallId",
      "runtime tool-call ID",
    );
    const sequence = numberField(call, "sequence", "tool-call sequence");
    const wireToolName = recordField(call, "toolName", "tool name");
    const toolName = decodeToolName(wireToolName);
    const execution = this.#executions.get(executionId);
    if (execution !== undefined) execution.cellId ??= cellId;
    const cell = this.#cellState(cellId);
    if (sequence <= cell.highestSequence) {
      throw new Error(
        `host reused tool-call sequence ${sequence} for cell ${cellId}`,
      );
    }
    cell.highestSequence = sequence;

    if (this.#cancelledInvocations.delete(invocationId)) {
      this.#maybeRetireCell(cellId, cell);
      return;
    }

    if (execution?.cancelled === true) {
      await this.#completeToolCall(invocationId, {
        failed: {
          message:
            "The exec request was cancelled, so this tool call did not run.",
        },
      });
      this.#maybeRetireCell(cellId, cell);
      return;
    }
    const tool = execution?.tools.get(toolKey(toolName));
    if (tool === undefined) {
      await this.#completeToolCall(invocationId, {
        failed: { message: `unknown or disabled tool ${toolKey(toolName)}` },
      });
      this.#maybeRetireCell(cellId, cell);
      return;
    }
    cell.pendingInvocations.add(invocationId);

    const abort = new AbortController();
    this.#pendingInvocations.set(invocationId, { abort, cellId });
    let releaseAdmission: (() => void) | undefined;
    try {
      let outputJson: Buffer;
      try {
        releaseAdmission = await this.#admission.acquire(
          nestedToolReservationBytes(toolName),
          abort.signal,
        );
        if (abort.signal.aborted) return;
        const input = decodeOptionalJson(call.inputJson, "nested tool input");
        const value = await tool.call(input, {
          cellId,
          invocationId,
          runtimeToolCallId,
          ...(this.#scope === undefined ? {} : { sessionScope: this.#scope }),
          signal: abort.signal,
          toolName,
        });
        if (abort.signal.aborted) return;
        outputJson = await this.#resultPreparation.run(
          abort.signal,
          async () => {
            if (abort.signal.aborted) throw executionAbortError();
            return prepareNestedToolResult(value);
          },
        );
      } catch (error) {
        if (!abort.signal.aborted) {
          await this.#completeToolCall(
            invocationId,
            { failed: { message: errorMessage(error) } },
            abort.signal,
          );
        }
        return;
      }
      if (abort.signal.aborted) return;

      // A completion transport error is ambiguous. Do not send a second,
      // contradictory completion for a tool that may already have succeeded.
      await this.#completeToolCall(
        invocationId,
        { succeeded: { outputJson } },
        abort.signal,
      );
    } finally {
      releaseAdmission?.();
      this.#pendingInvocations.delete(invocationId);
      cell.pendingInvocations.delete(invocationId);
      this.#maybeRetireCell(cellId, cell);
    }
  }

  /**
   * Sends one completion. When the signal aborts, the host has cancelled the
   * invocation or the session is closing; the host no longer needs this result,
   * so the rejected call counts as a cancellation and does not fail the session.
   */
  async #completeToolCall(
    invocationId: string,
    result: ProtoMessage,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      await unaryCall(
        (options, callback) =>
          this.#client.completeToolCall(
            { sessionId: this.id, invocationId, ...result },
            options,
            callback,
          ),
        this.#transportTimeoutMs,
        signal,
      );
    } catch (error) {
      if (signal?.aborted === true) return;
      throw error;
    }
  }

  async #cancelWait(waitId: string): Promise<void> {
    try {
      await unaryCall(
        (options, callback) =>
          this.#client.cancelWait(
            { sessionId: this.id, waitId },
            options,
            callback,
          ),
        this.#transportTimeoutMs,
      );
    } catch (error) {
      this.#fail(grpcError(error, "wait cancellation"));
    }
  }

  #maybeRetireCell(cellId: string, cell: CellState): void {
    if (
      cell.finalSequence === undefined ||
      cell.highestSequence < cell.finalSequence ||
      cell.pendingInvocations.size > 0
    ) {
      return;
    }
    this.#cells.delete(cellId);
    for (const [executionId, execution] of this.#executions) {
      if (execution.cellId === cellId) this.#executions.delete(executionId);
    }
  }

  #requireOpen(): void {
    if (this.#failure !== undefined) throw this.#failure;
    if (this.#closed) throw new Error("Code Mode session is closed");
  }

  #fail(error: Error): void {
    if (this.#closed || this.#failure !== undefined) return;
    this.#failure = error;
    for (const invocation of this.#pendingInvocations.values())
      invocation.abort.abort();
    this.#eventStream.cancel();
    this.#toolStream.cancel();
    try {
      this.#onFailure?.(this, error);
    } catch {
      // Session cleanup must not replace the transport failure.
    }
  }
}

function executionAbortError(): Error {
  const error = new Error("Code Mode execution was aborted");
  error.name = "AbortError";
  return error;
}

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
  grpcError,
  type CodeModeHostClient,
  type ProtoMessage,
  unaryCall,
} from "./protocol.js";
import type {
  CodeModeOutputItem,
  CodeModeToolDefinition,
  CodeModeToolName,
} from "./types.js";

const MAX_IDENTIFIER_BYTES = 256;

export type RuntimeOutcome =
  | { cellId: string; items: CodeModeOutputItem[]; state: "yielded" }
  | { cellId: string; items: CodeModeOutputItem[]; state: "terminated" }
  | {
      cellId: string;
      errorText?: string;
      items: CodeModeOutputItem[];
      state: "completed";
    };

interface ExecutionState {
  cellId?: string;
  tools: Map<string, CodeModeToolDefinition>;
}

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
    let dispatched = false;
    try {
      const state: ExecutionState = { tools: toolMap(options.tools) };
      this.#executions.set(executionId, state);

      const request: ProtoMessage = {
        sessionId: this.id,
        executionId,
        toolCallId: options.toolCallId,
        source: options.source,
        enabledTools: options.tools.map(encodeToolDefinition),
      };
      if (options.yieldTimeMs !== undefined)
        request.yieldTimeMs = options.yieldTimeMs;
      const stream = this.#client.execute(request, {
        deadline:
          Date.now() +
          (options.yieldTimeMs ?? 10_000) +
          this.#transportTimeoutMs +
          1_000,
      });
      dispatched = true;
      return await this.#readExecutionStream(
        stream,
        executionId,
        options.signal,
      );
    } catch (error) {
      const cellId = this.#executions.get(executionId)?.cellId;
      if (!dispatched) {
        this.#executions.delete(executionId);
        throw error;
      }
      try {
        if (cellId !== undefined) await this.terminate(cellId);
        else
          this.#fail(
            new Error("执行连接中断且未取得 cell ID；会话结果不确定。"),
          );
      } catch {
        this.#fail(new Error("无法确认失败 cell 的终止；会话结果不确定。"));
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

  async #readExecutionStream(
    stream: grpc.ClientReadableStream<ProtoMessage>,
    expectedExecutionId: string,
    signal?: AbortSignal,
  ): Promise<RuntimeOutcome> {
    return new Promise((resolve, reject) => {
      monitorStreamFailure(stream, "execution");
      const session = this;
      let cellId: string | undefined;
      let settled = false;
      const finish = (error?: Error, outcome?: RuntimeOutcome): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", abort);
        stream.removeListener("data", onData);
        stream.removeListener("error", onError);
        stream.removeListener("end", onEnd);
        if (error !== undefined) reject(error);
        else resolve(outcome!);
      };
      const abort = (): void => {
        const error = executionAbortError();
        finish(error);
        stream.cancel();
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
            const execution = session.#executions.get(expectedExecutionId);
            if (execution === undefined)
              throw new Error("execution state is missing");
            execution.cellId = cellId;
            const cell = session.#cells.get(cellId) ?? {
              highestSequence: 0,
              pendingInvocations: new Set(),
              ...(session.#earlyClosures.has(cellId)
                ? { finalSequence: session.#earlyClosures.get(cellId)! }
                : {}),
            };
            session.#earlyClosures.delete(cellId);
            session.#cells.set(cellId, cell);
            session.#maybeRetireCell(cellId, cell);
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
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      }
      function onError(error: Error): void {
        finish(grpcError(error, "execution"));
      }
      function onEnd(): void {
        if (!settled)
          finish(new Error("host ended execution before returning an outcome"));
      }
      stream.on("data", onData);
      stream.on("error", onError);
      stream.on("end", onEnd);
    });
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
        if (pending === undefined) this.#cancelledInvocations.add(invocationId);
        else pending.abort.abort();
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
    let cell = this.#cells.get(cellId);
    if (cell === undefined) {
      cell = {
        highestSequence: 0,
        pendingInvocations: new Set(),
        ...(this.#earlyClosures.has(cellId)
          ? { finalSequence: this.#earlyClosures.get(cellId)! }
          : {}),
      };
      this.#earlyClosures.delete(cellId);
      this.#cells.set(cellId, cell);
      if (execution !== undefined) execution.cellId = cellId;
    }
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

    const tool = execution?.tools.get(toolKey(toolName));
    if (tool === undefined) {
      await this.#completeToolFailure(
        invocationId,
        `unknown or disabled tool ${toolKey(toolName)}`,
      );
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
          await this.#completeToolFailure(invocationId, errorMessage(error));
        }
        return;
      }
      if (abort.signal.aborted) return;

      // A completion transport error is ambiguous. Do not send a second,
      // contradictory completion for a tool that may already have succeeded.
      await unaryCall(
        (options, callback) =>
          this.#client.completeToolCall(
            {
              sessionId: this.id,
              invocationId,
              succeeded: { outputJson },
            },
            options,
            callback,
          ),
        this.#transportTimeoutMs,
        abort.signal,
      );
    } finally {
      releaseAdmission?.();
      this.#pendingInvocations.delete(invocationId);
      cell.pendingInvocations.delete(invocationId);
      this.#maybeRetireCell(cellId, cell);
    }
  }

  async #completeToolFailure(
    invocationId: string,
    message: string,
  ): Promise<void> {
    await unaryCall(
      (options, callback) =>
        this.#client.completeToolCall(
          {
            sessionId: this.id,
            invocationId,
            failed: { message },
          },
          options,
          callback,
        ),
      this.#transportTimeoutMs,
    );
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

function toolMap(
  tools: readonly CodeModeToolDefinition[],
): Map<string, CodeModeToolDefinition> {
  const result = new Map<string, CodeModeToolDefinition>();
  for (const tool of tools) {
    const name = tool.toolName ?? { name: tool.name };
    const key = toolKey(name);
    if (result.has(key))
      throw new Error(`duplicate Code Mode tool route ${key}`);
    result.set(key, tool);
  }
  return result;
}

function encodeToolDefinition(tool: CodeModeToolDefinition): ProtoMessage {
  const toolName = tool.toolName ?? { name: tool.name };
  const result: ProtoMessage = {
    name: tool.name,
    toolName: {
      name: toolName.name,
      ...(toolName.namespace === undefined
        ? {}
        : { namespace: toolName.namespace }),
    },
    description: tool.description,
    kind:
      tool.kind === "freeform" ? "TOOL_KIND_FREEFORM" : "TOOL_KIND_FUNCTION",
  };
  if (tool.inputSchema !== undefined) {
    result.inputSchemaJson = Buffer.from(
      JSON.stringify(tool.inputSchema),
      "utf8",
    );
  }
  if (tool.outputSchema !== undefined) {
    result.outputSchemaJson = Buffer.from(
      JSON.stringify(tool.outputSchema),
      "utf8",
    );
  }
  return result;
}

function decodeWaitResponse(
  response: ProtoMessage,
  expectedCellId: string,
): RuntimeOutcome {
  const state = response.state;
  if (state !== "liveCell" && state !== "missingCell") {
    throw new Error("host returned an empty wait response");
  }
  const outcome = decodeOutcome(recordField(response, state, "wait outcome"));
  if (outcome.cellId !== expectedCellId) {
    throw new Error(
      `host returned cell ${outcome.cellId} instead of ${expectedCellId}`,
    );
  }
  return outcome;
}

function decodeOutcome(value: ProtoMessage): RuntimeOutcome {
  const cellId = stringField(value, "cellId", "cell ID");
  const rawItems = value.contentItems;
  if (rawItems !== undefined && !Array.isArray(rawItems)) {
    throw new Error("host returned invalid content items");
  }
  const items = (rawItems ?? []).map((item) =>
    decodeOutputItem(asRecord(item, "content item")),
  );
  if (value.outcome === "yielded") return { cellId, items, state: "yielded" };
  if (value.outcome === "terminated")
    return { cellId, items, state: "terminated" };
  if (value.outcome === "completed") {
    const completed = recordField(value, "completed", "completed outcome");
    const errorText = optionalStringField(
      completed,
      "errorText",
      "script error",
    );
    return {
      cellId,
      ...(errorText === undefined ? {} : { errorText }),
      items,
      state: "completed",
    };
  }
  throw new Error("host returned an execution without an outcome");
}

function decodeOutputItem(value: ProtoMessage): CodeModeOutputItem {
  if (value.item === "text") {
    return {
      type: "text",
      text: stringField(
        recordField(value, "text", "text content"),
        "text",
        "text",
      ),
    };
  }
  if (value.item === "image") {
    const image = recordField(value, "image", "image content");
    const detail = decodeImageDetail(image.detail);
    return {
      type: "image",
      imageUrl: stringField(image, "imageUrl", "image URL"),
      ...(detail === undefined ? {} : { detail }),
    };
  }
  if (value.item === "audio") {
    return {
      type: "audio",
      audioUrl: stringField(
        recordField(value, "audio", "audio content"),
        "audioUrl",
        "audio URL",
      ),
    };
  }
  throw new Error("host returned an empty content item");
}

function decodeImageDetail(
  value: unknown,
): "auto" | "low" | "high" | "original" | undefined {
  switch (value) {
    case undefined:
      return undefined;
    case "IMAGE_DETAIL_AUTO":
      return "auto";
    case "IMAGE_DETAIL_LOW":
      return "low";
    case "IMAGE_DETAIL_HIGH":
      return "high";
    case "IMAGE_DETAIL_ORIGINAL":
      return "original";
    default:
      throw new Error(`host returned invalid image detail ${String(value)}`);
  }
}

function decodeToolName(value: ProtoMessage): CodeModeToolName {
  const name = stringField(value, "name", "tool name");
  const namespace = optionalStringField(value, "namespace", "tool namespace");
  return { name, ...(namespace === undefined ? {} : { namespace }) };
}

function decodeOptionalJson(value: unknown, field: string): unknown {
  if (value === undefined) return undefined;
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    throw new Error(`host returned invalid ${field}`);
  }
  try {
    return JSON.parse(Buffer.from(value).toString("utf8")) as unknown;
  } catch (error) {
    throw new Error(`host returned invalid ${field}: ${errorMessage(error)}`);
  }
}

interface StreamFailureMonitor {
  release(): void;
  throwIfFailed(): void;
}

/**
 * Keeps a readable gRPC stream's error event handled across async handoffs.
 * grpc-js emits a non-OK error immediately before terminal status, including
 * after cancel() has already settled the operation that owned the stream.
 */
function monitorStreamFailure(
  stream: grpc.ClientReadableStream<ProtoMessage>,
  operation: string,
): StreamFailureMonitor {
  let failure: Error | undefined;
  let released = false;
  const onError = (error: Error): void => {
    failure ??= grpcError(error, operation);
  };
  const onEnd = (): void => {
    failure ??= new Error(`Code Mode ${operation} stream ended unexpectedly`);
  };
  const onStatus = (): void => release();
  const release = (): void => {
    if (released) return;
    released = true;
    stream.removeListener("error", onError);
    stream.removeListener("end", onEnd);
    stream.removeListener("status", onStatus);
  };

  stream.on("error", onError);
  stream.on("end", onEnd);
  stream.once("status", onStatus);
  return {
    release,
    throwIfFailed(): void {
      if (failure !== undefined) throw failure;
    },
  };
}

function firstStreamMessage(
  stream: grpc.ClientReadableStream<ProtoMessage>,
  timeoutMs: number,
  operation: string,
): Promise<ProtoMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      stream.cancel();
      reject(new Error(`Code Mode ${operation} timed out`));
    }, timeoutMs);
    const onData = (message: ProtoMessage): void => {
      cleanup();
      stream.pause();
      resolve(message);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(grpcError(error, operation));
    };
    const onEnd = (): void => {
      cleanup();
      reject(new Error(`Code Mode ${operation} stream ended early`));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      stream.removeListener("data", onData);
      stream.removeListener("error", onError);
      stream.removeListener("end", onEnd);
    };
    stream.once("data", onData);
    stream.once("error", onError);
    stream.once("end", onEnd);
  });
}

function streamReady(
  stream: grpc.ClientReadableStream<ProtoMessage>,
  timeoutMs: number,
  operation: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => finish(new Error(`Code Mode ${operation} timed out`)),
      timeoutMs,
    );
    const finish = (error?: Error): void => {
      clearTimeout(timer);
      stream.removeListener("metadata", onMetadata);
      stream.removeListener("error", onError);
      stream.removeListener("end", onEnd);
      if (error === undefined) resolve();
      else reject(error);
    };
    const onMetadata = (): void => finish();
    const onError = (error: Error): void => finish(grpcError(error, operation));
    const onEnd = (): void =>
      finish(new Error(`Code Mode ${operation} stream ended early`));
    stream.once("metadata", onMetadata);
    stream.once("error", onError);
    stream.once("end", onEnd);
  });
}

function executionAbortError(): Error {
  const error = new Error("Code Mode execution was aborted");
  error.name = "AbortError";
  return error;
}

function toolKey(name: CodeModeToolName): string {
  return name.namespace === undefined
    ? name.name
    : `${name.namespace}/${name.name}`;
}

function validateIdentifier(value: string, field: string): void {
  if (value === "") throw new Error(`host returned an empty ${field}`);
  if (Buffer.byteLength(value, "utf8") > MAX_IDENTIFIER_BYTES) {
    throw new Error(
      `host returned ${field} exceeding ${MAX_IDENTIFIER_BYTES} bytes`,
    );
  }
}

function recordField(
  value: ProtoMessage,
  key: string,
  field: string,
): ProtoMessage {
  return asRecord(value[key], field);
}

function asRecord(value: unknown, field: string): ProtoMessage {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`host returned invalid ${field}`);
  }
  return value as ProtoMessage;
}

function stringField(value: ProtoMessage, key: string, field: string): string {
  const result = value[key];
  if (typeof result !== "string")
    throw new Error(`host returned invalid ${field}`);
  return result;
}

function optionalStringField(
  value: ProtoMessage,
  key: string,
  field: string,
): string | undefined {
  const result = value[key];
  if (result === undefined) return undefined;
  if (typeof result !== "string")
    throw new Error(`host returned invalid ${field}`);
  return result;
}

function numberField(value: ProtoMessage, key: string, field: string): number {
  const result = value[key];
  if (!Number.isSafeInteger(result) || Number(result) < 0) {
    throw new Error(`host returned invalid ${field}`);
  }
  return Number(result);
}

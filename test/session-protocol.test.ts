import { PassThrough } from "node:stream";
import * as grpc from "@grpc/grpc-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodeModeHostProcess } from "../src/code-mode/host-process.js";
import { CodeModeSession } from "../src/code-mode/session.js";
import {
  NATIVE_OUTPUT_LIMITS,
  NATIVE_OUTPUT_MAX_TOKENS,
} from "../src/code-mode/native-output.js";
import type {
  CodeModeHostClient,
  ProtoMessage,
} from "../src/code-mode/protocol.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

async function open(configure?: (client: CodeModeHostClient) => void) {
  const host = new CodeModeHostProcess({
    startupTimeoutMs: 10_000,
    onUnexpectedExit() {},
  });
  cleanup.push(() => host.stop());
  const client = await host.start();
  configure?.(client);
  const onFailure = vi.fn();
  const session = await CodeModeSession.open({
    client,
    onFailure,
    startupTimeoutMs: 10_000,
    transportTimeoutMs: 10_000,
  });
  cleanup.push(() => session.close());
  return { client, session, onFailure };
}

function notFound(): grpc.ServiceError {
  return Object.assign(
    new Error("5 NOT_FOUND: no such session or invocation"),
    {
      code: grpc.status.NOT_FOUND,
      details: "no such session or invocation",
      metadata: new grpc.Metadata(),
    },
  );
}

describe("Code Mode output ownership negotiation", () => {
  it("requires the official bounded collector and supplies an internal budget on every observation", async () => {
    let opened: ProtoMessage | undefined;
    const { client, session } = await open((client) => {
      const invoke = client.openSession.bind(client);
      vi.spyOn(client, "openSession").mockImplementation((request) => {
        const stream = invoke(request);
        stream.once("data", (message: ProtoMessage) => {
          opened = message.opened as ProtoMessage;
        });
        return stream;
      });
    });
    expect(client.openSession).toHaveBeenCalledWith({
      outputTruncation: "OUTPUT_TRUNCATION_SERVER",
    });
    expect(opened?.outputTruncation).toBe("OUTPUT_TRUNCATION_SERVER");
    const execute = vi.spyOn(client, "execute");
    const wait = vi.spyOn(client, "wait");
    const terminate = vi.spyOn(client, "terminate");
    expect(
      await session.execute({
        source: 'text("ready");',
        toolCallId: "negotiated",
        tools: [],
      }),
    ).toMatchObject({
      state: "completed",
      items: [{ type: "text", text: "ready" }],
    });
    const running = await session.execute({
      source: "yield_control(); await new Promise(() => {});",
      toolCallId: "observe",
      tools: [],
    });
    await session.wait({ cellId: running.cellId, yieldTimeMs: 0 });
    await session.terminate(running.cellId);
    for (const call of [execute, wait, terminate]) {
      expect(call).toHaveBeenCalled();
      for (const [request] of call.mock.calls)
        expect(request.maxOutputTokens).toBe(NATIVE_OUTPUT_MAX_TOKENS);
    }
    expect(execute.mock.calls[0]![0].yieldTimeMs).toBe(30_000);
  });

  it.each([
    undefined,
    "OUTPUT_TRUNCATION_CLIENT",
    "OUTPUT_TRUNCATION_UNSPECIFIED",
    42,
  ])("cancels an incompatible session lease (%s)", async (mode) => {
    let cancel: unknown;
    let subscribe: unknown;
    await expect(
      open((client) => {
        subscribe = vi.spyOn(client, "subscribeToToolCalls");
        const invoke = client.openSession.bind(client);
        vi.spyOn(client, "openSession").mockImplementation((request) => {
          const stream = invoke(request);
          cancel = vi.spyOn(stream, "cancel");
          stream.once("data", (message: ProtoMessage) => {
            (message.opened as ProtoMessage).outputTruncation = mode;
          });
          return stream;
        });
      }),
    ).rejects.toThrow("bounded server-side collection is required");
    expect(cancel).toHaveBeenCalledOnce();
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("bounds native retention before Node receives a noisy observation", async () => {
    const { session } = await open();
    const result = await session.execute({
      source: 'text("HEAD" + "x".repeat(4 * 1024 * 1024) + "TAIL");',
      toolCallId: "bounded-output",
      tools: [],
    });
    expect(result.state).toBe("completed");
    const output = result.items.flatMap((item) =>
      item.type === "text" ? [item.text] : [],
    );
    expect(output[0]).toMatch(/^HEAD/);
    expect(output.at(-1)).toMatch(/TAIL$/);
    const notice = output.find((text) =>
      text.startsWith("[Code Mode session output limit reached:"),
    );
    expect(notice).toContain("omitted 3145736 text bytes");
    expect(
      output.reduce((bytes, text) => bytes + Buffer.byteLength(text), 0),
    ).toBeLessThanOrEqual(NATIVE_OUTPUT_LIMITS.textBytes + 1024);
    expect(
      await session.execute({
        source: 'text("healthy");',
        toolCallId: "after-noise",
        tools: [],
      }),
    ).toMatchObject({
      state: "completed",
      items: [{ type: "text", text: "healthy" }],
    });
  });
});

describe("Code Mode catalog revisions", () => {
  const tool = {
    name: "lookup",
    description: "Returns the current value.",
    call: async () => "first",
  };
  const request = {
    tools: [tool],
    toolCallId: "lookup",
    source: "text(await tools.lookup({}));",
  };

  it("reuses acknowledged contracts while each cell keeps its own callbacks", async () => {
    const { client, session } = await open();
    const execute = vi.spyOn(client, "execute");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = {
      ...tool,
      call: async () => {
        await gate;
        return "first";
      },
    };
    const running = await session.execute({
      ...request,
      tools: [original],
      source:
        "yield_control(); await tools.lookup({}); text(await tools.lookup({}));",
    });
    try {
      expect(running.state).toBe("yielded");
      const second = { ...tool, call: async () => "second" };
      const result = await session.execute({ ...request, tools: [second] });
      expect(result.items).toEqual([{ type: "text", text: "second" }]);
      const changed = { ...second, inputSchema: { type: "object" } };
      await session.execute({ ...request, tools: [changed] });
      const [first, reused, refresh] = execute.mock.calls.map(([call]) => call);
      expect(first!.enabledTools).toMatchObject([{ name: "lookup" }]);
      expect(Number(first!.catalogRevision)).toBeGreaterThan(0);
      expect(reused!.catalogRevision).toBe(first!.catalogRevision);
      expect(reused!.enabledTools ?? []).toEqual([]);
      expect(refresh!.enabledTools).toMatchObject([{ name: "lookup" }]);
      expect(Number(refresh!.catalogRevision)).toBeGreaterThan(
        Number(first!.catalogRevision),
      );
    } finally {
      release();
    }
    const done = await session.wait({
      cellId: running.cellId,
      yieldTimeMs: 5_000,
    });
    expect(done.items).toEqual([{ type: "text", text: "first" }]);

    // A replacement session on the same host must install its own catalog.
    const fresh = await CodeModeSession.open({
      client,
      startupTimeoutMs: 10_000,
      transportTimeoutMs: 10_000,
    });
    cleanup.push(() => fresh.close());
    await fresh.execute({
      ...request,
      tools: [{ ...tool, inputSchema: { type: "object" } }],
    });
    expect(execute.mock.lastCall![0].enabledTools).toMatchObject([
      { name: "lookup" },
    ]);
  });

  it("sends a full independent catalog while a registration awaits admission", async () => {
    const { client, session } = await open();
    const execute = vi.spyOn(client, "execute");
    const [first, other] = await Promise.all([
      session.execute(request),
      session.execute({
        ...request,
        tools: [
          {
            name: "different",
            description: "Another tool.",
            call: async () => "other",
          },
        ],
        source: "text(await tools.different({}));",
      }),
    ]);
    expect(first.items).toEqual([{ type: "text", text: "first" }]);
    expect(other.items).toEqual([{ type: "text", text: "other" }]);
    const independent = execute.mock.calls[1]![0];
    expect(independent.catalogRevision).toBeUndefined();
    expect(independent.enabledTools).toMatchObject([{ name: "different" }]);
    await session.execute(request);
    expect(execute.mock.lastCall![0].catalogRevision).toBe(
      execute.mock.calls[0]![0].catalogRevision,
    );
    expect(execute.mock.lastCall![0].enabledTools ?? []).toEqual([]);
  });

  it("sends full contracts when the host omits the capability", async () => {
    const { client, session } = await open((client) => {
      const invoke = client.openSession.bind(client);
      vi.spyOn(client, "openSession").mockImplementation((request) => {
        const stream = invoke(request);
        stream.once("data", (event: ProtoMessage) => {
          delete (event.opened as ProtoMessage).supportsCatalogRevision;
        });
        return stream;
      });
    });
    const execute = vi.spyOn(client, "execute");
    await session.execute(request);
    await session.execute(request);
    for (const [call] of execute.mock.calls) {
      expect(call.enabledTools).toMatchObject([{ name: "lookup" }]);
      expect(call.catalogRevision).toBeUndefined();
    }
  });

  function observeTermination(session: CodeModeSession): Promise<void> {
    const terminate = session.terminate.bind(session);
    let stopped!: () => void;
    const stoppedCell = new Promise<void>((resolve) => {
      stopped = resolve;
    });
    vi.spyOn(session, "terminate").mockImplementation(async (...args) => {
      const result = await terminate(...args);
      stopped();
      return result;
    });
    return stoppedCell;
  }

  it("keeps the referenced catalog until a cancelled RPC reaches the host", async () => {
    const { client, session } = await open();
    await session.execute(request);
    const invoke = client.execute.bind(client);
    const execute = vi.spyOn(client, "execute");
    let dispatch!: () => void;
    execute.mockImplementationOnce((...args) => {
      let real: grpc.ClientReadableStream<ProtoMessage>;
      const delayed = Object.assign(new PassThrough({ objectMode: true }), {
        cancel: () => real?.cancel(),
      });
      dispatch = () => {
        real = invoke(...args);
        real.on("error", (error: Error) => delayed.emit("error", error));
        real.on("status", (status) => delayed.emit("status", status));
        real.pipe(delayed);
      };
      return delayed as unknown as grpc.ClientReadableStream<ProtoMessage>;
    });
    const stopped = observeTermination(session);
    const abort = new AbortController();
    const pending = session.execute({
      ...request,
      source: "await new Promise(() => {});",
      signal: abort.signal,
    });
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    const changed = {
      ...request,
      tools: [{ ...tool, description: "Updated lookup." }],
    };
    try {
      // The replacement reaches the real host before the previous reference.
      await session.execute(changed);
      const [reference, replacement] = execute.mock.calls.map(([call]) => call);
      expect(reference!.enabledTools ?? []).toEqual([]);
      expect(Number(reference!.catalogRevision)).toBeGreaterThan(0);
      expect(replacement!.enabledTools).toMatchObject([{ name: "lookup" }]);
      expect(replacement!.catalogRevision).toBeUndefined();
    } finally {
      dispatch();
    }
    await stopped;
    const result = await session.execute(changed);
    expect(result.items).toEqual([{ type: "text", text: "first" }]);
  });

  it("discards a cancelled registration even if the host later reports the cell", async () => {
    const { client, session } = await open();
    const execute = vi.spyOn(client, "execute");
    const stoppedCell = observeTermination(session);
    const abort = new AbortController();
    const pending = session.execute({
      ...request,
      source: "await new Promise(() => {});",
      signal: abort.signal,
    });
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    // Termination proves that the session handled the real late start event.
    await stoppedCell;
    await session.execute(request);
    const [cancelled, next] = execute.mock.calls.map(([call]) => call);
    expect(Number(next!.catalogRevision)).toBeGreaterThan(
      Number(cancelled!.catalogRevision),
    );
    expect(next!.enabledTools).toMatchObject([{ name: "lookup" }]);
  });
});

describe("Code Mode missing-session RPC contracts", () => {
  it.each([false, true])(
    "retires Execute NOT_FOUND with its status preserved (started=%s)",
    async (started) => {
      const { client, session, onFailure } = await open();
      vi.spyOn(client, "execute").mockImplementation((request) => {
        const stream = Object.assign(new PassThrough({ objectMode: true }), {
          cancel() {},
        });
        queueMicrotask(() => {
          if (started)
            stream.write({
              event: "started",
              started: {
                executionId: request.executionId,
                cellId: "lost-cell",
              },
            });
          stream.emit("error", notFound());
          stream.emit("status", { code: grpc.status.NOT_FOUND });
        });
        return stream as unknown as grpc.ClientReadableStream<ProtoMessage>;
      });
      await expect(
        session.execute({ source: "text(1);", toolCallId: "lost", tools: [] }),
      ).rejects.toMatchObject({ code: grpc.status.NOT_FOUND });
      expect(session.usable).toBe(false);
      expect(onFailure).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["wait", "terminate"] as const)(
    "retires %s NOT_FOUND with its status preserved",
    async (operation) => {
      const { client, session, onFailure } = await open();
      vi.spyOn(client, operation).mockImplementation(
        (_request, _options, callback) => {
          queueMicrotask(() => callback(notFound()));
          return { cancel() {} } as grpc.ClientUnaryCall;
        },
      );
      const result =
        operation === "wait"
          ? session.wait({ cellId: "lost", yieldTimeMs: 0 })
          : session.terminate("lost");
      await expect(result).rejects.toMatchObject({
        code: grpc.status.NOT_FOUND,
      });
      expect(session.usable).toBe(false);
      expect(onFailure).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps a live session when Wait and Terminate report a missing cell", async () => {
    const { session, onFailure } = await open();
    for (const result of [
      await session.wait({ cellId: "missing-cell", yieldTimeMs: 0 }),
      await session.terminate("missing-cell"),
    ]) {
      expect(result).toMatchObject({
        state: "completed",
        errorText: "exec cell missing-cell not found",
      });
    }
    expect(session.usable).toBe(true);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("does not interpret a canceled invocation's NOT_FOUND as a missing session", async () => {
    const { client, session, onFailure } = await open();
    await session.execute({
      source: 'store("kept",7);',
      toolCallId: "before",
      tools: [],
    });
    let complete!: grpc.requestCallback<ProtoMessage>;
    let started!: () => void;
    const completing = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.spyOn(client, "completeToolCall").mockImplementation(
      (_request, _options, callback) => {
        complete = callback;
        started();
        return { cancel() {} } as grpc.ClientUnaryCall;
      },
    );
    const result = await session.execute({
      source: "yield_control(); await tools.echo({});",
      toolCallId: "cancel-completion",
      tools: [
        {
          name: "echo",
          description: "Returns its input.",
          call: async (input) => input,
        },
      ],
    });
    await completing;
    await session.terminate(result.cellId);
    complete(notFound());
    const after = await session.execute({
      source: 'text(load("kept"));',
      toolCallId: "after",
      tools: [],
    });
    expect(after).toMatchObject({
      state: "completed",
      items: [{ type: "text", text: "7" }],
    });
    expect(session.usable).toBe(true);
    expect(onFailure).not.toHaveBeenCalled();
  });
});

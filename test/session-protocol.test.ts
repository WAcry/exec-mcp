import { PassThrough } from "node:stream";
import * as grpc from "@grpc/grpc-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodeModeHostProcess } from "../src/code-mode/host-process.js";
import { CodeModeSession } from "../src/code-mode/session.js";
import type { ProtoMessage } from "../src/code-mode/protocol.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

async function open() {
  const host = new CodeModeHostProcess({
    startupTimeoutMs: 10_000,
    onUnexpectedExit() {},
  });
  cleanup.push(() => host.stop());
  const client = await host.start();
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

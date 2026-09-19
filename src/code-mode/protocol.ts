import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

export const HOST_GRPC_FRAME_BYTES = 64 * 1024 * 1024;

export type ProtoMessage = Record<string, unknown>;

export interface CodeModeHostClient extends grpc.Client {
  acknowledgeNotification(
    request: ProtoMessage,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<ProtoMessage>,
  ): grpc.ClientUnaryCall;
  cancelWait(
    request: ProtoMessage,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<ProtoMessage>,
  ): grpc.ClientUnaryCall;
  closeSession(
    request: ProtoMessage,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<ProtoMessage>,
  ): grpc.ClientUnaryCall;
  completeToolCall(
    request: ProtoMessage,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<ProtoMessage>,
  ): grpc.ClientUnaryCall;
  execute(
    request: ProtoMessage,
    options?: grpc.CallOptions,
  ): grpc.ClientReadableStream<ProtoMessage>;
  openSession(
    request: ProtoMessage,
    options?: grpc.CallOptions,
  ): grpc.ClientReadableStream<ProtoMessage>;
  subscribeToToolCalls(
    request: ProtoMessage,
    options?: grpc.CallOptions,
  ): grpc.ClientReadableStream<ProtoMessage>;
  terminate(
    request: ProtoMessage,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<ProtoMessage>,
  ): grpc.ClientUnaryCall;
  wait(
    request: ProtoMessage,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<ProtoMessage>,
  ): grpc.ClientUnaryCall;
}

interface CodeModeHostConstructor {
  new (
    address: string,
    credentials: grpc.ChannelCredentials,
    options?: grpc.ClientOptions,
  ): CodeModeHostClient;
}

interface LoadedPackage {
  codex: {
    code_mode: {
      v1: {
        CodeModeHost: CodeModeHostConstructor;
      };
    };
  };
}

let hostConstructor: CodeModeHostConstructor | undefined;

export function createCodeModeHostClient(address: string): CodeModeHostClient {
  hostConstructor ??= loadCodeModeHostConstructor();
  return new hostConstructor(address, grpc.credentials.createInsecure(), {
    "grpc.max_receive_message_length": HOST_GRPC_FRAME_BYTES,
    "grpc.max_send_message_length": HOST_GRPC_FRAME_BYTES,
    // Private loopback IPC to our owned host, not an outbound HTTP request.
    "grpc.enable_http_proxy": 0,
  });
}

export function waitForClientReady(
  client: CodeModeHostClient,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    client.waitForReady(Date.now() + timeoutMs, (error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(
          new Error(`Code Mode gRPC host is unavailable: ${error.message}`),
        );
      }
    });
  });
}

export function unaryCall(
  start: (
    options: grpc.CallOptions,
    callback: grpc.requestCallback<ProtoMessage>,
  ) => grpc.ClientUnaryCall,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ProtoMessage> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let call: grpc.ClientUnaryCall | undefined;
    const finish = (error?: Error, response?: ProtoMessage): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      if (error !== undefined) reject(error);
      else resolve(response ?? {});
    };
    const abort = (): void => {
      call?.cancel();
      finish(abortError());
    };

    if (signal?.aborted === true) {
      finish(abortError());
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    call = start(
      { deadline: Date.now() + timeoutMs },
      (error, response): void => {
        if (error !== null) {
          finish(new Error(trimGrpcError(error)));
        } else {
          finish(undefined, response);
        }
      },
    );
  });
}

export function grpcError(error: unknown, operation: string): Error {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : String(error);
  return new Error(`Code Mode ${operation} failed: ${message.slice(0, 512)}`);
}

function loadCodeModeHostConstructor(): CodeModeHostConstructor {
  const packageDefinition = protoLoader.loadSync(resolveProtoPath(), {
    defaults: false,
    enums: String,
    keepCase: false,
    longs: Number,
    oneofs: true,
  });
  const loaded = grpc.loadPackageDefinition(
    packageDefinition,
  ) as unknown as LoadedPackage;
  return loaded.codex.code_mode.v1.CodeModeHost;
}

function resolveProtoPath(): string {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    const candidate = path.join(directory, "proto", "codex.code_mode.v1.proto");
    if (fs.existsSync(candidate)) return candidate;

    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error("cannot locate pinned proto/codex.code_mode.v1.proto");
}

function abortError(): Error {
  const error = new Error("Code Mode operation was aborted");
  error.name = "AbortError";
  return error;
}

function trimGrpcError(error: grpc.ServiceError): string {
  return `gRPC ${grpc.status[error.code] ?? error.code}: ${error.details}`.slice(
    0,
    512,
  );
}

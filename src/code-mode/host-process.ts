import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

import { resolveCodexBinary } from "../codex-package.js";
import {
  createCodeModeHostClient,
  type CodeModeHostClient,
  waitForClientReady,
} from "./protocol.js";

const MAX_STARTUP_OUTPUT_BYTES = 16 * 1024;
const DEFAULT_TERMINATION_GRACE_MS = 3_000;
type HostChild = ChildProcessByStdio<null, Readable, Readable>;
export interface HostIdentity {
  readonly pid: number;
  readonly generation: number;
}

export class CodeModeHostProcess {
  readonly #binaryOverride: string | undefined;
  readonly #onUnexpectedExit: (error: Error) => void;
  readonly #startupTimeoutMs: number;
  readonly #terminationGraceMs: number;
  #child: HostChild | undefined;
  #client: CodeModeHostClient | undefined;
  #startPromise: Promise<CodeModeHostClient> | undefined;
  #stopping = false;
  #stopPromise: Promise<void> | undefined;
  #identity: HostIdentity | undefined;
  #generation = 0;

  constructor(options: {
    binary?: string;
    onUnexpectedExit(error: Error): void;
    startupTimeoutMs: number;
    terminationGraceMs?: number;
  }) {
    this.#binaryOverride = options.binary;
    this.#onUnexpectedExit = options.onUnexpectedExit;
    this.#startupTimeoutMs = options.startupTimeoutMs;
    this.#terminationGraceMs =
      options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
    if (
      !Number.isSafeInteger(this.#terminationGraceMs) ||
      this.#terminationGraceMs < 0
    ) {
      throw new Error("terminationGraceMs must be a non-negative safe integer");
    }
  }

  start(): Promise<CodeModeHostClient> {
    if (this.#stopPromise) return this.#stopPromise.then(() => this.start());
    if (this.#stopping && this.#child)
      return this.stop().then(() => this.start());
    this.#startPromise ??= this.#start();
    return this.#startPromise;
  }

  get identity(): HostIdentity | undefined {
    return this.#identity;
  }

  stop(): Promise<void> {
    this.#stopPromise ??= this.#stop().finally(() => {
      this.#stopPromise = undefined;
    });
    return this.#stopPromise;
  }

  async #stop(): Promise<void> {
    this.#stopping = true;
    const child = this.#child;
    const opening = this.#startPromise;
    this.#client?.close();
    this.#client = undefined;
    this.#startPromise = undefined;
    if (child === undefined) return;
    await terminateAndReap(child, this.#terminationGraceMs);
    await opening?.catch(() => undefined);
    if (this.#child === child) {
      this.#child = undefined;
      this.#identity = undefined;
    }
  }

  async #start(): Promise<CodeModeHostClient> {
    this.#stopping = false;
    const binary =
      this.#binaryOverride ?? resolveCodexBinary("codex-code-mode-host");
    const child = spawn(binary, ["--listen", "grpc://127.0.0.1:0"], {
      env: process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.#child = child;
    this.#identity =
      child.pid === undefined
        ? undefined
        : Object.freeze({ pid: child.pid, generation: ++this.#generation });

    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-MAX_STARTUP_OUTPUT_BYTES);
    });

    let client: CodeModeHostClient | undefined;
    let exitError: Error | undefined;
    let startupReady = false;
    let resolveExit!: () => void;
    const exited = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    const stopped = exited.then(() => {
      throw (
        exitError ??
        new Error("codex-code-mode-host stopped without an exit status")
      );
    });
    child.once("exit", (code, signal) => {
      const reason =
        signal === null ? `exit code ${code ?? "unknown"}` : `signal ${signal}`;
      exitError = new Error(
        startupReady
          ? `codex-code-mode-host stopped unexpectedly (${reason})${formatStderr(stderr)}`
          : `codex-code-mode-host stopped before startup (${reason})${formatStderr(stderr)}`,
      );
      resolveExit();
      client?.close();
      if (this.#child !== child) return;
      this.#client = undefined;
      this.#child = undefined;
      this.#identity = undefined;
      this.#startPromise = undefined;
      if (startupReady && !this.#stopping) this.#onUnexpectedExit(exitError);
    });

    try {
      const address = await Promise.race([
        readPublishedAddress(child, this.#startupTimeoutMs, () => stderr),
        stopped,
      ]);
      client = createCodeModeHostClient(address);
      await Promise.race([
        waitForClientReady(client, this.#startupTimeoutMs),
        stopped,
      ]);
      this.#client = client;
      startupReady = true;
      return client;
    } catch (error) {
      client?.close();
      await terminateAndReap(child, this.#terminationGraceMs);
      if (this.#child === child) {
        this.#child = undefined;
        this.#identity = undefined;
      }
      this.#startPromise = undefined;
      throw error;
    }
  }
}

async function terminateAndReap(
  child: HostChild,
  graceMs: number,
): Promise<void> {
  if (
    child.pid === undefined ||
    child.exitCode !== null ||
    child.signalCode !== null
  )
    return;

  let onClose!: () => void;
  const closed = new Promise<void>((resolve) => {
    onClose = resolve;
  });
  child.once("close", onClose);
  try {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    const stopped = await Promise.race([
      closed.then(() => true),
      delay(graceMs).then(() => false),
    ]);
    if (stopped) return;
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    const reaped = await Promise.race([
      closed.then(() => true),
      delay(DEFAULT_TERMINATION_GRACE_MS).then(() => false),
    ]);
    if (!reaped)
      throw new Error(
        "Code Mode host 终止尚未确认；本次操作失败，后续调用可重新尝试恢复，不自动重跑命令。",
      );
  } finally {
    child.removeListener("close", onClose);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}

function readPublishedAddress(
  child: HostChild,
  timeoutMs: number,
  stderr: () => string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let settled = false;
    const timer = setTimeout(() => {
      finish(
        new Error(
          `codex-code-mode-host did not publish its address${formatStderr(stderr())}`,
        ),
      );
    }, timeoutMs);

    const finish = (error?: Error, address?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.removeListener("data", onData);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      if (error !== undefined) reject(error);
      else resolve(address!);
    };
    const onData = (chunk: Buffer): void => {
      stdout += chunk.toString("utf8");
      if (Buffer.byteLength(stdout, "utf8") > MAX_STARTUP_OUTPUT_BYTES) {
        finish(
          new Error("codex-code-mode-host published excessive startup output"),
        );
        return;
      }
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      try {
        finish(
          undefined,
          parseLoopbackAddress(stdout.slice(0, newline).trim()),
        );
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const onError = (error: Error): void => {
      finish(
        new Error(`failed to start codex-code-mode-host: ${error.message}`),
      );
    };
    const onExit = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      const reason =
        signal === null ? `exit code ${code ?? "unknown"}` : `signal ${signal}`;
      finish(
        new Error(
          `codex-code-mode-host stopped before startup (${reason})${formatStderr(stderr())}`,
        ),
      );
    };

    child.stdout.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function parseLoopbackAddress(line: string): string {
  const url = new URL(line);
  if (url.protocol !== "http:" || url.username !== "" || url.password !== "") {
    throw new Error("codex-code-mode-host published an invalid gRPC URL");
  }
  if (!new Set(["127.0.0.1", "[::1]", "localhost"]).has(url.hostname)) {
    throw new Error("codex-code-mode-host did not bind to loopback");
  }
  if (
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.port === ""
  ) {
    throw new Error("codex-code-mode-host published an invalid gRPC origin");
  }
  return url.host;
}

function formatStderr(stderr: string): string {
  const value = stderr.trim();
  return value === "" ? "" : `: ${value}`;
}

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { spawn as spawnPty, type IPty } from "node-pty";
import {
  AsyncMutex,
  randomHandle,
  resolveUserPath,
  throwIfAborted,
  waitUntil,
} from "../util.js";
import { terminateProcessTree } from "./platform.js";
import { inheritedEnvironment } from "../environment.js";
import { DEFAULT_IDLE_MS, MEMORY_DEFAULTS, MiB } from "../memory.js";
import { RollingOutputBuffer } from "./output-buffer.js";
import {
  resolveCommandShell,
  resolveShell,
  shellInvocation,
  type CommandShell,
} from "./shell.js";

export interface ExecCommandInput {
  cmd: string;
  workdir?: string;
  shell?: string;
  login?: boolean;
  tty?: boolean;
  yield_time_ms?: number;
}
export interface WriteStdinInput {
  session_id: string;
  chars?: string;
  close_stdin?: boolean;
  yield_time_ms?: number;
  cols?: number;
  rows?: number;
  terminate?: boolean;
}
export interface TerminalResult {
  output: string;
  wall_time_seconds: number;
  session_id?: string;
  exit_code?: number;
  truncated?: true;
  omitted_bytes?: number;
}
type Backend =
  | { kind: "pipe"; process: ChildProcessWithoutNullStreams }
  | { kind: "pty"; process: IPty };
interface Session {
  id: string;
  backend: Backend;
  buffer: RollingOutputBuffer;
  touched: number;
  observers: number;
  mutex: AsyncMutex;
  done: Promise<number>;
  finish(code: number): void;
  outputReady?: () => void;
  exitCode?: number;
  terminating?: Promise<void>;
}
const READ_BYTES = 1024 * 1024;
export class TerminalManager {
  readonly shell: CommandShell;
  private readonly bufferBytes: number;
  private readonly idleMs: number;
  private readonly timer: NodeJS.Timeout;
  private sessions = new Map<string, Session>();
  private closed = false;
  constructor(
    options: {
      shell?: CommandShell;
      bufferBytes?: number;
      idleMs?: number;
    } = {},
  ) {
    this.shell = options.shell ?? resolveShell();
    this.bufferBytes =
      options.bufferBytes ?? MEMORY_DEFAULTS.terminal_buffer_mib * MiB;
    this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
    if (
      !Number.isSafeInteger(this.bufferBytes) ||
      this.bufferBytes < 64 ||
      !Number.isFinite(this.idleMs) ||
      this.idleMs <= 0
    )
      throw new Error("终端缓冲大小或空闲保留时间无效。");
    this.timer = setInterval(() => this.sweep(), Math.min(this.idleMs, 60_000));
    this.timer.unref();
  }

  getActiveSessions(): {
    id: string;
    exitCode?: number | undefined;
    touched: number;
    observers: number;
    kind: "pipe" | "pty";
    pid?: number | undefined;
    bufferBytes: number;
    bufferCapacityBytes: number;
    omittedBytes: number;
  }[] {
    return [...this.sessions.values()].map((s) => ({
      id: s.id,
      exitCode: s.exitCode,
      touched: s.touched,
      observers: s.observers,
      kind: s.backend.kind,
      pid: s.backend.process.pid,
      bufferBytes: s.buffer.bytes,
      bufferCapacityBytes: s.buffer.capacity,
      omittedBytes: s.buffer.omittedBytes,
    }));
  }

  async execCommand(
    input: ExecCommandInput,
    base: string,
    signal?: AbortSignal,
  ): Promise<TerminalResult> {
    this.requireOpen();
    throwIfAborted(signal);
    const cwd = await realpath(resolveUserPath(input.workdir ?? base, base));
    if (!(await stat(cwd)).isDirectory()) throw new Error("命令目录不存在。");
    this.requireOpen();
    throwIfAborted(signal);
    const selected = resolveCommandShell(this.shell, input, cwd);
    const shell = shellInvocation(input.cmd, selected);
    const backend: Backend = input.tty
      ? {
          kind: "pty",
          process: spawnPty(shell.file, shell.args, {
            cwd,
            env: this.environment(),
            cols: 120,
            rows: 40,
            name: "xterm-256color",
          }),
        }
      : {
          kind: "pipe",
          process: spawn(shell.file, shell.args, {
            cwd,
            env: this.environment(),
            detached: process.platform !== "win32",
            windowsHide: true,
            stdio: "pipe",
          }),
        };
    let finish!: (code: number) => void;
    const done = new Promise<number>((resolve) => {
      finish = resolve;
    });
    const session: Session = {
      id: randomHandle("term"),
      backend,
      buffer: new RollingOutputBuffer(this.bufferBytes),
      touched: Date.now(),
      observers: 1,
      mutex: new AsyncMutex(),
      done,
      finish,
    };
    this.sessions.set(session.id, session);
    const ended = (code: number): void => {
      if (session.exitCode !== undefined) return;
      session.exitCode = code;
      session.touched = Date.now();
      session.finish(code);
      session.outputReady?.();
    };
    if (backend.kind === "pipe") {
      const child = backend.process;
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (text: string) => this.append(session, text));
      child.stderr.on("data", (text: string) => this.append(session, text));
      child.stdin.on("error", () => {
        /* Write callbacks report EPIPE; never crash on a closed pipe. */
      });
      child.on("error", (error) => {
        this.append(session, `进程启动失败：${error.message}\n`);
      });
      child.on("close", (code) => ended(code ?? 1));
    } else {
      backend.process.onData((text) => this.append(session, text));
      backend.process.onExit((event) => ended(event.exitCode));
    }
    const started = performance.now();
    try {
      await waitUntil(done, input.yield_time_ms ?? 10_000, signal);
      return this.collect(session, started);
    } catch (error) {
      await this.terminate(session);
      this.remove(session);
      throw new Error(
        "命令启动后等待被取消；进程已请求终止，已发生的副作用不会回滚。",
        { cause: error },
      );
    } finally {
      session.observers--;
    }
  }

  async writeStdin(
    input: WriteStdinInput,
    signal?: AbortSignal,
  ): Promise<TerminalResult> {
    this.requireOpen();
    throwIfAborted(signal);
    const session = this.sessions.get(input.session_id);
    if (!session)
      throw new Error(`未知或已读完的终端会话：${input.session_id}`);
    session.touched = Date.now();
    session.observers++;
    try {
      if (input.terminate) await this.terminate(session);
      return await session.mutex.run(async () => {
        throwIfAborted(signal);
        if (!this.sessions.has(session.id))
          throw new Error("终端输出已经由另一次调用读完。");
        const started = performance.now();
        const { backend } = session;
        if (input.cols !== undefined && input.rows !== undefined) {
          if (backend.kind !== "pty")
            throw new Error("只有 PTY 会话可以调整尺寸。");
          backend.process.resize(input.cols, input.rows);
        }
        if (input.close_stdin && backend.kind === "pty")
          throw new Error(
            "PTY 不支持关闭单独的 stdin；按程序约定发送 EOF 字符。",
          );
        if (input.chars || input.close_stdin) {
          if (session.exitCode !== undefined)
            throw new Error("进程已退出，不能继续写入。");
          if (backend.kind === "pty") backend.process.write(input.chars ?? "");
          else {
            await new Promise<void>((resolve, reject) => {
              const callback = (error?: Error | null): void =>
                error ? reject(error) : resolve();
              if (input.close_stdin)
                backend.process.stdin.end(input.chars ?? "", callback);
              else backend.process.stdin.write(input.chars!, callback);
            });
          }
        }
        // Existing unread output is useful immediately, even for a long requested wait.
        if (!session.buffer.pending && session.exitCode === undefined) {
          try {
            // Progress is useful before a live process exits or asks for more input.
            await waitUntil(
              new Promise<void>((resolve) => {
                session.outputReady = resolve;
              }),
              input.yield_time_ms ??
                (input.chars || input.close_stdin ? 250 : 110_000),
              signal,
            );
          } finally {
            delete session.outputReady;
          }
        }
        return this.collect(session, started);
      });
    } finally {
      session.observers--;
      session.touched = Date.now();
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    const sessions = [...this.sessions.values()];
    const results = await Promise.allSettled(
      sessions.map((session) => this.terminate(session)),
    );
    for (const session of sessions) this.remove(session);
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length)
      throw new AggregateError(failures, "未能清理全部自有终端进程。");
  }
  private environment(): Record<string, string> {
    return inheritedEnvironment();
  }
  private append(session: Session, text: string): void {
    if (!this.sessions.has(session.id)) return;
    session.buffer.append(text);
    session.outputReady?.();
  }
  private collect(session: Session, started: number): TerminalResult {
    session.touched = Date.now();
    const result: TerminalResult = {
      ...session.buffer.read(READ_BYTES),
      wall_time_seconds: (performance.now() - started) / 1000,
    };
    if (session.exitCode === undefined || session.buffer.pending)
      result.session_id = session.id;
    else {
      result.exit_code = session.exitCode;
      this.remove(session);
    }
    return result;
  }
  /** Expire finished, unobserved records only; never terminate a user process by age. */
  private sweep(): void {
    const deadline = Date.now() - this.idleMs;
    for (const session of this.sessions.values())
      if (
        session.exitCode !== undefined &&
        !session.observers &&
        session.touched <= deadline
      )
        this.remove(session);
  }
  private terminate(session: Session): Promise<void> {
    session.terminating ??= (async () => {
      if (session.exitCode !== undefined) return;
      const pid = session.backend.process.pid;
      if (pid !== undefined) {
        await terminateProcessTree(pid);
        if ((await waitUntil(session.done, 750)) === undefined)
          await terminateProcessTree(pid, true);
      }
      if ((await waitUntil(session.done, 3000)) === undefined)
        throw new Error("进程树终止未确认。");
    })();
    return session.terminating;
  }
  private remove(session: Session): void {
    if (!this.sessions.delete(session.id)) return;
    session.buffer.clear();
  }
  private requireOpen(): void {
    if (this.closed) throw new Error("终端管理器已关闭。");
  }
}

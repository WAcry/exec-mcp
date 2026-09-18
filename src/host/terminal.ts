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
import { shellInvocation, terminateProcessTree } from "./platform.js";

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
}
type Backend =
  | { kind: "pipe"; process: ChildProcessWithoutNullStreams }
  | { kind: "pty"; process: IPty };
interface Session {
  id: string;
  backend: Backend;
  chunks: Buffer[];
  bytes: number;
  mutex: AsyncMutex;
  done: Promise<number>;
  finish(code: number): void;
  exitCode?: number;
  terminating?: Promise<void>;
}
const READ_BYTES = 1024 * 1024;
const HIGH_WATER = 128 * 1024 * 1024;
const LOW_WATER = 64 * 1024 * 1024;
export class TerminalManager {
  private sessions = new Map<string, Session>();
  private unread = 0;
  private paused = false;
  private closed = false;
  constructor(
    private readonly highWater = HIGH_WATER,
    private readonly lowWater = LOW_WATER,
  ) {}

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
    const shell = shellInvocation(input.cmd, input.shell, input.login);
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
      chunks: [],
      bytes: 0,
      mutex: new AsyncMutex(),
      done,
      finish,
    };
    this.sessions.set(session.id, session);
    const ended = (code: number): void => {
      if (session.exitCode !== undefined) return;
      session.exitCode = code;
      session.finish(code);
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
    if (this.paused) this.pause(session, true);
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
    if (input.terminate) await this.terminate(session);
    return session.mutex.run(async () => {
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
      if (session.bytes === 0 && session.exitCode === undefined) {
        await waitUntil(
          session.done,
          input.yield_time_ms ??
            (input.chars || input.close_stdin ? 250 : 110_000),
          signal,
        );
      }
      return this.collect(session, started);
    });
  }
  async close(): Promise<void> {
    this.closed = true;
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
    return Object.fromEntries(
      Object.entries({ ...process.env, EXEC_MCP_CHILD: "1" }).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
  }
  private append(session: Session, text: string): void {
    if (!this.sessions.has(session.id)) return;
    const chunk = Buffer.from(text);
    session.chunks.push(chunk);
    session.bytes += chunk.length;
    this.unread += chunk.length;
    this.backpressure();
  }
  private collect(session: Session, started: number): TerminalResult {
    const chunks: Buffer[] = [];
    let remaining = READ_BYTES;
    while (remaining && session.chunks.length) {
      const chunk = session.chunks[0]!;
      let count = Math.min(chunk.length, remaining);
      while (
        count < chunk.length &&
        count > 0 &&
        (chunk[count]! & 0xc0) === 0x80
      )
        count--;
      if (!count) break;
      chunks.push(chunk.subarray(0, count));
      remaining -= count;
      session.bytes -= count;
      this.unread -= count;
      if (count === chunk.length) session.chunks.shift();
      else session.chunks[0] = chunk.subarray(count);
    }
    this.backpressure();
    const result: TerminalResult = {
      output: Buffer.concat(chunks).toString("utf8"),
      wall_time_seconds: (performance.now() - started) / 1000,
    };
    if (session.exitCode === undefined || session.bytes)
      result.session_id = session.id;
    else {
      result.exit_code = session.exitCode;
      this.remove(session);
    }
    return result;
  }
  private terminate(session: Session): Promise<void> {
    session.terminating ??= (async () => {
      if (session.exitCode !== undefined) return;
      this.pause(session, false);
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
    this.unread -= session.bytes;
    session.bytes = 0;
    session.chunks = [];
    this.backpressure();
  }
  private pause(session: Session, value: boolean): void {
    if (session.exitCode !== undefined) return;
    const { backend } = session;
    if (backend.kind === "pty") {
      if (value) backend.process.pause();
      else backend.process.resume();
    } else
      for (const stream of [backend.process.stdout, backend.process.stderr]) {
        if (value) stream.pause();
        else stream.resume();
      }
  }
  private backpressure(): void {
    const next = this.paused
      ? this.unread > this.lowWater
      : this.unread >= this.highWater;
    if (this.paused === next) return;
    this.paused = next;
    for (const session of this.sessions.values()) this.pause(session, next);
  }
  private requireOpen(): void {
    if (this.closed) throw new Error("终端管理器已关闭。");
  }
}

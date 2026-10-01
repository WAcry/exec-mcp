import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { constants as osConstants } from "node:os";
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
import { inputPreview } from "../tool-names.js";
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
  /** Cumulative stderr bytes observed for pipe sessions, including rolled-off output. */
  stderr_bytes?: number;
}
type Backend =
  | { kind: "pipe"; process: ChildProcessWithoutNullStreams }
  | { kind: "pty"; process: IPty };
interface Session {
  id: string;
  backend: Backend;
  /** First command line and directory, shown by the Web console. */
  command: string;
  cwd: string;
  /** Conversation digest that started the process, when known. */
  owner?: string;
  buffer: RollingOutputBuffer;
  touched: number;
  observers: number;
  mutex: AsyncMutex;
  done: Promise<number>;
  finish(code: number): void;
  exitReady?: () => void;
  exitCode?: number;
  terminating?: Promise<void>;
  stderrBytes: number;
}
export const TERMINAL_READ_BYTES = 4 * 1024 * 1024;
/** Codex's minimum collection window for an empty write_stdin read. */
export const EMPTY_POLL_MIN_MS = 5000;
/** Codex's collection windows, with an explicit zero for immediate local inspection. */
export function stdinYieldTime(
  input: WriteStdinInput,
  minEmptyPollMs = EMPTY_POLL_MIN_MS,
): number {
  const requested = input.yield_time_ms ?? 250;
  if (requested === 0) return 0;
  return input.chars
    ? Math.max(250, Math.min(30_000, requested))
    : Math.max(minEmptyPollMs, Math.min(300_000, requested));
}
/** Shell convention: a process that signal N ended reports exit code 128 + N. */
export function exitStatus(
  code: number | null | undefined,
  signal: NodeJS.Signals | number | null | undefined,
): number {
  const number =
    typeof signal === "string" ? osConstants.signals[signal] : signal;
  if (typeof number === "number" && number > 0) return 128 + number;
  return code ?? 1;
}
export interface TerminalManagerOptions {
  shell?: CommandShell;
  /** Unread output kept for one session. */
  bufferBytes?: number;
  /** Retention of finished sessions whose output nobody read. */
  idleMs?: number;
  /** Sessions kept at one time, running or finished but unread. */
  maxSessions?: number;
  /** Unread output kept across all sessions; never below bufferBytes. */
  totalBufferBytes?: number;
  /** Minimum collection window of an empty write_stdin read. */
  minEmptyPollMs?: number;
}
export class TerminalManager {
  readonly shell: CommandShell;
  private readonly bufferBytes: number;
  private readonly idleMs: number;
  private readonly maxSessions: number;
  private readonly totalBufferBytes: number;
  private readonly minEmptyPollMs: number;
  private readonly timer: NodeJS.Timeout;
  private sessions = new Map<string, Session>();
  private closed = false;
  constructor(options: TerminalManagerOptions = {}) {
    this.shell = options.shell ?? resolveShell();
    this.bufferBytes =
      options.bufferBytes ?? MEMORY_DEFAULTS.terminal_buffer_mib * MiB;
    this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
    this.maxSessions =
      options.maxSessions ?? MEMORY_DEFAULTS.terminal_max_sessions;
    this.minEmptyPollMs = options.minEmptyPollMs ?? EMPTY_POLL_MIN_MS;
    const total =
      options.totalBufferBytes ??
      MEMORY_DEFAULTS.terminal_total_buffer_mib * MiB;
    if (
      !Number.isSafeInteger(this.bufferBytes) ||
      this.bufferBytes < 64 ||
      !Number.isFinite(this.idleMs) ||
      this.idleMs <= 0 ||
      !Number.isSafeInteger(this.maxSessions) ||
      this.maxSessions < 1 ||
      !Number.isSafeInteger(total) ||
      total < 1 ||
      !Number.isSafeInteger(this.minEmptyPollMs) ||
      this.minEmptyPollMs < 0 ||
      this.minEmptyPollMs > 300_000
    )
      throw new Error(
        "The terminal buffer size, session limit, total buffer budget, empty read window, or idle retention time is not valid.",
      );
    this.totalBufferBytes = Math.max(total, this.bufferBytes);
    this.timer = setInterval(() => this.sweep(), Math.min(this.idleMs, 60_000));
    this.timer.unref();
  }

  getActiveSessions(): {
    id: string;
    command: string;
    cwd: string;
    owner?: string | undefined;
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
      command: s.command,
      cwd: s.cwd,
      ...(s.owner === undefined ? {} : { owner: s.owner }),
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
    owner?: string,
  ): Promise<TerminalResult> {
    this.requireOpen();
    throwIfAborted(signal);
    const cwd = await realpath(resolveUserPath(input.workdir ?? base, base));
    if (!(await stat(cwd)).isDirectory())
      throw new Error(
        "workdir must be an existing directory. Change workdir and run the command again.",
      );
    this.requireOpen();
    throwIfAborted(signal);
    const selected = resolveCommandShell(this.shell, input, cwd);
    const shell = shellInvocation(input.cmd, selected);
    this.admit();
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
      command: inputPreview("cmd", input.cmd),
      cwd,
      ...(owner === undefined ? {} : { owner }),
      buffer: new RollingOutputBuffer(this.bufferBytes),
      touched: Date.now(),
      observers: 1,
      mutex: new AsyncMutex(),
      done,
      finish,
      stderrBytes: 0,
    };
    this.sessions.set(session.id, session);
    const ended = (code: number): void => {
      if (session.exitCode !== undefined) return;
      session.exitCode = code;
      session.touched = Date.now();
      session.finish(code);
      session.exitReady?.();
    };
    if (backend.kind === "pipe") {
      const child = backend.process;
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (text: string) => this.append(session, text));
      child.stderr.on("data", (text: string) => {
        session.stderrBytes = Math.min(
          Number.MAX_SAFE_INTEGER,
          session.stderrBytes + Buffer.byteLength(text),
        );
        this.append(session, text);
      });
      child.stdin.on("error", () => {
        /* Write callbacks report EPIPE; never crash on a closed pipe. */
      });
      child.on("error", (error) => {
        this.append(session, `The process failed to start: ${error.message}\n`);
      });
      child.on("close", (code, signal) => ended(exitStatus(code, signal)));
    } else {
      backend.process.onData((text) => this.append(session, text));
      backend.process.onExit((event) =>
        ended(exitStatus(event.exitCode, event.signal)),
      );
    }
    const started = performance.now();
    try {
      await waitUntil(done, input.yield_time_ms ?? 10_000, signal);
      return this.collect(session, started);
    } catch (error) {
      await this.terminate(session);
      this.remove(session);
      throw new Error(
        "The wait was cancelled after the command started. The process was asked to stop; effects that already happened are not undone.",
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
      throw new Error(
        `Unknown terminal session: ${input.session_id}. Its output was already read to the end, or the session was released after idle retention or under the terminal memory limits. Use exec_command to run the command again only if repeating it is safe.`,
      );
    const started = performance.now();
    const timeoutMs = stdinYieldTime(input, this.minEmptyPollMs);
    session.touched = Date.now();
    session.observers++;
    try {
      if (input.terminate) await this.terminate(session);
      return await session.mutex.run(async () => {
        throwIfAborted(signal);
        if (!this.sessions.has(session.id))
          throw new Error(
            "Another call already read the final output of this terminal session.",
          );
        const { backend } = session;
        if (input.cols !== undefined && input.rows !== undefined) {
          if (backend.kind !== "pty")
            throw new Error(
              "Only PTY sessions (started with tty=true) can be resized. Omit cols and rows for this session.",
            );
          backend.process.resize(input.cols, input.rows);
        }
        if (input.close_stdin && backend.kind === "pty")
          throw new Error(
            "close_stdin is not supported for PTY sessions. Send the end-of-input character that the program expects in chars instead, for example \\u0004 (Ctrl-D).",
          );
        if (input.chars || input.close_stdin) {
          if (session.exitCode !== undefined)
            throw new Error(
              "The process already exited and cannot receive input. Omit chars and close_stdin to read the remaining output.",
            );
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
        if (session.exitCode === undefined) {
          try {
            // Only process exit wakes this removable observer; logs just enter the bounded buffer.
            // Avoid attaching to session.done on every timed poll of a long-lived process.
            await waitUntil(
              new Promise<void>((resolve) => {
                session.exitReady = resolve;
              }),
              // Like Codex, collect after the write/resize and session lock;
              // input backpressure must not consume the output collection window.
              timeoutMs,
              signal,
            );
          } finally {
            delete session.exitReady;
          }
        }
        throwIfAborted(signal);
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
      throw new AggregateError(
        failures,
        "Could not stop all owned terminal processes.",
      );
  }
  private environment(): Record<string, string> {
    return inheritedEnvironment();
  }
  private append(session: Session, text: string): void {
    if (!this.sessions.has(session.id)) return;
    session.buffer.append(text);
    this.enforceBudget(session);
  }
  private retainedBytes(): number {
    let total = 0;
    for (const session of this.sessions.values()) total += session.buffer.bytes;
    return total;
  }
  /** Finished sessions that no call is reading, oldest first. */
  private releasable(): Session[] {
    return [...this.sessions.values()]
      .filter((session) => session.exitCode !== undefined && !session.observers)
      .sort((left, right) => left.touched - right.touched);
  }
  /** Make room for one more session, releasing finished unread sessions first. */
  private admit(): void {
    const full = () =>
      this.sessions.size >= this.maxSessions ||
      this.retainedBytes() >= this.totalBufferBytes;
    for (const session of full() ? this.releasable() : []) {
      if (!full()) break;
      this.remove(session);
    }
    if (this.sessions.size >= this.maxSessions)
      throw new Error(
        `${this.sessions.size} terminal sessions are open, which is the limit (memory.terminal_max_sessions). Read the output of finished sessions with write_stdin, stop sessions you no longer need with write_stdin and terminate=true, then run the command again.`,
      );
    if (this.retainedBytes() >= this.totalBufferBytes)
      throw new Error(
        `Running terminal sessions hold ${Math.ceil(this.totalBufferBytes / MiB)} MiB of unread output, which is the limit (memory.terminal_total_buffer_mib). Read their output with write_stdin, or stop sessions you no longer need with write_stdin and terminate=true, then run the command again.`,
      );
  }
  /**
   * Keep all unread output within the shared budget: release finished unread
   * sessions first, then drop the oldest unread output of running sessions,
   * starting with the session that produced the new output.
   */
  private enforceBudget(source: Session): void {
    let excess = this.retainedBytes() - this.totalBufferBytes;
    if (excess <= 0) return;
    for (const session of this.releasable()) {
      if (excess <= 0) return;
      if (session === source) continue;
      excess -= session.buffer.bytes;
      this.remove(session);
    }
    if (excess <= 0) return;
    excess -= source.buffer.shed(excess);
    const others = [...this.sessions.values()]
      .filter((session) => session !== source)
      .sort((left, right) => left.touched - right.touched);
    for (const session of others) {
      if (excess <= 0) return;
      excess -= session.buffer.shed(excess);
    }
  }
  private collect(session: Session, started: number): TerminalResult {
    session.touched = Date.now();
    const result: TerminalResult = {
      ...session.buffer.read(TERMINAL_READ_BYTES),
      wall_time_seconds: (performance.now() - started) / 1000,
      ...(session.stderrBytes ? { stderr_bytes: session.stderrBytes } : {}),
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
      const stopped =
        pid !== undefined
          ? await terminateProcessTree(pid, session.done)
          : (await waitUntil(session.done, 3000)) !== undefined;
      if (!stopped)
        throw new Error("Could not confirm that the process tree stopped.");
    })();
    return session.terminating;
  }
  private remove(session: Session): void {
    if (!this.sessions.delete(session.id)) return;
    session.buffer.clear();
  }
  private requireOpen(): void {
    if (this.closed) throw new Error("The terminal manager is closed.");
  }
}

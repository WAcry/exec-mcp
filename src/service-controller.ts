import { startServer } from "./server.js";
import type { Config } from "./config.js";
import { ConfigEditor } from "./web/config-edit.js";
import { effectiveWebConfig } from "./web/config.js";
import type { ServiceState } from "./web/api-types.js";
import type { DownstreamStartupEvent } from "./downstream/registry.js";

type RunningServer = Awaited<ReturnType<typeof startServer>>;
export class ServiceController {
  current: { server: RunningServer; config: Config; revision: string };
  state: ServiceState = "ready";
  error: string | undefined;
  generation = 1;
  private operation: Promise<void> | undefined;
  private readonly abort = new AbortController();
  private readonly listeners = new Set<() => void>();
  private closed = false;
  constructor(
    readonly editor: ConfigEditor,
    initial: { server: RunningServer; config: Config; revision: string },
    private readonly options: {
      onReady?: () => Promise<void>;
      onProgress?: (event: DownstreamStartupEvent) => void;
    } = {},
  ) {
    this.current = initial;
  }

  /** Runs after every state change, with `current` already updated. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* Observers never change the restart. */
      }
    }
  }

  restart(): Promise<void> {
    if (this.closed)
      return Promise.reject(new Error("The service is stopped."));
    if (this.operation) return this.operation;
    this.state = "restarting";
    this.error = undefined;
    this.notify();
    this.operation = this.replace()
      .catch((error) => {
        if (!this.closed) {
          this.state = "error";
          this.error =
            error instanceof Error
              ? error.message
              : "The restart failed. Check the terminal output and the configuration.";
          this.notify();
        }
        throw error;
      })
      .finally(() => {
        this.operation = undefined;
      });
    return this.operation;
  }
  private async replace(): Promise<void> {
    const next = await this.editor.read(); // Bad TOML does not shut down the working runtime.
    this.abort.signal.throwIfAborted();
    const previous = this.current.server;
    await previous.close();
    this.abort.signal.throwIfAborted();
    // Call history, conversation messages, and protocol counts belong to the
    // process, so open timelines keep their calls across a restart.
    const { activity, notes } = previous.runtime;
    if (effectiveWebConfig(next.config.web).enabled) activity.enable();
    else activity.disable();
    const server = await startServer(next.config, {
      activity,
      notes,
      protocol: previous.protocol,
      signal: this.abort.signal,
      ...(this.options.onProgress
        ? { onDownstreamProgress: this.options.onProgress }
        : {}),
    });
    if (this.closed) {
      await server.close();
      return;
    }
    this.current = { server, config: next.config, revision: next.revision };
    this.generation++;
    this.state = "ready";
    this.notify();
    await this.options.onReady?.();
  }
  async close(): Promise<void> {
    this.closed = true;
    this.state = "stopped";
    this.notify();
    this.abort.abort();
    await this.operation?.catch(() => undefined);
    await this.current.server.close();
  }
}

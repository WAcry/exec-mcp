import { startServer } from "./server.js";
import type { Config } from "./config.js";
import { ConfigEditor } from "./web/config-edit.js";
import { ActivityStore } from "./web/activity.js";
import { effectiveWebConfig } from "./web/config.js";
import type { DownstreamStartupEvent } from "./downstream/registry.js";

type RunningServer = Awaited<ReturnType<typeof startServer>>;
export class ServiceController {
  current: { server: RunningServer; config: Config; revision: string };
  state: "ready" | "restarting" | "error" | "stopped" = "ready";
  error: string | undefined;
  generation = 1;
  private operation: Promise<void> | undefined;
  private readonly abort = new AbortController();
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

  restart(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("服务已停止。"));
    if (this.operation) return this.operation;
    this.state = "restarting";
    this.error = undefined;
    this.operation = this.replace()
      .catch((error) => {
        if (!this.closed) {
          this.state = "error";
          this.error =
            error instanceof Error
              ? error.message
              : "重启失败；请检查终端和配置。";
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
    await this.current.server.close();
    this.abort.signal.throwIfAborted();
    const activity = new ActivityStore({
      enabled: effectiveWebConfig(next.config.web).enabled,
    });
    const server = await startServer(next.config, {
      activity,
      notes: this.current.server.runtime.notes,
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
    await this.options.onReady?.();
  }
  async close(): Promise<void> {
    this.closed = true;
    this.state = "stopped";
    this.abort.abort();
    await this.operation?.catch(() => undefined);
    await this.current.server.close();
  }
}

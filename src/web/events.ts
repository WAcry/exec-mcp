import type { ServerResponse } from "node:http";

export class SseBroker {
  private clients = new Set<ServerResponse>();
  private heartbeatTimer?: NodeJS.Timeout | undefined;
  private readonly maxClients: number;

  constructor(options: { maxClients?: number } = {}) {
    this.maxClients = options.maxClients ?? 16;
    this.heartbeatTimer = setInterval(() => {
      this.ping();
    }, 15_000);
    this.heartbeatTimer.unref();
  }

  addClient(res: ServerResponse): boolean {
    if (this.clients.size >= this.maxClients) return false;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    if (
      !res.write(
        `data: ${JSON.stringify({ type: "connected", timestamp: new Date().toISOString() })}\n\n`,
      )
    ) {
      res.end();
      return true;
    }

    this.clients.add(res);

    res.on("close", () => {
      this.clients.delete(res);
    });
    return true;
  }

  broadcast(event: unknown): void {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of this.clients) {
      try {
        if (!client.write(payload)) {
          this.clients.delete(client);
          client.end();
        }
      } catch {
        this.clients.delete(client);
      }
    }
  }

  private ping(): void {
    for (const client of this.clients) {
      try {
        if (!client.write(": ping\n\n")) {
          this.clients.delete(client);
          client.end();
        }
      } catch {
        this.clients.delete(client);
      }
    }
  }

  disconnectClients(): void {
    for (const client of this.clients) {
      try {
        client.end();
      } catch {
        /* Ignore an already closed response. */
      }
    }
    this.clients.clear();
  }

  close(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    this.disconnectClients();
  }
}

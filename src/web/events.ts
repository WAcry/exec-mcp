import type { ServerResponse } from "node:http";

export class SseBroker {
  private clients = new Set<ServerResponse>();
  private heartbeatTimer?: NodeJS.Timeout | undefined;

  constructor() {
    this.heartbeatTimer = setInterval(() => {
      this.ping();
    }, 15_000);
    this.heartbeatTimer.unref();
  }

  addClient(res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
      "X-Accel-Buffering": "no",
    });

    res.write(
      `data: ${JSON.stringify({ type: "connected", timestamp: new Date().toISOString() })}\n\n`,
    );

    this.clients.add(res);

    res.on("close", () => {
      this.clients.delete(res);
    });
  }

  broadcast(event: unknown): void {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of this.clients) {
      try {
        client.write(payload);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  private ping(): void {
    for (const client of this.clients) {
      try {
        client.write(": ping\n\n");
      } catch {
        this.clients.delete(client);
      }
    }
  }

  close(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    for (const client of this.clients) {
      try {
        client.end();
      } catch {
        /* Ignore */
      }
    }
    this.clients.clear();
  }
}

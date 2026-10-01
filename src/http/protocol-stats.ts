import type { ProtocolStats } from "../web/api-types.js";

/** MCP wire traffic since the process started. A restart of the execution service keeps it. */
export class ProtocolCounter {
  readonly #since = new Date().toISOString();
  #legacyRequests = 0;
  #legacySessions = 0;
  #openSessions = 0;
  #legacyLast: number | undefined;
  #modernRequests = 0;
  #modernLast: number | undefined;

  request(era: "legacy" | "modern"): void {
    if (era === "legacy") {
      this.#legacyRequests++;
      this.#legacyLast = Date.now();
    } else {
      this.#modernRequests++;
      this.#modernLast = Date.now();
    }
  }

  sessionOpened(): void {
    this.#legacySessions++;
    this.#openSessions++;
  }

  sessionClosed(): void {
    this.#openSessions = Math.max(0, this.#openSessions - 1);
  }

  snapshot(): ProtocolStats {
    const at = (value: number | undefined) =>
      value === undefined
        ? {}
        : { lastRequestAt: new Date(value).toISOString() };
    return {
      since: this.#since,
      legacy: {
        requests: this.#legacyRequests,
        sessions: this.#legacySessions,
        openSessions: this.#openSessions,
        ...at(this.#legacyLast),
      },
      modern: { requests: this.#modernRequests, ...at(this.#modernLast) },
    };
  }
}

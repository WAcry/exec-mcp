import { randomUUID } from "node:crypto";
import {
  McpServer,
  WebStandardStreamableHTTPServerTransport,
  type McpHandlerRequestOptions,
  type RequestId,
} from "@modelcontextprotocol/server";

interface LegacySession {
  readonly server: McpServer;
  readonly transport: WebStandardStreamableHTTPServerTransport;
  activeResponses: number;
  lastUsedAt: number;
  closePromise?: Promise<void>;
}

/** Keeps 2025 protocol requests on one transport so cancellation reaches the active call. */
export class LegacySessionRouter {
  readonly #all = new Set<LegacySession>();
  readonly #factory: () => McpServer;
  readonly #idleMs: number;
  readonly #onError: (error: Error) => void;
  readonly #sessions = new Map<string, LegacySession>();
  readonly #sweepTimer: NodeJS.Timeout;
  #closed = false;

  constructor(
    factory: () => McpServer,
    onError: (error: Error) => void,
    options: { idleMs: number; sweepMs: number },
  ) {
    assertPositiveSafeInteger(options.idleMs, "legacySessionIdleMs");
    assertPositiveSafeInteger(options.sweepMs, "legacySessionSweepMs");
    this.#factory = factory;
    this.#idleMs = options.idleMs;
    this.#onError = onError;
    this.#sweepTimer = setInterval(() => this.#sweep(), options.sweepMs);
    this.#sweepTimer.unref();
  }

  async fetch(
    request: Request,
    options: McpHandlerRequestOptions | undefined,
  ): Promise<Response> {
    if (this.#closed)
      return legacySessionError(503, -32_603, "Server is shutting down");
    const sessionId = request.headers.get("mcp-session-id");
    if (sessionId !== null) {
      const session = this.#sessions.get(sessionId);
      if (session === undefined)
        return legacySessionError(404, -32_001, "Session not found");
      return this.#handleSessionRequest(session, request, options);
    }

    const session = this.#createSession();
    try {
      await session.server.connect(session.transport);
      const response = await this.#handleSessionRequest(
        session,
        request,
        options,
      );
      if (session.transport.sessionId === undefined)
        await this.#closeSession(session);
      return response;
    } catch (error) {
      await this.#closeSession(session);
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#sweepTimer);
    await Promise.allSettled(
      [...this.#all].map(async (session) => this.#closeSession(session)),
    );
  }

  #createSession(): LegacySession {
    let session!: LegacySession;
    const transport = new WebStandardStreamableHTTPServerTransport({
      keepAliveMs: 15_000,
      sessionIdGenerator: () => this.#newSessionId(),
      onsessioninitialized: (sessionId) => {
        if (this.#closed) throw new Error("exec-mcp is shutting down");
        if (this.#sessions.has(sessionId))
          throw new Error("MCP session ID collision");
        this.#sessions.set(sessionId, session);
      },
      onsessionclosed: (sessionId) => {
        if (this.#sessions.get(sessionId) === session)
          this.#sessions.delete(sessionId);
        queueMicrotask(() => {
          void this.#closeSession(session).catch((error: unknown) =>
            this.#report(error),
          );
        });
      },
    });
    session = {
      server: this.#factory(),
      transport,
      activeResponses: 0,
      lastUsedAt: Date.now(),
    };
    this.#all.add(session);
    return session;
  }

  async #handleSessionRequest(
    session: LegacySession,
    request: Request,
    options: McpHandlerRequestOptions | undefined,
  ): Promise<Response> {
    const inspection = await inspectLegacyRequest(request, options?.parsedBody);
    if (inspection.holdsSession) session.activeResponses += 1;
    session.lastUsedAt = Date.now();
    try {
      const response = await session.transport.handleRequest(
        request,
        legacyRequestOptions(options),
      );
      for (const requestId of inspection.cancelledIds) {
        session.transport.closeSSEStream(requestId);
      }
      if (!inspection.holdsSession) {
        session.lastUsedAt = Date.now();
        return response;
      }
      return trackLegacyResponse(response, () => {
        session.activeResponses -= 1;
        session.lastUsedAt = Date.now();
      });
    } catch (error) {
      if (inspection.holdsSession) session.activeResponses -= 1;
      session.lastUsedAt = Date.now();
      throw error;
    }
  }

  #newSessionId(): string {
    let value: string;
    do value = randomUUID();
    while (this.#sessions.has(value));
    return value;
  }

  #closeSession(session: LegacySession): Promise<void> {
    session.closePromise ??= (async () => {
      this.#all.delete(session);
      const sessionId = session.transport.sessionId;
      if (
        sessionId !== undefined &&
        this.#sessions.get(sessionId) === session
      ) {
        this.#sessions.delete(sessionId);
      }
      await session.server.close();
    })();
    return session.closePromise;
  }

  #sweep(): void {
    if (this.#closed) return;
    const deadline = Date.now() - this.#idleMs;
    for (const session of this.#all) {
      if (session.activeResponses !== 0 || session.lastUsedAt > deadline)
        continue;
      void this.#closeSession(session).catch((error: unknown) =>
        this.#report(error),
      );
    }
  }

  #report(value: unknown): void {
    try {
      this.#onError(value instanceof Error ? value : new Error(String(value)));
    } catch {
      // Session cleanup must not depend on observability.
    }
  }
}

async function inspectLegacyRequest(
  request: Request,
  parsedBody: unknown,
): Promise<{ cancelledIds: RequestId[]; holdsSession: boolean }> {
  if (request.method.toUpperCase() !== "POST") {
    return { cancelledIds: [], holdsSession: false };
  }
  let body = parsedBody;
  if (body === undefined) {
    try {
      body = await request.clone().json();
    } catch {
      return { cancelledIds: [], holdsSession: false };
    }
  }
  const messages = Array.isArray(body) ? body : [body];
  const ids: RequestId[] = [];
  let holdsSession = false;
  for (const message of messages) {
    if (!isRecord(message)) continue;
    if (typeof message.id === "string" || typeof message.id === "number")
      holdsSession = true;
    if (message.method === "notifications/cancelled") {
      const params = message.params;
      if (!isRecord(params)) continue;
      const requestId = params.requestId;
      if (typeof requestId === "string" || typeof requestId === "number")
        ids.push(requestId);
    }
  }
  return { cancelledIds: ids, holdsSession };
}

function trackLegacyResponse(
  response: Response,
  release: () => void,
): Response {
  if (response.body === null) {
    release();
    return response;
  }
  const reader = response.body.getReader();
  let released = false;
  const finish = (): void => {
    if (released) return;
    released = true;
    release();
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          finish();
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        finish();
        controller.error(error);
      }
    },
    async cancel(reason) {
      finish();
      await reader.cancel(reason).catch(() => undefined);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function legacyRequestOptions(options: McpHandlerRequestOptions | undefined): {
  authInfo?: NonNullable<McpHandlerRequestOptions["authInfo"]>;
  parsedBody?: unknown;
} {
  return {
    ...(options?.authInfo === undefined ? {} : { authInfo: options.authInfo }),
    ...(options?.parsedBody === undefined
      ? {}
      : { parsedBody: options.parsedBody }),
  };
}

function legacySessionError(
  status: number,
  code: number,
  message: string,
): Response {
  return Response.json(
    {
      jsonrpc: "2.0",
      id: null,
      error: { code, message },
    },
    { status },
  );
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

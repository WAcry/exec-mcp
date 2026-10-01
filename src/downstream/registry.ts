import { isDeepStrictEqual } from "node:util";

import {
  Client,
  type CallToolResult,
  type Implementation,
  type Tool,
  type Transport,
  type RequestOptions,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { captureProcessTree } from "../host/platform.js";
import { EnvironmentHttpClient } from "../network/http.js";

import type { DownstreamTool, JsonObject } from "../types.js";
import { abortError, throwIfAborted } from "../util.js";
import { VERSION } from "../version.js";
import type { DownstreamMcpServerConfig } from "./config.js";
import {
  definitelyNotSent,
  disconnectedReason,
  notSentError,
  positiveInteger,
  requestFailure,
  SetupError,
  setupError,
  shouldDiscardConnection,
  type DownstreamOperation,
} from "./errors.js";
import {
  listResourceCatalog,
  ResourceError,
  resourceResultBytes,
  type ResourceListInput,
  type ResourceReadInput,
} from "./resources.js";
import { decodeDownstreamToolId, describeTools } from "./tool-id.js";
import { createTransport } from "./transport.js";

type Environment = Readonly<Record<string, string | undefined>>;

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_TOOL_TIMEOUT_MS = 120_000;
const MAX_LIST_PAGES = 100;
const CANCELLED = "The downstream MCP operation was cancelled.";

export interface DownstreamMcpRegistryOptions {
  readonly servers: readonly DownstreamMcpServerConfig[];
  readonly connectTimeoutMs?: number;
  readonly toolTimeoutMs?: number;
  readonly env?: Environment;
  readonly clientInfo?: Implementation;
}

export interface DownstreamStartupEvent {
  server: string;
  status: "connecting" | "ready" | "error";
  tools?: number;
  message?: string;
}

interface ServerState {
  readonly config: DownstreamMcpServerConfig;
  readonly client: Client;
  readonly transport: Transport;
  serverVersion?: Implementation;
  namespaceInstructions?: string;
  tools: ReadonlyMap<string, DownstreamTool>;
  lastRefreshError?: string;
  refreshTail: Promise<void>;
  connected: boolean;
  stale: boolean;
  activeCalls: number;
  closePromise?: Promise<void>;
}

/**
 * Owns one official MCP client per configured downstream server: connection,
 * catalog, reconnection, and shutdown.
 *
 * A request that may have reached the server is never retried, because it can
 * have side effects. Only a request that provably did not reach it (not
 * connected, or an expired HTTP session) is sent once more after reconnecting.
 */
export class DownstreamMcpRegistry {
  private readonly definitions: ReadonlyMap<string, DownstreamMcpServerConfig>;
  private readonly connectTimeoutMs: number;
  private readonly toolTimeoutMs: number;
  private readonly env: Environment;
  private http: EnvironmentHttpClient | undefined;
  private readonly clientInfo: Implementation;
  private readonly connecting = new Map<string, Promise<ServerState>>();
  private readonly ready = new Map<string, ServerState>();
  private readonly allStates = new Set<ServerState>();
  // Last verified contracts remain bindable across disconnects. Calls still
  // reconnect and validate the live contract before sending any operation.
  private readonly catalogs = new Map<
    string,
    ReadonlyMap<string, DownstreamTool>
  >();
  private readonly errors = new Map<string, string>();
  private readonly lifecycleAbort = new AbortController();
  private closePromise?: Promise<void>;
  private closed = false;

  public constructor(options: DownstreamMcpRegistryOptions) {
    this.connectTimeoutMs = positiveInteger(
      options.connectTimeoutMs,
      DEFAULT_CONNECT_TIMEOUT_MS,
      "connectTimeoutMs",
    );
    this.toolTimeoutMs = positiveInteger(
      options.toolTimeoutMs,
      DEFAULT_TOOL_TIMEOUT_MS,
      "toolTimeoutMs",
    );
    this.env = options.env ?? process.env;
    this.clientInfo = options.clientInfo ?? {
      name: "exec-mcp",
      title: "exec-mcp downstream broker",
      version: VERSION,
    };

    const definitions = new Map<string, DownstreamMcpServerConfig>();
    for (const definition of options.servers) {
      if (definitions.has(definition.name)) {
        throw new Error(
          `Two downstream MCP servers have the name ${JSON.stringify(definition.name)}.`,
        );
      }
      definitions.set(definition.name, definition);
    }
    this.definitions = definitions;
  }

  public async initialize(
    signal?: AbortSignal,
    onProgress?: (event: DownstreamStartupEvent) => void,
  ): Promise<void> {
    this.assertOpen();
    throwIfAborted(signal);
    const notify = (event: DownstreamStartupEvent) => {
      try {
        onProgress?.(event);
      } catch {
        /* Diagnostics must not alter startup. */
      }
    };
    const failed: string[] = [];
    await Promise.all(
      [...this.definitions.keys()].map(async (serverId) => {
        notify({ server: serverId, status: "connecting" });
        try {
          const state = await this.ensureServer(serverId, signal);
          if (!state.connected || state.stale || state.lastRefreshError)
            throw new Error("catalog unavailable");
          notify({
            server: serverId,
            status: "ready",
            tools: state.tools.size,
          });
        } catch (error) {
          if (signal?.aborted || this.lifecycleAbort.signal.aborted)
            throw abortError(CANCELLED);
          const message = setupError(serverId, "connect", error).message;
          failed.push(message);
          notify({ server: serverId, status: "error", message });
        }
      }),
    );
    this.assertOpen();
    throwIfAborted(signal);
    if (failed.length)
      throw new Error(
        `Downstream MCP servers failed to start, so exec-mcp is not ready:\n${failed.sort().join("\n")}\nSign in or fix the configuration on this machine, then restart exec-mcp. Set enabled=false for servers you do not use.`,
      );
    // A server could disconnect while a slower sibling was still initializing.
    for (const name of this.definitions.keys())
      if (!this.ready.has(name))
        throw new SetupError(
          `Downstream MCP server ${JSON.stringify(name)}: the connection closed during startup. Check the server's diagnostics in the exec-mcp log, then restart exec-mcp.`,
        );
  }

  /** Last verified contracts of every server, sorted by tool ID. */
  public bindingSnapshot(): readonly DownstreamTool[] {
    return [...this.catalogs.values()]
      .flatMap((tools) => [...tools.values()])
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  /** The recorded reason for each server that is not ready. */
  public catalogErrors(): Record<string, string> {
    return Object.fromEntries(this.errors);
  }

  public async callTool(
    toolId: string,
    args: JsonObject = {},
    signal?: AbortSignal,
    timeoutMs?: number,
    expected?: Tool,
  ): Promise<CallToolResult> {
    this.assertOpen();
    throwIfAborted(signal);
    const { serverId, toolName } = decodeDownstreamToolId(toolId);
    for (let attempt = 0; ; attempt++) {
      const timeout = positiveInteger(
        timeoutMs,
        this.definitions.get(serverId)?.toolTimeoutMs ?? this.toolTimeoutMs,
        "timeoutMs",
      );
      const operation: DownstreamOperation = {
        server: serverId,
        method: "tools/call",
        target: toolName,
        mutating: true,
        timeoutMs: timeout,
      };
      const state = await this.prepare(operation, signal, true);
      const descriptor = state.tools.get(toolName);
      if (descriptor === undefined || descriptor.id !== toolId) {
        throw new Error(
          `Tool ${JSON.stringify(toolName)} is no longer in the catalog of downstream MCP server ${JSON.stringify(serverId)}. The request was not sent. Read ALL_TOOLS again in a new exec call.`,
        );
      }
      if (
        state.lastRefreshError !== undefined ||
        (expected !== undefined &&
          !isDeepStrictEqual(expected, descriptor.tool))
      ) {
        throw new Error(
          `The contract of tool ${JSON.stringify(toolName)} on downstream MCP server ${JSON.stringify(serverId)} changed or could not be confirmed. The request was not sent. Read the current contract from ALL_TOOLS in a new exec call.`,
        );
      }
      state.activeCalls += 1;
      try {
        return await state.client.callTool(
          { name: toolName, arguments: args },
          {
            signal: combinedSignal(this.lifecycleAbort.signal, signal),
            timeout,
            maxTotalTimeout: timeout,
            toolDefinition: descriptor.tool,
          },
        );
      } catch (error) {
        if (signal?.aborted === true || this.lifecycleAbort.signal.aborted) {
          throw abortError(
            "The call was cancelled after the request was sent. The tool may have done part or all of its work; check its effects before you call again.",
          );
        }
        const unsent = definitelyNotSent(error, state.transport);
        if (unsent || shouldDiscardConnection(error, state.transport))
          this.markStale(state);
        // The server never saw this request, so one resend cannot repeat work.
        if (unsent && attempt === 0) continue;
        throw requestFailure(operation, error, { sent: !unsent });
      } finally {
        state.activeCalls -= 1;
        if (state.stale && state.activeCalls === 0) void this.closeState(state);
      }
    }
  }

  public async close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.closed = true;
    this.lifecycleAbort.abort(new Error("Downstream MCP registry closed"));
    this.closePromise = this.finishClose();
    return this.closePromise;
  }

  public listResources(input: ResourceListInput, signal?: AbortSignal) {
    this.assertOpen();
    throwIfAborted(signal);
    return listResourceCatalog(
      "resources",
      input,
      [...this.definitions.keys()],
      (server, operation) =>
        this.resourceOperation(server, "resources/list", operation, signal),
    );
  }

  public listResourceTemplates(input: ResourceListInput, signal?: AbortSignal) {
    this.assertOpen();
    throwIfAborted(signal);
    return listResourceCatalog(
      "resourceTemplates",
      input,
      [...this.definitions.keys()],
      (server, operation) =>
        this.resourceOperation(
          server,
          "resources/templates/list",
          operation,
          signal,
        ),
    );
  }

  public readResource(input: ResourceReadInput, signal?: AbortSignal) {
    return this.resourceOperation(
      input.server,
      "resources/read",
      async (client, options) => {
        if (!client.getServerCapabilities()?.resources)
          throw new ResourceError(
            `Downstream MCP server ${JSON.stringify(input.server)} does not offer resources. Use its tools instead.`,
          );
        const { _meta: _private, ...result } = await client.readResource(
          { uri: input.uri },
          { ...options, cacheMode: "bypass" },
        );
        const value = { ...result, server: input.server, uri: input.uri };
        resourceResultBytes(value);
        return value;
      },
      signal,
      input.uri,
    );
  }

  /** Resource RPCs share the configured connection, credentials and cancellation
   * lifetime. They never fall back to local files or a separate HTTP fetch.
   */
  private async resourceOperation<T>(
    server: string,
    method: string,
    operation: (client: Client, options: RequestOptions) => Promise<T>,
    signal?: AbortSignal,
    target?: string,
  ): Promise<T> {
    this.assertOpen();
    throwIfAborted(signal);
    const definition = this.definitions.get(server);
    if (definition === undefined)
      throw new ResourceError(
        `Unknown or disabled downstream MCP server: ${JSON.stringify(server)}. Use a server name from the list results.`,
      );
    const timeout = definition.toolTimeoutMs ?? this.toolTimeoutMs;
    const request: DownstreamOperation = {
      server,
      method,
      ...(target === undefined ? {} : { target }),
      mutating: false,
      timeoutMs: timeout,
    };
    for (let attempt = 0; ; attempt++) {
      const state = await this.prepare(request, signal, false);
      const deadline = AbortSignal.timeout(timeout);
      const requestSignal = combinedSignal(
        this.lifecycleAbort.signal,
        signal,
        deadline,
      );
      state.activeCalls++;
      try {
        return await raceWithSignal(
          operation(state.client, {
            signal: requestSignal,
            timeout,
            maxTotalTimeout: timeout,
          }),
          requestSignal,
        );
      } catch (error) {
        if (signal?.aborted || this.lifecycleAbort.signal.aborted)
          throw abortError(
            "The downstream MCP resource request was cancelled.",
          );
        if (error instanceof ResourceError) throw error;
        const unsent = definitelyNotSent(error, state.transport);
        if (unsent || shouldDiscardConnection(error, state.transport))
          this.markStale(state);
        if (unsent && attempt === 0) continue;
        throw requestFailure(request, error, {
          sent: !unsent,
          timedOut: deadline.aborted,
        });
      } finally {
        state.activeCalls--;
        if (state.stale && state.activeCalls === 0) void this.closeState(state);
      }
    }
  }

  /**
   * Connect (or reconnect) before sending. Every failure here happens before
   * the request leaves this machine, so it reports the recorded reason.
   */
  private async prepare(
    operation: DownstreamOperation,
    signal: AbortSignal | undefined,
    catalog: boolean,
  ): Promise<ServerState> {
    try {
      const state = await this.ensureServer(operation.server, signal);
      if (catalog) {
        if (state.lastRefreshError !== undefined)
          await this.refreshTools(state, signal);
        await raceWithSignal(
          state.refreshTail,
          combinedSignal(this.lifecycleAbort.signal, signal),
        );
      }
      return state;
    } catch (error) {
      if (signal?.aborted || this.lifecycleAbort.signal.aborted)
        throw abortError(
          "The request was cancelled while the downstream connection was being prepared. It was not sent.",
        );
      throw notSentError(
        operation,
        error instanceof SetupError
          ? error.message
          : (this.errors.get(operation.server) ??
              setupError(operation.server, "connect", error).message),
      );
    }
  }

  private async finishClose(): Promise<void> {
    await Promise.allSettled([...this.connecting.values()]);
    await Promise.allSettled(
      [...this.allStates].map(async (state) => this.closeState(state)),
    );
    this.connecting.clear();
    this.ready.clear();
    this.allStates.clear();
    this.catalogs.clear();
    this.errors.clear();
    await this.http?.close();
  }

  private async ensureServer(
    serverId: string,
    signal?: AbortSignal,
  ): Promise<ServerState> {
    this.assertOpen();
    const definition = this.definitions.get(serverId);
    if (definition === undefined)
      throw new Error(
        `Unknown downstream MCP server: ${JSON.stringify(serverId)}.`,
      );

    let connection = this.connecting.get(serverId);
    if (connection === undefined) {
      connection = this.connectServer(definition);
      this.connecting.set(serverId, connection);
      void connection.catch(() => {
        if (this.connecting.get(serverId) === connection)
          this.connecting.delete(serverId);
      });
    }
    return await raceWithSignal(connection, signal);
  }

  private async connectServer(
    config: DownstreamMcpServerConfig,
  ): Promise<ServerState> {
    let state: ServerState | undefined;
    let attempt: Promise<void> | undefined;
    // One budget covers protocol negotiation, initialization and every list page.
    const connectTimeout = config.startupTimeoutMs ?? this.connectTimeoutMs;
    const deadline = AbortSignal.timeout(connectTimeout);
    try {
      positiveInteger(connectTimeout, connectTimeout, "startupTimeoutMs");
      const startupSignal = combinedSignal(
        this.lifecycleAbort.signal,
        deadline,
      );
      const client = new Client(this.clientInfo, {
        listMaxPages: MAX_LIST_PAGES,
        versionNegotiation: {
          mode: "auto",
          probe: { timeoutMs: connectTimeout },
        },
        // exec-mcp cannot complete a nested user-input round while it owns the
        // outer ChatGPT tool call. Surface input_required as a call failure.
        inputRequired: { autoFulfill: false },
        listChanged: {
          tools: {
            autoRefresh: false,
            debounceMs: 0,
            onChanged: () => {
              if (
                state === undefined ||
                !state.connected ||
                state.stale ||
                this.closed
              )
                return;
              void this.refreshTools(state).catch(() => undefined);
            },
          },
        },
      });
      const transport = createTransport(
        config,
        this.env,
        config.transport === "stdio"
          ? undefined
          : (this.http ??= new EnvironmentHttpClient(this.env)),
      );
      state = {
        config,
        client,
        transport,
        tools: new Map(),
        refreshTail: Promise.resolve(),
        connected: false,
        stale: false,
        activeCalls: 0,
      };
      const current = state;
      client.onclose = () => {
        if (current.connected && !current.stale) this.markStale(current);
      };
      this.allStates.add(state);

      attempt = client.connect(transport, {
        signal: startupSignal,
        timeout: connectTimeout,
        maxTotalTimeout: connectTimeout,
      });
      await raceWithSignal(attempt, startupSignal);
      state.connected = true;
      const serverVersion = client.getServerVersion();
      const instructions = client.getInstructions();
      if (serverVersion !== undefined) state.serverVersion = serverVersion;
      if (instructions !== undefined)
        state.namespaceInstructions = instructions;
      await this.refreshTools(state, startupSignal);
      if (this.closed) throw abortError(CANCELLED);
      if (state.stale) throw new Error("disconnected during startup");
      this.ready.set(config.name, state);
      this.errors.delete(config.name);
      return state;
    } catch (error) {
      if (state !== undefined) {
        this.markStale(state);
        await this.closeState(state);
      }
      // Await the SDK's negotiation cleanup, including its disposable stdio probe.
      await attempt?.catch(() => undefined);
      if (this.lifecycleAbort.signal.aborted) throw abortError(CANCELLED);
      const failure = setupError(
        config.name,
        "connect",
        deadline.aborted ? deadline.reason : error,
      );
      this.errors.set(config.name, failure.message);
      throw failure;
    }
  }

  private refreshTools(
    state: ServerState,
    signal?: AbortSignal,
  ): Promise<void> {
    const operation = state.refreshTail
      .catch(() => undefined)
      .then(async () => {
        if (state.stale || this.closed)
          throw new Error("Downstream MCP connection is closed");
        const timeout = state.config.startupTimeoutMs ?? this.connectTimeoutMs;
        const deadline = AbortSignal.timeout(timeout);
        const requestSignal = combinedSignal(
          this.lifecycleAbort.signal,
          signal,
          deadline,
        );
        try {
          // No cursor asks the v2 SDK to aggregate all pages. listMaxPages is
          // the convergence guard; cacheMode refresh avoids a stale TTL view.
          const values = state.client.getServerCapabilities()?.tools
            ? await listTools(state.client, requestSignal, timeout)
            : [];
          throwIfAborted(requestSignal);
          if (state.stale || this.closed)
            throw new Error("disconnected during catalog read");
          const next = describeTools(state, values);
          state.tools = next;
          this.catalogs.set(state.config.name, next);
          this.errors.delete(state.config.name);
          delete state.lastRefreshError;
        } catch (error) {
          if (signal?.aborted === true || this.lifecycleAbort.signal.aborted)
            throw error;
          state.lastRefreshError = setupError(
            state.config.name,
            "catalog",
            deadline.aborted ? deadline.reason : error,
          ).message;
          this.errors.set(state.config.name, state.lastRefreshError);
          if (shouldDiscardConnection(error, state.transport))
            this.markStale(state);
          throw error;
        }
      });
    state.refreshTail = operation;
    return operation;
  }

  private markStale(state: ServerState): void {
    if (state.stale) return;
    state.stale = true;
    state.connected = false;
    if (this.ready.get(state.config.name) === state) {
      this.ready.delete(state.config.name);
      this.connecting.delete(state.config.name);
    }
    this.errors.set(state.config.name, disconnectedReason(state.config.name));
    if (state.activeCalls === 0) void this.closeState(state);
  }

  private closeState(state: ServerState): Promise<void> {
    state.closePromise ??= (async () => {
      state.stale = true;
      state.connected = false;
      // The SDK stops only its direct stdio child. Record the child's
      // descendants first so wrappers such as npx cannot leave servers behind.
      const pid =
        state.transport instanceof StdioClientTransport
          ? state.transport.pid
          : null;
      const tree = pid ? await captureProcessTree(pid) : undefined;
      try {
        await state.client.close();
      } catch {
        // Transport ownership is independent of when Client.connect attaches it.
      }
      try {
        // During protocol probing client.close() can be a no-op. Always close
        // the transport too so the SDK cancels and reaps its sibling probe.
        await state.transport.close();
      } catch {
        // Shutdown is best effort after the transport has failed.
      }
      await tree?.reap();
      this.allStates.delete(state);
    })();
    return state.closePromise;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("The downstream MCP registry is closed.");
  }
}

async function listTools(
  client: Client,
  signal: AbortSignal,
  timeout: number,
): Promise<readonly Tool[]> {
  const listing = client.listTools(undefined, {
    cacheMode: "refresh",
    signal,
    timeout,
    maxTotalTimeout: timeout,
  });
  return (await raceWithSignal(listing, signal)).tools;
}

function combinedSignal(
  first: AbortSignal,
  second?: AbortSignal,
  third?: AbortSignal,
): AbortSignal {
  const signals = [first, second, third].filter(
    (value): value is AbortSignal => value !== undefined,
  );
  return signals.length === 1 ? first : AbortSignal.any(signals);
}

function raceWithSignal<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(abortError(CANCELLED));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError(CANCELLED));
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

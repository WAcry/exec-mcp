import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  Client,
  ProtocolError,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type Implementation,
  type Tool,
  type Transport,
} from "@modelcontextprotocol/client";
import {
  DEFAULT_INHERITED_ENV_VARS,
  StdioClientTransport,
} from "@modelcontextprotocol/client/stdio";

import type { DownstreamTool, JsonObject } from "../types.js";
import { VERSION } from "../version.js";
import type { DownstreamMcpServerConfig } from "./config.js";

type Environment = Readonly<Record<string, string | undefined>>;

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_TOOL_TIMEOUT_MS = 120_000;
const MAX_LIST_PAGES = 100;
const TOOL_ID_PREFIX = "mcp-id:v1:";
const MAX_CODE_NAME_LENGTH = 128;
const CODE_NAME_HASH_LENGTH = 12;

export interface DownstreamMcpRegistryOptions {
  readonly servers: readonly DownstreamMcpServerConfig[];
  readonly connectTimeoutMs?: number;
  readonly toolTimeoutMs?: number;
  readonly env?: Environment;
  readonly clientInfo?: Implementation;
}

export interface DownstreamMcpInventory {
  readonly tools: readonly DownstreamTool[];
  readonly errors: Readonly<Record<string, string>>;
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
 * Owns one official MCP client per configured downstream server.
 *
 * Tool calls are never retried. A thrown error can follow a downstream side
 * effect, so callers receive an explicit indeterminate-outcome message.
 */
export class DownstreamMcpRegistry {
  private readonly definitions: ReadonlyMap<string, DownstreamMcpServerConfig>;
  private readonly connectTimeoutMs: number;
  private readonly toolTimeoutMs: number;
  private readonly env: Environment;
  private readonly clientInfo: Implementation;
  private readonly connecting = new Map<string, Promise<ServerState>>();
  private readonly ready = new Map<string, ServerState>();
  private readonly allStates = new Set<ServerState>();
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
        throw new Error(`Duplicate downstream MCP server: ${definition.name}`);
      }
      definitions.set(definition.name, definition);
    }
    this.definitions = definitions;
  }

  public async inventory(
    signal?: AbortSignal,
  ): Promise<DownstreamMcpInventory> {
    this.assertOpen();
    throwIfAborted(signal);
    const errors: Record<string, string> = {};
    await Promise.all(
      [...this.definitions.keys()].map(async (serverId) => {
        try {
          const state = await this.ensureServer(serverId, signal);
          if (state.lastRefreshError !== undefined) {
            try {
              await this.refreshTools(state, signal);
            } catch {
              // Keep the last complete catalog and report the refresh failure.
            }
          }
          if (state.lastRefreshError !== undefined)
            errors[serverId] = state.lastRefreshError;
        } catch (error) {
          if (signal?.aborted === true || this.lifecycleAbort.signal.aborted) {
            throw abortError(
              signal?.reason ?? this.lifecycleAbort.signal.reason,
            );
          }
          errors[serverId] = safeServerError(serverId, "failed to connect");
          void error;
        }
      }),
    );

    return {
      tools: this.catalogSnapshot(),
      errors,
    };
  }

  public async listTools(
    signal?: AbortSignal,
  ): Promise<readonly DownstreamTool[]> {
    return (await this.inventory(signal)).tools;
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
    let state: ServerState;
    try {
      state = await this.ensureServer(serverId, signal);
      await raceWithSignal(
        state.refreshTail,
        combinedSignal(this.lifecycleAbort.signal, signal),
      );
    } catch {
      if (signal?.aborted || this.lifecycleAbort.signal.aborted) {
        throw abortError("下游连接准备已取消；未发送本次工具调用。");
      }
      throw new Error(
        `下游 ${serverId} 的连接或工具目录不可用；未发送本次调用，请重新发现。`,
      );
    }
    const descriptor = state.tools.get(toolName);
    if (descriptor === undefined || descriptor.id !== toolId) {
      throw new Error(
        `工具已移除或目录过期：${serverId}/${toolName}；请重新发现。`,
      );
    }

    if (
      state.lastRefreshError !== undefined ||
      (expected !== undefined && !isDeepStrictEqual(expected, descriptor.tool))
    ) {
      throw new Error(
        "工具契约已变更或无法确认；尚未发送，请重新搜索并在下一次 exec 调用。",
      );
    }
    const timeout = positiveInteger(
      timeoutMs,
      state.config.toolTimeoutMs ?? this.toolTimeoutMs,
      "timeoutMs",
    );
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
        const aborted = new Error(
          "下游 MCP 调用开始后被取消；操作可能已部分或全部生效，请先检查，不要自动重试。",
          { cause: signal?.reason ?? this.lifecycleAbort.signal.reason },
        );
        aborted.name = "AbortError";
        throw aborted;
      }
      if (shouldDiscardConnection(error, state.transport))
        this.markStale(state);
      throw new Error(
        `下游 MCP 调用失败：${serverId}/${toolName}；操作可能已部分或全部生效，未自动重试。`,
      );
    } finally {
      state.activeCalls -= 1;
      if (state.stale && state.activeCalls === 0) void this.closeState(state);
    }
  }

  public async close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.closed = true;
    this.lifecycleAbort.abort(new Error("Downstream MCP registry closed"));
    this.closePromise = this.finishClose();
    return this.closePromise;
  }

  private async finishClose(): Promise<void> {
    await Promise.allSettled([...this.connecting.values()]);
    await Promise.allSettled(
      [...this.allStates].map(async (state) => this.closeState(state)),
    );
    this.connecting.clear();
    this.ready.clear();
    this.allStates.clear();
  }

  private async ensureServer(
    serverId: string,
    signal?: AbortSignal,
  ): Promise<ServerState> {
    this.assertOpen();
    const definition = this.definitions.get(serverId);
    if (definition === undefined)
      throw new Error(`Unknown downstream MCP server: ${serverId}`);

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
    const connectTimeout = positiveInteger(
      config.startupTimeoutMs,
      this.connectTimeoutMs,
      "startupTimeoutMs",
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
    const transport = createTransport(config, this.env);
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
    client.onclose = () => {
      if (state !== undefined && state.connected && !state.stale)
        this.markStale(state);
    };
    this.allStates.add(state);

    try {
      await client.connect(transport, {
        signal: this.lifecycleAbort.signal,
        timeout: connectTimeout,
        maxTotalTimeout: connectTimeout,
      });
      state.connected = true;
      const serverVersion = client.getServerVersion();
      const instructions = client.getInstructions();
      if (serverVersion !== undefined) state.serverVersion = serverVersion;
      if (instructions !== undefined)
        state.namespaceInstructions = instructions;
      await this.refreshTools(state);
      if (this.closed) throw abortError(this.lifecycleAbort.signal.reason);
      this.ready.set(config.name, state);
      return state;
    } catch (error) {
      this.markStale(state);
      await this.closeState(state);
      if (this.lifecycleAbort.signal.aborted)
        throw abortError(this.lifecycleAbort.signal.reason);
      throw error;
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
        const timeout = positiveInteger(
          state.config.startupTimeoutMs,
          this.connectTimeoutMs,
          "startupTimeoutMs",
        );
        const deadline = AbortSignal.timeout(timeout);
        const requestSignal = combinedSignal(
          this.lifecycleAbort.signal,
          signal,
          deadline,
        );
        try {
          // No cursor asks the v2 SDK to aggregate all pages. listMaxPages is
          // the convergence guard; cacheMode refresh avoids a stale TTL view.
          const values = await listTools(state.client, requestSignal, timeout);
          const next = describeTools(state, values);
          state.tools = next;
          delete state.lastRefreshError;
        } catch (error) {
          if (signal?.aborted === true || this.lifecycleAbort.signal.aborted)
            throw error;
          state.lastRefreshError = safeServerError(
            state.config.name,
            "failed to refresh tools",
          );
          if (shouldDiscardConnection(error, state.transport))
            this.markStale(state);
          throw error;
        }
      });
    state.refreshTail = operation;
    return operation;
  }

  public catalogSnapshot(): readonly DownstreamTool[] {
    const tools = [...this.ready.values()]
      .filter(
        (state) =>
          state.connected &&
          !state.stale &&
          state.lastRefreshError === undefined,
      )
      .flatMap((state) => [...state.tools.values()])
      .sort((left, right) => left.id.localeCompare(right.id));
    return tools;
  }

  private markStale(state: ServerState): void {
    if (state.stale) return;
    state.stale = true;
    state.connected = false;
    if (this.ready.get(state.config.name) === state)
      this.ready.delete(state.config.name);
    this.connecting.delete(state.config.name);
    if (state.activeCalls === 0) void this.closeState(state);
  }

  private closeState(state: ServerState): Promise<void> {
    state.closePromise ??= (async () => {
      state.stale = true;
      state.connected = false;
      try {
        await state.client.close();
      } catch {
        try {
          await state.transport.close();
        } catch {
          // Shutdown is best effort after the official client close failed.
        }
      }
      this.allStates.delete(state);
    })();
    return state.closePromise;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Downstream MCP registry is closed");
  }
}

export { DownstreamMcpRegistry as McpRegistry };

export function encodeDownstreamToolId(
  serverId: string,
  toolName: string,
): string {
  if (serverId.length === 0 || toolName.length === 0) {
    throw new Error("Downstream MCP server and tool names must not be empty");
  }
  return (
    TOOL_ID_PREFIX +
    Buffer.from(JSON.stringify([serverId, toolName]), "utf8").toString(
      "base64url",
    )
  );
}

export function decodeDownstreamToolId(toolId: string): {
  serverId: string;
  toolName: string;
} {
  if (!toolId.startsWith(TOOL_ID_PREFIX))
    throw new Error("Invalid downstream MCP tool id");
  try {
    const raw = Buffer.from(
      toolId.slice(TOOL_ID_PREFIX.length),
      "base64url",
    ).toString("utf8");
    const decoded: unknown = JSON.parse(raw);
    if (
      !Array.isArray(decoded) ||
      decoded.length !== 2 ||
      typeof decoded[0] !== "string" ||
      decoded[0].length === 0 ||
      typeof decoded[1] !== "string" ||
      decoded[1].length === 0 ||
      encodeDownstreamToolId(decoded[0], decoded[1]) !== toolId
    ) {
      throw new Error("invalid");
    }
    return { serverId: decoded[0], toolName: decoded[1] };
  } catch {
    throw new Error("Invalid downstream MCP tool id");
  }
}

export function createDownstreamCodeName(
  serverId: string,
  toolName: string,
): string {
  const rawBase = `mcp__${serverId}__${toolName}`;
  const sanitized = sanitizeCodeName(rawBase);
  const unambiguous =
    !serverId.includes("__") &&
    !toolName.includes("__") &&
    !serverId.endsWith("_") &&
    !toolName.startsWith("_") &&
    sanitized === rawBase &&
    sanitized.length <= MAX_CODE_NAME_LENGTH;
  if (unambiguous) return sanitized;

  const suffix = `_${crypto
    .createHash("sha256")
    .update(serverId)
    .update("\0")
    .update(toolName)
    .digest("hex")
    .slice(0, CODE_NAME_HASH_LENGTH)}`;
  const prefix = "mcp_h__";
  const available = MAX_CODE_NAME_LENGTH - prefix.length - suffix.length;
  return `${prefix}${sanitized.slice("mcp__".length, "mcp__".length + available)}${suffix}`;
}

function createTransport(
  config: DownstreamMcpServerConfig,
  environment: Environment,
): Transport {
  if (config.transport === "stdio") {
    return new StdioClientTransport({
      command: config.command,
      args: [...config.args],
      env: { ...safeInheritedEnvironment(environment), ...config.env },
      stderr: "ignore",
      ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
    });
  }
  return new StreamableHTTPClientTransport(new URL(config.url), {
    ...(Object.keys(config.headers).length === 0
      ? {}
      : { requestInit: { headers: { ...config.headers } } }),
  });
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

function describeTools(
  state: ServerState,
  values: readonly Tool[],
): ReadonlyMap<string, DownstreamTool> {
  const tools = new Map<string, DownstreamTool>();
  const seen = new Set<string>();
  const enabled =
    state.config.enabledTools === undefined
      ? undefined
      : new Set(state.config.enabledTools);
  for (const value of values) {
    if (seen.has(value.name)) {
      throw new Error(
        `MCP server "${state.config.name}" returned duplicate tool names`,
      );
    }
    seen.add(value.name);
    if (enabled !== undefined && !enabled.has(value.name)) continue;
    const tool = structuredClone(value);
    tools.set(value.name, {
      id: encodeDownstreamToolId(state.config.name, value.name),
      codeName: createDownstreamCodeName(state.config.name, value.name),
      serverId: state.config.name,
      ...(state.serverVersion === undefined
        ? {}
        : {
            serverName: state.serverVersion.name,
            ...(state.serverVersion.title === undefined
              ? {}
              : { serverTitle: state.serverVersion.title }),
          }),
      ...(state.namespaceInstructions === undefined
        ? {}
        : { namespaceInstructions: state.namespaceInstructions }),
      tool,
    });
  }
  return tools;
}

function sanitizeCodeName(value: string): string {
  const sanitized = [...value]
    .map((character) => (/[A-Za-z0-9_]/u.test(character) ? character : "_"))
    .join("");
  return sanitized.length === 0 ? "_" : sanitized;
}

function safeInheritedEnvironment(
  environment: Environment,
): Record<string, string> {
  const result: Record<string, string> = {};
  if (environment.TZ) result.TZ = environment.TZ;
  for (const name of DEFAULT_INHERITED_ENV_VARS) {
    const value = environment[name];
    if (value !== undefined && !value.startsWith("()")) result[name] = value;
  }
  return result;
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
  if (signal.aborted) return Promise.reject(abortError(signal.reason));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError(signal.reason));
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

function shouldDiscardConnection(
  error: unknown,
  transport: Transport,
): boolean {
  if (error instanceof ProtocolError) return false;
  // A legacy HTTP session can expire without closing the transport. Discard
  // that session, but leave reconnecting to the next independent operation.
  if (
    SdkHttpError.isInstance(error) &&
    error.status === 404 &&
    transport.sessionId !== undefined
  ) {
    return true;
  }
  if (SdkError.isInstance(error)) {
    return (
      error.code === SdkErrorCode.NotConnected ||
      error.code === SdkErrorCode.ConnectionClosed ||
      error.code === SdkErrorCode.SendFailed
    );
  }
  return error instanceof Error && error.name !== "AbortError";
}

function safeServerError(serverId: string, message: string): string {
  return `MCP server "${serverId}" ${message}`;
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return resolved;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw abortError(signal.reason);
}

function abortError(reason: unknown): Error {
  void reason;
  const error = new Error("Operation aborted");
  error.name = "AbortError";
  return error;
}

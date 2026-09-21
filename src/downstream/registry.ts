import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  Client,
  ProtocolError,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  UnauthorizedError,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type Implementation,
  type Tool,
  type Transport,
  type RequestOptions,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { inheritedEnvironment } from "../environment.js";
import { EnvironmentHttpClient } from "../network/http.js";

import type { DownstreamTool, JsonObject } from "../types.js";
import { VERSION } from "../version.js";
import type { DownstreamMcpServerConfig } from "./config.js";
import {
  listResourceCatalog,
  ResourceError,
  resourceResultBytes,
  type ResourceListInput,
  type ResourceReadInput,
} from "./resources.js";

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

export interface DownstreamStartupEvent {
  server: string;
  status: "connecting" | "ready" | "error";
  tools?: number;
  message?: string;
}

class SetupError extends Error {}

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
        throw new Error(`Duplicate downstream MCP server: ${definition.name}`);
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
            throw abortError(
              signal?.reason ?? this.lifecycleAbort.signal.reason,
            );
          const message = startupError(
            serverId,
            "连接与工具发现",
            error,
          ).message;
          failed.push(message);
          notify({ server: serverId, status: "error", message });
        }
      }),
    );
    this.assertOpen();
    throwIfAborted(signal);
    if (failed.length)
      throw new Error(
        `下游 MCP 启动失败，服务未就绪：\n${failed.sort().join("\n")}\n请在本机完成登录或修正配置后重启；不使用的服务可设 enabled=false。`,
      );
    // A server could disconnect while a slower sibling was still initializing.
    for (const name of this.definitions.keys())
      if (!this.ready.has(name)) throw startupError(name, "启动期间连接已断开");
  }

  public bindingSnapshot(): readonly DownstreamTool[] {
    return [...this.catalogs.values()]
      .flatMap((tools) => [...tools.values()])
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  public catalogErrors(): Record<string, string> {
    return Object.fromEntries(this.errors);
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
          errors[serverId] = startupError(
            serverId,
            "连接与工具发现",
            error,
          ).message;
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
      if (state.lastRefreshError !== undefined)
        await this.refreshTools(state, signal);
      await raceWithSignal(
        state.refreshTail,
        combinedSignal(this.lifecycleAbort.signal, signal),
      );
    } catch {
      if (signal?.aborted || this.lifecycleAbort.signal.aborted) {
        throw abortError("下游连接准备已取消；未发送本次工具调用。");
      }
      throw new Error(
        `下游 ${serverId} 的连接或工具目录不可用；未发送本次调用，请在本机检查连接、凭据并重启服务。`,
      );
    }
    const descriptor = state.tools.get(toolName);
    if (descriptor === undefined || descriptor.id !== toolId) {
      throw new Error(
        `工具已移除或目录过期：${serverId}/${toolName}；请在新的 exec 中读取目录。`,
      );
    }

    if (
      state.lastRefreshError !== undefined ||
      (expected !== undefined && !isDeepStrictEqual(expected, descriptor.tool))
    ) {
      throw new Error(
        "工具契约已变更或无法确认；尚未发送，请在新的 exec 中读取最新契约。",
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
          throw new ResourceError("该服务未声明 resources 能力。");
        const { _meta: _private, ...result } = await client.readResource(
          { uri: input.uri },
          { ...options, cacheMode: "bypass" },
        );
        const value = { ...result, server: input.server, uri: input.uri };
        resourceResultBytes(value);
        return value;
      },
      signal,
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
  ): Promise<T> {
    this.assertOpen();
    throwIfAborted(signal);
    if (!this.definitions.has(server))
      throw new ResourceError(
        `未知或未启用的下游 MCP 服务：${JSON.stringify(server)}。`,
      );
    const state = await this.ensureServer(server, signal);
    const timeout = state.config.toolTimeoutMs ?? this.toolTimeoutMs;
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
        throw abortError("下游 MCP 资源请求已取消。");
      if (error instanceof ResourceError) throw error;
      if (shouldDiscardConnection(error, state.transport))
        this.markStale(state);
      if (
        deadline.aborted ||
        (SdkError.isInstance(error) &&
          error.code === SdkErrorCode.RequestTimeout)
      )
        throw new Error(
          `下游 MCP ${JSON.stringify(server)} ${method} 超时；可调整 tool_timeout_sec。`,
        );
      if (ProtocolError.isInstance(error))
        throw new Error(
          `下游 MCP ${JSON.stringify(server)} ${method} 被拒绝（协议错误 ${error.code}）；请核对资源 URI、游标及服务凭据。`,
        );
      throw new Error(
        `下游 MCP ${JSON.stringify(server)} ${method} 失败；请检查连接和凭据，未自动重试。`,
      );
    } finally {
      state.activeCalls--;
      if (state.stale && state.activeCalls === 0) void this.closeState(state);
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
    // One budget covers protocol negotiation, initialization and every list page.
    const deadline = AbortSignal.timeout(connectTimeout);
    const startupSignal = combinedSignal(this.lifecycleAbort.signal, deadline);
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
    client.onclose = () => {
      if (state !== undefined && state.connected && !state.stale)
        this.markStale(state);
    };
    this.allStates.add(state);

    let attempt: Promise<void> | undefined;
    try {
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
      if (this.closed) throw abortError(this.lifecycleAbort.signal.reason);
      if (state.stale) throw new Error("disconnected during startup");
      this.ready.set(config.name, state);
      this.errors.delete(config.name);
      return state;
    } catch (error) {
      this.markStale(state);
      await this.closeState(state);
      // Await the SDK's negotiation cleanup, including its disposable stdio probe.
      await attempt?.catch(() => undefined);
      if (this.lifecycleAbort.signal.aborted)
        throw abortError(this.lifecycleAbort.signal.reason);
      const failure = startupError(
        config.name,
        "连接与工具发现",
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
          state.lastRefreshError = startupError(
            state.config.name,
            "获取工具目录",
            error,
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
    if (this.ready.get(state.config.name) === state) {
      this.ready.delete(state.config.name);
      this.connecting.delete(state.config.name);
    }
    this.errors.set(
      state.config.name,
      startupError(state.config.name, "连接已断开").message,
    );
    if (state.activeCalls === 0) void this.closeState(state);
  }

  private closeState(state: ServerState): Promise<void> {
    state.closePromise ??= (async () => {
      state.stale = true;
      state.connected = false;
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
  http?: EnvironmentHttpClient,
): Transport {
  if (config.transport === "stdio") {
    return new StdioClientTransport({
      command: config.command,
      args: [...config.args],
      env: inheritedEnvironment(environment, config.env),
      // stdio stdout belongs to MCP; diagnostics/login hints belong in the terminal.
      stderr: "inherit",
      ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
    });
  }
  return new StreamableHTTPClientTransport(new URL(config.url), {
    fetch: http!.fetch,
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
  for (const name of enabled ?? [])
    if (!seen.has(name))
      throw new SetupError(
        `下游 MCP ${JSON.stringify(state.config.name)}：enabled_tools 中的 ${JSON.stringify(name)} 不在目录中；请修正配置。`,
      );
  return tools;
}

function sanitizeCodeName(value: string): string {
  const sanitized = [...value]
    .map((character) => (/[A-Za-z0-9_]/u.test(character) ? character : "_"))
    .join("");
  return sanitized.length === 0 ? "_" : sanitized;
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

function startupError(
  serverId: string,
  stage: string,
  error?: unknown,
): SetupError {
  if (error instanceof SetupError) return error;
  let detail = "请检查地址、启动命令、依赖和终端诊断";
  if (
    error instanceof UnauthorizedError ||
    (SdkHttpError.isInstance(error) && [401, 403].includes(error.status)) ||
    (SdkError.isInstance(error) &&
      (error.code === SdkErrorCode.ClientHttpAuthentication ||
        error.code === SdkErrorCode.ClientHttpForbidden))
  )
    detail =
      "鉴权未完成或权限不足；请先在本机登录并配置下游凭据，ChatGPT 调用中不提供登录交互";
  else if (
    (error instanceof Error && error.name === "TimeoutError") ||
    (SdkError.isInstance(error) && error.code === SdkErrorCode.RequestTimeout)
  )
    detail =
      "超时；请检查终端诊断、完成登录，或调整 startup_timeout_sec 后重启";
  else if (ProtocolError.isInstance(error))
    detail =
      "协议或工具目录被拒绝；若服务需要登录或用户输入，请先在本机完成，不在 ChatGPT 工具调用中交互";
  return new SetupError(
    `下游 MCP ${JSON.stringify(serverId)} ${stage}失败：${detail}。`,
  );
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

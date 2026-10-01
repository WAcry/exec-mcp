import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import type { CallToolResult } from "@modelcontextprotocol/client";
import {
  McpServer,
  ResourceTemplate,
  SERVER_INFO_META_KEY,
  type ServerContext,
  type ResourceLink,
} from "@modelcontextprotocol/server";
import type { z } from "zod/v4";
import { CodeModeService, sessionScopeKey } from "./code-mode/service.js";
import type { CodeModeToolDefinition } from "./code-mode/types.js";
import {
  nativeContracts,
  nativeContractsByName,
  nativeDefinition,
  parseNativeInput,
  EXEC_SCHEMA,
  WAIT_SCHEMA,
  execDescription,
  WAIT_DESCRIPTION,
  type NativeContract,
} from "./catalog.js";
import type { Config } from "./config.js";
import { DownstreamMcpRegistry } from "./downstream/registry.js";
import { ToolDiscovery } from "./downstream/discovery.js";
import { TerminalManager } from "./host/terminal.js";
import { PatchRunner } from "./host/patch.js";
import { viewImage } from "./host/image.js";
import { toolError } from "./results.js";
import { errorMessage, resolveUserPath, throwIfAborted } from "./util.js";
import { VERSION } from "./version.js";
import { brandIcons } from "./brand-icon.js";
import { ArtifactStore, ARTIFACT_URI_PREFIX } from "./files/artifacts.js";
import type { HostFile } from "./files/contracts.js";
import { listSkills } from "./skills/index.js";
import { DEFAULT_SKILL_MAX_CHARS, type SkillSetting } from "./skills/types.js";
import { resolveShell, type CommandShell } from "./host/shell.js";
import { MEMORY_SCHEMA, MiB } from "./memory.js";
import { boundModelOutput } from "./code-mode/model-output.js";
import { ActivityStore, type ActiveCallController } from "./web/activity.js";
import type { CallRecord, CallStatus } from "./web/types.js";
import { SessionNotes } from "./session-notes.js";
import type { NativeToolName } from "./tool-names.js";

function sessionScope(context: ServerContext): string | undefined {
  const meta = context.mcpReq._meta as Record<string, unknown> | undefined;
  const session = meta?.["openai/session"];
  return typeof session === "string" && session.length ? session : undefined;
}

/** Only display metadata from host bindings; signed URLs and opaque credentials stay private. */
function fileAuditMetadata(file: HostFile) {
  return {
    ...(typeof file.file_name === "string" ? { name: file.file_name } : {}),
    ...(typeof file.mime_type === "string" ? { type: file.mime_type } : {}),
    ...(typeof file.size === "number" ? { size: file.size } : {}),
  };
}

function subcallFailed(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const value = result as Record<string, unknown>;
  return (
    value.isError === true ||
    value.success === false ||
    (typeof value.exit_code === "number" && value.exit_code !== 0)
  );
}

/** Records one nested call in the Web activity log. */
async function audited<T>(
  call: ActiveCallController,
  name: string,
  input: unknown,
  run: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  const audit = call.startSubcall(name, input);
  try {
    const output = await run();
    audit.finish({
      durationMs: Date.now() - started,
      output,
      status: subcallFailed(output) ? "error" : "success",
    });
    return output;
  } catch (error) {
    audit.finish({
      durationMs: Date.now() - started,
      error: errorMessage(error),
      status: "error",
    });
    throw error;
  }
}

type CodeModeState = "yielded" | "completed" | "terminated";

type DefinedFields<T> = { [K in keyof T]: Exclude<T[K], undefined> };
/** Drops keys whose parsed value is undefined, matching exact optional types. */
function definedFields<T extends object>(value: T): DefinedFields<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined),
  ) as DefinedFields<T>;
}

function callStatus(
  result: CallToolResult,
  state: CodeModeState | undefined,
): CallStatus {
  if (result.isError) return "error";
  if (state === "yielded") return "yielding";
  if (state === "terminated") return "terminated";
  return "completed";
}

/** Copies the defined arguments for the activity log. */
function recordedArgs(args: Record<string, unknown>): CallRecord["args"] {
  return Object.fromEntries(
    Object.entries(args).filter(([, value]) => value !== undefined),
  ) as CallRecord["args"];
}

const IDENTITY = { name: "exec-mcp", title: "Exec MCP", version: VERSION };

/** 2026-era results repeat serverInfo, icons included, unless the result already names its server. */
function identify<T extends { _meta?: Record<string, unknown> | undefined }>(
  result: T,
): T {
  return {
    ...result,
    _meta: { ...result._meta, [SERVER_INFO_META_KEY]: IDENTITY },
  };
}
interface NativeContext {
  callId: string;
  cwd: string;
  explicitWorkdir: boolean;
  scope: string | undefined;
  files: readonly HostFile[] | undefined;
  signal: AbortSignal | undefined;
  attachments: {
    items: { id: string; content: ResourceLink }[];
    bytes: number;
  };
}

/** A local tool: its contract, its cached Code Mode definition and its handler. */
interface NativeTool {
  readonly name: NativeToolName;
  readonly definition: Omit<CodeModeToolDefinition, "call">;
  /** Validates raw input before any side effect. */
  parse(raw: unknown): unknown;
  /** Runs the handler with input returned by parse. */
  run(input: unknown, ctx: NativeContext): Promise<unknown>;
}

function defineNative<S extends z.ZodType>(
  contract: NativeContract<S>,
  handler: (input: z.output<S>, ctx: NativeContext) => unknown,
): NativeTool {
  return {
    name: contract.name,
    definition: nativeDefinition(contract),
    parse: (raw) => parseNativeInput(contract, raw),
    run: async (input, ctx) => {
      throwIfAborted(ctx.signal);
      return handler(input as z.output<S>, ctx);
    },
  };
}

export class ExecRuntime {
  readonly codeMode: CodeModeService;
  readonly terminal: TerminalManager;
  readonly patch = new PatchRunner();
  readonly downstream: DownstreamMcpRegistry;
  readonly discovery: ToolDiscovery;
  readonly artifacts: ArtifactStore;
  readonly activity: ActivityStore;
  readonly notes: SessionNotes;
  private initialization: Promise<void> | undefined;
  private initialized = false;
  private closing: Promise<void> | undefined;
  readonly skillMaxChars: number;
  readonly idleHours: number;
  readonly skillConfig: readonly SkillSetting[];
  private readonly contracts: readonly NativeContract[];
  private readonly nativeTools: readonly NativeTool[];
  private readonly securitySchemes:
    | { type: string; scopes?: string[] }[]
    | undefined;
  constructor(
    config: Config,
    artifacts?: ArtifactStore,
    activity?: ActivityStore,
    notes?: SessionNotes,
  ) {
    this.securitySchemes =
      config.access === "openai-tunnel"
        ? [{ type: "noauth" }]
        : config.auth?.type === "oauth"
          ? [{ type: "oauth2", scopes: config.auth.scopes }]
          : undefined;
    // Fail bad shell configuration before creating timers, hosts or listeners.
    const shell = resolveShell(config.execution);
    const memory = MEMORY_SCHEMA.parse(config.memory ?? {});
    this.idleHours = memory.idle_retention_hours;
    const idleMs = Math.round(memory.idle_retention_hours * 3_600_000);
    this.terminal = new TerminalManager({
      shell,
      bufferBytes: memory.terminal_buffer_mib * MiB,
      idleMs,
    });
    this.contracts = nativeContracts(shell);
    this.nativeTools = this.defineNativeTools(shell);
    this.codeMode = new CodeModeService({
      sessionIdleMs: idleMs,
      memoryHighWaterBytes: memory.code_mode_high_water_mib * MiB,
    });
    this.skillMaxChars = config.skills?.max_chars ?? DEFAULT_SKILL_MAX_CHARS;
    this.skillConfig = config.skills?.config ?? [];
    this.artifacts = artifacts ?? new ArtifactStore(config.files);
    this.downstream = new DownstreamMcpRegistry({ servers: config.mcpServers });
    this.discovery = new ToolDiscovery(this.downstream);
    // startServer() can be embedded without a Web console. Only an explicit
    // observer enables capture, so a hidden audit trail is never the default.
    this.activity = activity ?? new ActivityStore({ enabled: false });
    this.notes = notes ?? new SessionNotes();
  }
  get ready(): boolean {
    return this.initialized && this.closing === undefined;
  }
  initialize(...args: Parameters<ToolDiscovery["initialize"]>): Promise<void> {
    this.initialization ??= this.discovery.initialize(...args).then(() => {
      if (this.closing) throw new Error("服务正在关闭。");
      this.initialized = true;
    });
    return this.initialization;
  }
  /** Each local tool's handler, typed by its contract's schema. */
  private defineNativeTools(shell: CommandShell): readonly NativeTool[] {
    const c = nativeContractsByName(shell);
    const tools = {
      list_skills: defineNative(c.list_skills, (input, ctx) => {
        const workdir =
          input.workdir === undefined
            ? ctx.explicitWorkdir
              ? ctx.cwd
              : undefined
            : resolveUserPath(input.workdir, ctx.cwd);
        return listSkills({
          ...(workdir === undefined ? {} : { workdir }),
          maxChars: this.skillMaxChars,
          config: this.skillConfig,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
      }),
      import_file: defineNative(c.import_file, (input, ctx) => {
        const file = ctx.files?.[input.index];
        if (!file)
          throw new Error(
            "本次 exec.files 没有该索引；请通过顶层 files 传入原生文件引用。",
          );
        return this.artifacts.importFile(
          file,
          input.destination,
          ctx.cwd,
          input.overwrite,
          ctx.signal,
        );
      }),
      export_file: defineNative(c.export_file, async (input, ctx) => {
        if (ctx.attachments.bytes + 4096 > 1024 * 1024)
          throw new Error(
            "本次待返回的文件链接元数据过大；先 yield_control，再继续导出。",
          );
        const exported = await this.artifacts.exportFile(
          input.path,
          ctx.cwd,
          ctx.scope,
          input.delivery,
          input.name,
          ctx.signal,
        );
        const bytes = Buffer.byteLength(JSON.stringify(exported.content));
        if (ctx.attachments.bytes + bytes > 1024 * 1024) {
          await this.artifacts.revoke(exported.info.id, ctx.scope);
          throw new Error("文件链接元数据超出单次响应预算；本次导出已撤销。");
        }
        ctx.attachments.items.push({
          id: exported.info.id,
          content: exported.content,
        });
        ctx.attachments.bytes += bytes;
        return exported.info;
      }),
      exec_command: defineNative(c.exec_command, (input, ctx) =>
        this.terminal.execCommand(
          definedFields(input),
          ctx.cwd,
          ctx.signal,
          sessionScopeKey(ctx.scope),
        ),
      ),
      write_stdin: defineNative(c.write_stdin, (input, ctx) =>
        this.terminal.writeStdin(definedFields(input), ctx.signal),
      ),
      apply_patch: defineNative(c.apply_patch, (input, ctx) =>
        this.patch.apply(input, ctx.cwd, ctx.signal),
      ),
      view_image: defineNative(c.view_image, (input, ctx) =>
        viewImage(resolveUserPath(input.path, ctx.cwd), input.detail),
      ),
      request_user_input_async: defineNative(
        c.request_user_input_async,
        (input, ctx) => this.notes.ask(sessionScopeKey(ctx.scope), input),
      ),
      send_message_to_user_async: defineNative(
        c.send_message_to_user_async,
        (input, ctx) =>
          this.notes.sendMessage(sessionScopeKey(ctx.scope), input, ctx.callId),
      ),
      set_conversation_title: defineNative(
        c.set_conversation_title,
        (input, ctx) =>
          this.notes.setTitle(sessionScopeKey(ctx.scope), input.title),
      ),
      list_mcp_resources: defineNative(c.list_mcp_resources, (input, ctx) =>
        this.downstream.listResources(input, ctx.signal),
      ),
      list_mcp_resource_templates: defineNative(
        c.list_mcp_resource_templates,
        (input, ctx) =>
          this.downstream.listResourceTemplates(input, ctx.signal),
      ),
      read_mcp_resource: defineNative(c.read_mcp_resource, (input, ctx) =>
        this.downstream.readResource(input, ctx.signal),
      ),
    } satisfies Record<NativeToolName, NativeTool>;
    return (Object.keys(c) as NativeToolName[]).map((name) => tools[name]);
  }
  private async workdir(value?: string): Promise<string> {
    const cwd = await realpath(resolveUserPath(value ?? homedir()));
    if (!(await stat(cwd)).isDirectory())
      throw new Error("workdir 必须是目录。");
    return cwd;
  }
  /**
   * Shared exec/wait boundary: activity record, user notes, server identity.
   * Errors become a bounded tool error result; onError may add content to it.
   */
  private async trackedCall(
    tool: "exec" | "wait",
    context: ServerContext,
    args: Record<string, unknown>,
    run: (
      call: ActiveCallController,
    ) => Promise<{ result: CallToolResult; state: CodeModeState | undefined }>,
    onError?: (result: CallToolResult) => void,
  ): Promise<CallToolResult> {
    const scopeKey = sessionScopeKey(sessionScope(context));
    this.notes.observe(scopeKey);
    const call = this.activity.startCall({
      tool,
      sessionId: scopeKey ?? "unscoped",
      args: recordedArgs(args),
    });
    const attachNotes = (result: CallToolResult) =>
      this.notes.attach(result, scopeKey, call.id, context.mcpReq.signal);
    try {
      // The Code Mode service already bounded this result.
      const { result: raw, state } = await run(call);
      const result = attachNotes(raw);
      call.finish({ status: callStatus(raw, state), output: result });
      return identify(result);
    } catch (error) {
      const failed = toolError(error);
      onError?.(failed);
      const result = attachNotes(boundModelOutput(failed));
      call.finish({
        status: "error",
        error: errorMessage(error),
        output: result,
      });
      return identify(result);
    }
  }
  server(): McpServer {
    const server = new McpServer(
      { ...IDENTITY, icons: brandIcons() },
      {
        instructions:
          "Exec MCP connects ChatGPT to one specific remote machine operated by the user. exec runs source with this machine's ALL_TOOLS catalog and tools bindings; wait resumes running cells. Tool responses may include additional user messages or answers from this conversation's Web UI (user_notes or a labeled text block), in submission order, received through normal calls.",
      },
    );
    const annotations = {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    };
    server.registerTool(
      "exec",
      {
        title: "Execute code",
        description: execDescription(this.contracts, this.idleHours),
        inputSchema: EXEC_SCHEMA,
        annotations,
        _meta: {
          ...(this.securitySchemes
            ? { securitySchemes: this.securitySchemes }
            : {}),
          "openai/fileParams": ["files"],
        },
      },
      async (args, context) => {
        const scope = sessionScope(context);
        const attachments: NativeContext["attachments"] = {
          items: [],
          bytes: 0,
        };
        const takeAttachments = () => {
          const items = attachments.items
            .filter((item) => this.artifacts.available(item.id, scope))
            .map((item) => item.content);
          attachments.items = [];
          attachments.bytes = 0;
          return items;
        };
        return this.trackedCall(
          "exec",
          context,
          {
            source: args.source,
            workdir: args.workdir,
            yield_time_ms: args.yield_time_ms,
            max_output_tokens: args.max_output_tokens,
            files: args.files?.map(fileAuditMetadata),
          },
          async (call) => {
            if (!this.ready) throw new Error("服务正在关闭。");
            const signal = context.mcpReq.signal;
            throwIfAborted(signal);
            const cwd = await this.workdir(args.workdir);
            const native = this.nativeTools.map((tool) => ({
              ...tool.definition,
              call: async (raw: unknown, nested: { signal: AbortSignal }) => {
                const input = tool.parse(raw);
                return audited(call, tool.name, input, () =>
                  tool.run(input, {
                    cwd,
                    explicitWorkdir: args.workdir !== undefined,
                    callId: call.id,
                    scope,
                    files: args.files,
                    signal: nested.signal,
                    attachments,
                  }),
                );
              },
            }));
            const downstream = this.discovery.snapshot().map((tool) => ({
              ...tool,
              call: (...parameters: Parameters<typeof tool.call>) =>
                audited(call, tool.name, parameters[0], () =>
                  tool.call(...parameters),
                ),
            }));
            let state: CodeModeState | undefined;
            const result = await this.codeMode.exec({
              source: args.source,
              ...(call.id === "audit-disabled" ? {} : { requestId: call.id }),
              takeAttachments,
              ...(args.max_output_tokens === undefined
                ? {}
                : { maxOutputTokens: args.max_output_tokens }),
              tools: [...native, ...downstream],
              ...(args.yield_time_ms === undefined
                ? {}
                : { yieldTimeMs: args.yield_time_ms }),
              ...(scope === undefined ? {} : { sessionScope: scope }),
              signal,
              onState: (next) => {
                state = next;
              },
            });
            return { result, state };
          },
          (failed) => failed.content.push(...takeAttachments()),
        );
      },
    );
    server.registerTool(
      "wait",
      {
        title: "Wait for execution",
        description: WAIT_DESCRIPTION,
        inputSchema: WAIT_SCHEMA,
        annotations,
        _meta: this.securitySchemes
          ? { securitySchemes: this.securitySchemes }
          : {},
      },
      async (args, context) => {
        const scope = sessionScope(context);
        return this.trackedCall(
          "wait",
          context,
          {
            cell_id: args.cell_id,
            yield_time_ms: args.yield_time_ms,
            max_tokens: args.max_tokens,
            terminate: args.terminate,
          },
          async () => {
            let state: CodeModeState | undefined;
            const result = await this.codeMode.wait({
              cellId: args.cell_id,
              ...(args.max_tokens === undefined
                ? {}
                : { maxTokens: args.max_tokens }),
              ...(args.yield_time_ms === undefined
                ? {}
                : { yieldTimeMs: args.yield_time_ms }),
              ...(args.terminate === undefined
                ? {}
                : { terminate: args.terminate }),
              ...(scope === undefined ? {} : { sessionScope: scope }),
              signal: context.mcpReq.signal,
              onState: (next) => {
                state = next;
              },
            });
            return { result, state };
          },
        );
      },
    );
    server.registerResource(
      "exported-file",
      new ResourceTemplate(`${ARTIFACT_URI_PREFIX}{id}`, { list: undefined }),
      {
        title: "Exported file",
        description:
          "Explicitly exported, expiring file snapshot, readable through this instance's private MCP connection.",
        cacheHint: { ttlMs: 0, cacheScope: "private" },
      },
      async (uri, _variables, context) =>
        this.artifacts.readResource(
          uri.href,
          sessionScope(context),
          context.mcpReq.signal,
        ),
    );
    return server;
  }
  close(): Promise<void> {
    this.closing ??= (async () => {
      const results = await Promise.allSettled([
        this.codeMode.close(),
        this.terminal.close(),
        this.patch.close(),
        this.downstream.close(),
        this.artifacts.close(),
      ]);
      const errors = results.filter((result) => result.status === "rejected");
      if (errors.length)
        throw new AggregateError(errors, "服务关闭时部分清理失败。");
    })();
    return this.closing;
  }
}

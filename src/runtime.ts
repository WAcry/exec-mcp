import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import {
  McpServer,
  ResourceTemplate,
  type ServerContext,
  type ResourceLink,
} from "@modelcontextprotocol/server";
import { CodeModeService, sessionScopeKey } from "./code-mode/service.js";
import {
  nativeContracts,
  bindNative,
  EXEC_SCHEMA,
  WAIT_SCHEMA,
  execDescription,
  WAIT_DESCRIPTION,
  directContract,
} from "./catalog.js";
import type { Config } from "./config.js";
import { DownstreamMcpRegistry } from "./downstream/registry.js";
import { ToolDiscovery } from "./downstream/discovery.js";
import {
  TerminalManager,
  type ExecCommandInput,
  type WriteStdinInput,
} from "./host/terminal.js";
import { PatchRunner } from "./host/patch.js";
import { viewImage } from "./host/image.js";
import { toolError, directResult } from "./results.js";
import { resolveUserPath, throwIfAborted } from "./util.js";
import { VERSION } from "./version.js";
import { ArtifactStore, ARTIFACT_URI_PREFIX } from "./files/artifacts.js";
import type { HostFile } from "./files/contracts.js";
import { listSkills } from "./skills/index.js";
import { DEFAULT_SKILL_MAX_CHARS, type SkillSetting } from "./skills/types.js";
import { resolveShell } from "./host/shell.js";
import { MEMORY_SCHEMA, MiB } from "./memory.js";
import { boundModelOutput } from "./code-mode/model-output.js";
import { ActivityStore } from "./web/activity.js";
import type { CallRecord } from "./web/types.js";
import { SessionNotes } from "./session-notes.js";
import type { RequestUserInput } from "./user-questions.js";

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
interface NativeContext {
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
  private readonly native: ReturnType<typeof nativeContracts>;
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
    this.native = nativeContracts(shell);
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
  /** Shared behavior for direct MCP and Code Mode; direct calls never generate JavaScript. */
  private async callNative(
    name: string,
    input: unknown,
    ctx: NativeContext,
  ): Promise<unknown> {
    throwIfAborted(ctx.signal);
    switch (name) {
      case "list_skills": {
        const requested = (input as { workdir?: string }).workdir;
        const workdir =
          requested === undefined
            ? ctx.explicitWorkdir
              ? ctx.cwd
              : undefined
            : resolveUserPath(requested, ctx.cwd);
        return listSkills({
          ...(workdir === undefined ? {} : { workdir }),
          maxChars: this.skillMaxChars,
          config: this.skillConfig,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
      }
      case "import_file": {
        const value = input as {
          index: number;
          destination: string;
          overwrite?: boolean;
        };
        const file = ctx.files?.[value.index];
        if (!file)
          throw new Error(
            "本次 exec.files 没有该索引；请通过顶层 files 传入原生文件引用。",
          );
        return this.artifacts.importFile(
          file,
          value.destination,
          ctx.cwd,
          value.overwrite,
          ctx.signal,
        );
      }
      case "export_file": {
        if (ctx.attachments.bytes + 4096 > 1024 * 1024)
          throw new Error(
            "本次待返回的文件链接元数据过大；先 yield_control，再继续导出。",
          );
        const file = input as {
          path: string;
          name?: string;
          delivery?: "resource" | "url";
        };
        const exported = await this.artifacts.exportFile(
          file.path,
          ctx.cwd,
          ctx.scope,
          file.delivery,
          file.name,
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
      }
      case "exec_command":
        return this.terminal.execCommand(
          input as ExecCommandInput,
          ctx.cwd,
          ctx.signal,
        );
      case "write_stdin":
        return this.terminal.writeStdin(input as WriteStdinInput, ctx.signal);
      case "apply_patch":
        return this.patch.apply(input as string, ctx.cwd, ctx.signal);
      case "view_image": {
        const value = input as { path: string; detail?: string };
        return viewImage(resolveUserPath(value.path, ctx.cwd), value.detail);
      }
      case "request_user_input_async":
        throwIfAborted(ctx.signal);
        return this.notes.ask(
          sessionScopeKey(ctx.scope),
          input as RequestUserInput,
        );
      default:
        throw new Error("未知本机工具。");
    }
  }
  private async workdir(value?: string): Promise<string> {
    const cwd = await realpath(resolveUserPath(value ?? homedir()));
    if (!(await stat(cwd)).isDirectory())
      throw new Error("workdir 必须是目录。");
    return cwd;
  }
  server(): McpServer {
    const server = new McpServer(
      { name: "exec-mcp", title: "Exec MCP", version: VERSION },
      {
        instructions:
          "本机工具既可直接调用，也可在 exec 内通过 tools.* 编排。首次使用或进入新项目时先 list_skills，按目录规则选择并读取全文；先阅读项目适用指令，保留无关改动与秘密。按工具契约处理结果和副作用。等待长任务用较长窗口减少轮询；需及时交互时缩短。user_notes 或「用户额外补充：」是本对话用户从 Web 发来的补充，按所列顺序调整后续工作，随正常调用接收。",
      },
    );
    const annotations = {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    };
    // Direct and nested native operations share implementations, without source interpolation.
    const registerNativeTools = () => {
      for (const contract of this.native) {
        const direct = directContract(contract);
        const readOnly = ["list_skills", "view_image"].includes(contract.name);
        server.registerTool(
          contract.name,
          {
            title: direct.title,
            description: direct.description,
            inputSchema: direct.schema,
            annotations: {
              readOnlyHint: readOnly,
              destructiveHint:
                !readOnly && contract.name !== "request_user_input_async",
              idempotentHint: readOnly,
              openWorldHint:
                !readOnly && contract.name !== "request_user_input_async",
            },
            _meta: {
              ...(this.securitySchemes
                ? { securitySchemes: this.securitySchemes }
                : {}),
              ...(contract.name === "import_file"
                ? { "openai/fileParams": ["file"] }
                : {}),
            },
          },
          async (raw, context) => {
            const args = raw as Record<string, unknown>;
            const scope = sessionScope(context);
            this.notes.observe(sessionScopeKey(scope));
            // Host-bound signed URLs stay out of the Web audit, just as with exec.files.
            const auditArgs = { ...args };
            if (contract.name === "import_file") {
              auditArgs.file = fileAuditMetadata(args.file as HostFile);
            }
            const tracker = this.activity.startCall({
              tool: contract.name,
              sessionId: sessionScopeKey(scope) ?? "unscoped",
              args: auditArgs,
            });
            const attachments: NativeContext["attachments"] = {
              items: [],
              bytes: 0,
            };
            try {
              if (!this.ready) throw new Error("服务正在关闭。");
              const signal = context.mcpReq.signal;
              throwIfAborted(signal);
              const cwd = await this.workdir(
                contract.name === "apply_patch"
                  ? (args.workdir as string | undefined)
                  : undefined,
              );
              const input =
                contract.name === "apply_patch"
                  ? args.patch
                  : contract.name === "import_file"
                    ? {
                        index: 0,
                        destination: args.destination,
                        overwrite: args.overwrite,
                      }
                    : args;
              const value = await this.callNative(contract.name, input, {
                cwd,
                explicitWorkdir: false,
                scope,
                signal,
                attachments,
                files:
                  contract.name === "import_file"
                    ? [args.file as HostFile]
                    : undefined,
              });
              const failed = subcallFailed(value);
              const result = this.notes.attach(
                directResult(
                  contract.name,
                  value,
                  failed,
                  attachments.items
                    .filter((item) => this.artifacts.available(item.id, scope))
                    .map((item) => item.content),
                ),
                sessionScopeKey(scope),
                tracker.id,
                context.mcpReq.signal,
              );
              tracker.finish({
                status:
                  contract.name === "write_stdin" &&
                  args.terminate === true &&
                  value &&
                  typeof value === "object" &&
                  "exit_code" in value
                    ? "terminated"
                    : failed
                      ? "error"
                      : value &&
                          typeof value === "object" &&
                          "session_id" in value
                        ? "yielding"
                        : "completed",
                output: result,
              });
              return result;
            } catch (error) {
              const result = toolError(error);
              result.content.push(
                ...attachments.items
                  .filter((item) => this.artifacts.available(item.id, scope))
                  .map((item) => item.content),
              );
              const response = this.notes.attach(
                boundModelOutput(result),
                sessionScopeKey(scope),
                tracker.id,
                context.mcpReq.signal,
              );
              tracker.finish({
                status: "error",
                error: error instanceof Error ? error.message : String(error),
                output: response,
              });
              return response;
            }
          },
        );
      }
    };
    server.registerTool(
      "exec",
      {
        title: "执行工具代码",
        description: execDescription(this.native, this.idleHours),
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
        this.notes.observe(sessionScopeKey(scope));
        const callArgs: CallRecord["args"] = {
          ...(args.source !== undefined ? { source: args.source } : {}),
          ...(args.workdir !== undefined ? { workdir: args.workdir } : {}),
          ...(args.yield_time_ms !== undefined
            ? { yield_time_ms: args.yield_time_ms }
            : {}),
          ...(args.max_output_tokens !== undefined
            ? { max_output_tokens: args.max_output_tokens }
            : {}),
          ...(args.files !== undefined
            ? {
                files: args.files.map(fileAuditMetadata),
              }
            : {}),
        };
        const callTracker = this.activity.startCall({
          tool: "exec",
          sessionId: sessionScopeKey(scope) ?? "unscoped",
          args: callArgs,
        });
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
        try {
          if (!this.ready) throw new Error("服务正在关闭。");
          const signal = context.mcpReq.signal;
          throwIfAborted(signal);
          const cwd = await this.workdir(args.workdir);
          const tools = this.native.map((contract) =>
            bindNative(contract, async (input, nested) => {
              const subcallStart = Date.now();
              try {
                const subcallResult = await this.callNative(
                  contract.name,
                  input,
                  {
                    cwd,
                    explicitWorkdir: args.workdir !== undefined,
                    scope,
                    files: args.files,
                    signal: nested.signal,
                    attachments,
                  },
                );
                callTracker.recordSubcall({
                  name: contract.name,
                  durationMs: Date.now() - subcallStart,
                  input,
                  output: subcallResult,
                  status: subcallFailed(subcallResult) ? "error" : "success",
                });
                return subcallResult;
              } catch (subErr) {
                callTracker.recordSubcall({
                  name: contract.name,
                  durationMs: Date.now() - subcallStart,
                  input,
                  error:
                    subErr instanceof Error ? subErr.message : String(subErr),
                  status: "error",
                });
                throw subErr;
              }
            }),
          );
          const downstream = this.discovery.snapshot();
          let codeModeState: "yielded" | "completed" | "terminated" | undefined;
          const execResult = await this.codeMode.exec({
            source: args.source,
            ...(callTracker.id === "audit-disabled"
              ? {}
              : { requestId: callTracker.id }),
            takeAttachments,
            ...(args.max_output_tokens === undefined
              ? {}
              : { maxOutputTokens: args.max_output_tokens }),
            tools: [
              ...tools,
              ...downstream.map((tool) => ({
                ...tool,
                call: async (...parameters: Parameters<typeof tool.call>) => {
                  const started = Date.now();
                  try {
                    const result = await tool.call(...parameters);
                    callTracker.recordSubcall({
                      name: tool.name,
                      input: parameters[0],
                      output: result,
                      durationMs: Date.now() - started,
                      status: subcallFailed(result) ? "error" : "success",
                    });
                    return result;
                  } catch (error) {
                    callTracker.recordSubcall({
                      name: tool.name,
                      input: parameters[0],
                      error:
                        error instanceof Error ? error.message : String(error),
                      durationMs: Date.now() - started,
                      status: "error",
                    });
                    throw error;
                  }
                },
              })),
            ],
            ...(args.yield_time_ms === undefined
              ? {}
              : { yieldTimeMs: args.yield_time_ms }),
            ...(scope === undefined ? {} : { sessionScope: scope }),
            signal,
            onState: (state) => {
              codeModeState = state;
            },
          });
          const result = this.notes.attach(
            boundModelOutput(execResult),
            sessionScopeKey(scope),
            callTracker.id,
            context.mcpReq.signal,
          );
          callTracker.finish({
            status: execResult.isError
              ? "error"
              : codeModeState === "yielded"
                ? "yielding"
                : codeModeState === "terminated"
                  ? "terminated"
                  : "completed",
            output: result,
          });
          return result;
        } catch (error) {
          const result = toolError(error);
          result.content.push(...takeAttachments());
          const response = this.notes.attach(
            boundModelOutput(result),
            sessionScopeKey(scope),
            callTracker.id,
            context.mcpReq.signal,
          );
          callTracker.finish({
            status: "error",
            error: error instanceof Error ? error.message : String(error),
            output: response,
          });
          return response;
        }
      },
    );
    server.registerTool(
      "wait",
      {
        title: "等待执行",
        description: WAIT_DESCRIPTION,
        inputSchema: WAIT_SCHEMA,
        annotations,
        _meta: this.securitySchemes
          ? { securitySchemes: this.securitySchemes }
          : {},
      },
      async (args, context) => {
        const scope = sessionScope(context);
        this.notes.observe(sessionScopeKey(scope));
        const waitArgs: CallRecord["args"] = {
          cell_id: args.cell_id,
          ...(args.yield_time_ms !== undefined
            ? { yield_time_ms: args.yield_time_ms }
            : {}),
          ...(args.max_tokens !== undefined
            ? { max_tokens: args.max_tokens }
            : {}),
          ...(args.terminate !== undefined
            ? { terminate: args.terminate }
            : {}),
        };
        const callTracker = this.activity.startCall({
          tool: "wait",
          sessionId: sessionScopeKey(scope) ?? "unscoped",
          args: waitArgs,
        });
        try {
          let codeModeState: "yielded" | "completed" | "terminated" | undefined;
          const waitResult = await this.codeMode.wait({
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
            onState: (state) => {
              codeModeState = state;
            },
          });
          const result = this.notes.attach(
            boundModelOutput(waitResult),
            sessionScopeKey(scope),
            callTracker.id,
            context.mcpReq.signal,
          );
          callTracker.finish({
            status: waitResult.isError
              ? "error"
              : codeModeState === "yielded"
                ? "yielding"
                : codeModeState === "terminated"
                  ? "terminated"
                  : "completed",
            output: result,
          });
          return result;
        } catch (error) {
          const result = this.notes.attach(
            boundModelOutput(toolError(error)),
            sessionScopeKey(scope),
            callTracker.id,
            context.mcpReq.signal,
          );
          callTracker.finish({
            status: "error",
            error: error instanceof Error ? error.message : String(error),
            output: result,
          });
          return result;
        }
      },
    );
    registerNativeTools();
    server.registerResource(
      "exported-file",
      new ResourceTemplate(`${ARTIFACT_URI_PREFIX}{id}`, { list: undefined }),
      {
        title: "已导出的文件",
        description:
          "显式导出的短期文件快照；不列出目录，通过本实例私有 MCP 入口读取。",
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

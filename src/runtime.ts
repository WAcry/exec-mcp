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
import { toolError } from "./results.js";
import { resolveUserPath, throwIfAborted } from "./util.js";
import { VERSION } from "./version.js";
import { ArtifactStore, ARTIFACT_URI_PREFIX } from "./files/artifacts.js";
import { listSkills } from "./skills/index.js";
import { DEFAULT_SKILL_MAX_CHARS, type SkillSetting } from "./skills/types.js";
import { resolveShell } from "./host/shell.js";
import { MEMORY_SCHEMA, MiB } from "./memory.js";
import { ActivityStore } from "./web/activity.js";
import type { CallRecord } from "./web/types.js";

function sessionScope(context: ServerContext): string | undefined {
  const meta = context.mcpReq._meta as Record<string, unknown> | undefined;
  const session = meta?.["openai/session"];
  return typeof session === "string" && session.length ? session : undefined;
}
export class ExecRuntime {
  readonly codeMode: CodeModeService;
  readonly terminal: TerminalManager;
  readonly patch = new PatchRunner();
  readonly downstream: DownstreamMcpRegistry;
  readonly discovery: ToolDiscovery;
  readonly artifacts: ArtifactStore;
  readonly activity: ActivityStore;
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
  }
  get ready(): boolean {
    return this.closing === undefined;
  }
  server(): McpServer {
    const server = new McpServer(
      { name: "exec-mcp", title: "Exec MCP", version: VERSION },
      {
        instructions:
          "所有操作通过 exec 内的工具完成；先阅读项目适用指令，保留无关改动与秘密。按工具契约处理结果和副作用。",
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
                files: args.files.map((f) => ({
                  ...(typeof f.name === "string" ? { name: f.name } : {}),
                  ...(typeof f.size === "number" ? { size: f.size } : {}),
                  ...(typeof f.type === "string" ? { type: f.type } : {}),
                })),
              }
            : {}),
        };
        const callTracker = this.activity.startCall({
          tool: "exec",
          sessionId: sessionScopeKey(scope) ?? "unscoped",
          args: callArgs,
        });
        let pending: { id: string; content: ResourceLink }[] = [];
        let pendingBytes = 0;
        const takeAttachments = () => {
          const items = pending
            .filter((item) => this.artifacts.available(item.id, scope))
            .map((item) => item.content);
          pending = [];
          pendingBytes = 0;
          return items;
        };
        try {
          if (!this.ready) throw new Error("服务正在关闭。");
          const signal = context.mcpReq.signal;
          throwIfAborted(signal);
          const cwd = await realpath(
            resolveUserPath(args.workdir ?? homedir()),
          );
          if (!(await stat(cwd)).isDirectory())
            throw new Error("workdir 必须是目录。");
          const tools = this.native.map((contract) =>
            bindNative(contract, async (input, nested) => {
              const subcallStart = Date.now();
              try {
                let subcallResult: unknown;
                switch (contract.name) {
                  case "list_skills": {
                    const requested = (input as { workdir?: string }).workdir;
                    const workdir =
                      requested === undefined
                        ? args.workdir === undefined
                          ? undefined
                          : cwd
                        : resolveUserPath(requested, cwd);
                    subcallResult = await listSkills({
                      ...(workdir === undefined ? {} : { workdir }),
                      maxChars: this.skillMaxChars,
                      config: this.skillConfig,
                      signal: nested.signal,
                    });
                    break;
                  }
                  case "import_file": {
                    const inputFile = input as {
                      index: number;
                      destination: string;
                      overwrite?: boolean;
                    };
                    const file = args.files?.[inputFile.index];
                    if (!file)
                      throw new Error(
                        "本次 exec.files 没有该索引；请通过顶层 files 传入原生文件引用。",
                      );
                    subcallResult = await this.artifacts.importFile(
                      file,
                      inputFile.destination,
                      cwd,
                      inputFile.overwrite,
                      nested.signal,
                    );
                    break;
                  }
                  case "export_file": {
                    if (pendingBytes + 4096 > 1024 * 1024)
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
                      cwd,
                      scope,
                      file.delivery,
                      file.name,
                      nested.signal,
                    );
                    const bytes = Buffer.byteLength(
                      JSON.stringify(exported.content),
                    );
                    if (pendingBytes + bytes > 1024 * 1024) {
                      await this.artifacts.revoke(exported.info.id, scope);
                      throw new Error(
                        "文件链接元数据超出单次响应预算；本次导出已撤销。",
                      );
                    }
                    pending.push({
                      id: exported.info.id,
                      content: exported.content,
                    });
                    pendingBytes += bytes;
                    subcallResult = exported.info;
                    break;
                  }
                  case "revoke_file":
                    subcallResult = await this.artifacts.revoke(
                      (input as { id: string }).id,
                      scope,
                    );
                    break;
                  case "exec_command":
                    subcallResult = await this.terminal.execCommand(
                      input as ExecCommandInput,
                      cwd,
                      nested.signal,
                    );
                    break;
                  case "write_stdin":
                    subcallResult = await this.terminal.writeStdin(
                      input as WriteStdinInput,
                      nested.signal,
                    );
                    break;
                  case "apply_patch":
                    subcallResult = await this.patch.apply(
                      input as string,
                      cwd,
                      nested.signal,
                    );
                    break;
                  case "view_image": {
                    const imgArgs = input as { path: string; detail?: string };
                    subcallResult = await viewImage(
                      resolveUserPath(imgArgs.path, cwd),
                      imgArgs.detail,
                    );
                    break;
                  }
                  case "tool_search": {
                    const searchArgs = input as {
                      query: string;
                      limit?: number;
                    };
                    subcallResult = await this.discovery.search(
                      searchArgs.query,
                      searchArgs.limit ?? 8,
                      nested.signal,
                    );
                    break;
                  }
                  default:
                    throw new Error("未知本机工具。");
                }
                callTracker.recordSubcall({
                  name: contract.name,
                  durationMs: Date.now() - subcallStart,
                  input,
                  output: subcallResult,
                  status: "success",
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
          let codeModeState: "yielded" | "completed" | "terminated" | undefined;
          const execResult = await this.codeMode.exec({
            source: args.source,
            takeAttachments,
            ...(args.max_output_tokens === undefined
              ? {}
              : { maxOutputTokens: args.max_output_tokens }),
            tools: [...tools, ...this.discovery.snapshot()],
            ...(args.yield_time_ms === undefined
              ? {}
              : { yieldTimeMs: args.yield_time_ms }),
            ...(scope === undefined ? {} : { sessionScope: scope }),
            signal,
            onState: (state) => {
              codeModeState = state;
            },
          });
          callTracker.finish({
            status: execResult.isError
              ? "error"
              : codeModeState === "yielded"
                ? "yielding"
                : codeModeState === "terminated"
                  ? "terminated"
                  : "completed",
            output: execResult,
          });
          return execResult;
        } catch (error) {
          const result = toolError(error);
          result.content.push(...takeAttachments());
          callTracker.finish({
            status: "error",
            error: error instanceof Error ? error.message : String(error),
            output: result,
          });
          return result;
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
        const waitArgs: CallRecord["args"] = {
          cell_id: args.cell_id,
          ...(args.yield_time_ms !== undefined
            ? { yield_time_ms: args.yield_time_ms }
            : {}),
          ...(args.max_tokens !== undefined
            ? { max_output_tokens: args.max_tokens }
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
          callTracker.finish({
            status: waitResult.isError
              ? "error"
              : codeModeState === "yielded"
                ? "yielding"
                : codeModeState === "terminated"
                  ? "terminated"
                  : "completed",
            output: waitResult,
          });
          return waitResult;
        } catch (error) {
          const result = toolError(error);
          callTracker.finish({
            status: "error",
            error: error instanceof Error ? error.message : String(error),
            output: result,
          });
          return result;
        }
      },
    );
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

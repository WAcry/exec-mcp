import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { McpServer, type ServerContext } from "@modelcontextprotocol/server";
import { CodeModeService } from "./code-mode/service.js";
import {
  NATIVE_CONTRACTS,
  bindNative,
  EXEC_SCHEMA,
  WAIT_SCHEMA,
  EXEC_DESCRIPTION,
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

function sessionScope(context: ServerContext): string | undefined {
  const meta = context.mcpReq._meta as Record<string, unknown> | undefined;
  const session = meta?.["openai/session"];
  return typeof session === "string" && session.length ? session : undefined;
}
export class ExecRuntime {
  readonly codeMode = new CodeModeService();
  readonly terminal = new TerminalManager();
  readonly patch = new PatchRunner();
  readonly downstream: DownstreamMcpRegistry;
  readonly discovery: ToolDiscovery;
  private closing: Promise<void> | undefined;
  constructor(config: Config) {
    this.downstream = new DownstreamMcpRegistry({ servers: config.mcpServers });
    this.discovery = new ToolDiscovery(this.downstream);
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
        description: EXEC_DESCRIPTION,
        inputSchema: EXEC_SCHEMA,
        annotations,
        _meta: { securitySchemes: [{ type: "noauth" }] },
      },
      async (args, context) => {
        try {
          if (!this.ready) throw new Error("服务正在关闭。");
          const signal = context.mcpReq.signal;
          throwIfAborted(signal);
          const cwd = await realpath(
            resolveUserPath(args.workdir ?? homedir()),
          );
          if (!(await stat(cwd)).isDirectory())
            throw new Error("workdir 必须是目录。");
          const tools = NATIVE_CONTRACTS.map((contract) =>
            bindNative(contract, async (input, nested) => {
              switch (contract.name) {
                case "exec_command":
                  return this.terminal.execCommand(
                    input as ExecCommandInput,
                    cwd,
                    nested.signal,
                  );
                case "write_stdin":
                  return this.terminal.writeStdin(
                    input as WriteStdinInput,
                    nested.signal,
                  );
                case "apply_patch":
                  return this.patch.apply(input as string, cwd, nested.signal);
                case "view_image": {
                  const args = input as { path: string; detail?: string };
                  return viewImage(
                    resolveUserPath(args.path, cwd),
                    args.detail,
                  );
                }
                case "tool_search": {
                  const args = input as { query: string; limit?: number };
                  return this.discovery.search(
                    args.query,
                    args.limit ?? 8,
                    nested.signal,
                  );
                }
                default:
                  throw new Error("未知本机工具。");
              }
            }),
          );
          const scope = sessionScope(context);
          return await this.codeMode.exec({
            source: args.source,
            tools: [...tools, ...this.discovery.snapshot()],
            ...(args.yield_time_ms === undefined
              ? {}
              : { yieldTimeMs: args.yield_time_ms }),
            ...(scope === undefined ? {} : { sessionScope: scope }),
            signal,
          });
        } catch (error) {
          return toolError(error);
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
        _meta: { securitySchemes: [{ type: "noauth" }] },
      },
      async (args, context) => {
        try {
          const scope = sessionScope(context);
          return await this.codeMode.wait({
            cellId: args.cell_id,
            ...(args.yield_time_ms === undefined
              ? {}
              : { yieldTimeMs: args.yield_time_ms }),
            ...(args.terminate === undefined
              ? {}
              : { terminate: args.terminate }),
            ...(scope === undefined ? {} : { sessionScope: scope }),
            signal: context.mcpReq.signal,
          });
        } catch (error) {
          return toolError(error);
        }
      },
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
      ]);
      const errors = results.filter((result) => result.status === "rejected");
      if (errors.length)
        throw new AggregateError(errors, "服务关闭时部分清理失败。");
    })();
    return this.closing;
  }
}

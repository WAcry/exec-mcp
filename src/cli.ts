#!/usr/bin/env node
import { parseArgs } from "node:util";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defaultConfigPath, initializeConfig, loadConfig } from "./config.js";
import { resolveCodexBinary, PINNED_CODEX_VERSION } from "./codex-package.js";
import { CodeModeService } from "./code-mode/service.js";
import { startServer } from "./server.js";
import { startWebServer } from "./web/server.js";
import { VERSION } from "./version.js";
import { runTunnel } from "./tunnel.js";
import { effectiveWebConfig } from "./web/config.js";
import { ActivityStore } from "./web/activity.js";

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      config: { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean" },
    },
  });
  if (values.version) {
    console.log(VERSION);
    return;
  }
  const command = positionals[0];
  if (values.help || command === undefined) {
    console.log(
      "exec-mcp：通过 exec 组合本机与 MCP 工具\n\n用法：exec-mcp init|serve|doctor|tunnel [--config 文件]\ninit   新建配置，不覆盖已有文件\nserve  在回环地址启动 MCP，按配置验证公网请求\ndoctor 检查配置、固定 Codex 组件并实际运行 V8 探针\ntunnel 为已启动的受保护服务运行 Cloudflare/Tailscale 前台客户端\n",
    );
    return;
  }
  if (positionals.length !== 1) throw new Error("只接受一个子命令。");
  const filename = values.config ?? defaultConfigPath();
  if (command === "init") {
    await initializeConfig(filename);
    console.log(`已创建配置：${filename}\n确认权限设置后运行 exec-mcp serve。`);
    return;
  }
  if (command === "doctor") {
    const config = await loadConfig(filename);
    resolveCodexBinary("codex");
    resolveCodexBinary("codex-code-mode-host");
    const code = new CodeModeService();
    try {
      const result = await code.exec({
        source: 'text("exec-mcp probe ok")',
        tools: [],
      });
      if (
        result.isError ||
        !JSON.stringify(result.content).includes("exec-mcp probe ok")
      )
        throw new Error("Code Mode 探针失败。");
      console.log(
        `配置有效；${process.platform}/${process.arch}；Codex ${PINNED_CODEX_VERSION} V8 探针通过；配置了 ${config.mcpServers.length} 个下游（未连接）。`,
      );
    } finally {
      await code.close();
    }
    return;
  }
  if (command === "tunnel") {
    const stop = new AbortController();
    const abort = () => stop.abort();
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    try {
      await runTunnel(await loadConfig(filename), {
        signal: stop.signal,
        onStarted: (plan) =>
          console.log(
            `${plan.provider} 客户端已启动，MCP 地址：${plan.publicUrl}\n公网连通性以客户端状态和实际访问为准；Ctrl+C 仅停止本次 Tunnel。`,
          ),
      });
    } finally {
      process.removeListener("SIGINT", abort);
      process.removeListener("SIGTERM", abort);
    }
    return;
  }
  if (command !== "serve") throw new Error(`未知子命令：${command}`);
  const config = await loadConfig(filename);
  const web = effectiveWebConfig(config.web);
  const activity = new ActivityStore({ enabled: web.enabled });
  const startup = new AbortController();
  const cancelStartup = () => startup.abort(new Error("启动已取消。"));
  process.once("SIGINT", cancelStartup);
  process.once("SIGTERM", cancelStartup);
  let server: Awaited<ReturnType<typeof startServer>>;
  try {
    server = await startServer(config, {
      activity,
      signal: startup.signal,
      onDownstreamProgress: (event) =>
        console.error(
          event.status === "connecting"
            ? `下游 MCP ${JSON.stringify(event.server)}：正在连接并读取全部工具…`
            : event.status === "ready"
              ? `下游 MCP ${JSON.stringify(event.server)}：已加载 ${event.tools} 个工具。`
              : event.message,
        ),
    });
  } finally {
    process.removeListener("SIGINT", cancelStartup);
    process.removeListener("SIGTERM", cancelStartup);
  }

  let webServer: Awaited<ReturnType<typeof startWebServer>> | undefined;
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    const tasks = [server.close(), ...(webServer ? [webServer.close()] : [])];
    void Promise.allSettled(tasks).then((results) => {
      if (results.some((result) => result.status === "rejected")) {
        console.error("服务关闭时发生清理错误。");
        process.exitCode = 1;
      }
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  if (web.enabled) {
    try {
      webServer = await startWebServer(server.runtime, config, {
        port: web.port,
        host: web.host,
        configPath: filename,
        mcpUrl: server.url,
      });
    } catch (error) {
      server.runtime.activity.disable();
      console.warn(
        `Web UI 服务启动失败，MCP 仍可使用：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (stopping) {
    await webServer?.close();
    return;
  }

  const webMsg = webServer
    ? `\nWeb UI 控制台：\n  - 本机访问：${webServer.loopbackUrl}${
        webServer.lanUrls.length
          ? `\n  - 局域网访问（链接片段含本次启动密钥）：\n${webServer.lanUrls.map((url) => `    ${url}`).join("\n")}`
          : ""
      }`
    : "";

  console.log(
    `exec-mcp ${VERSION} 已就绪：${server.url}${webMsg}\n${
      config.access === "public"
        ? `公网认证已启用，外部地址：${config.public_url}/mcp；在另一个终端运行 exec-mcp tunnel。`
        : "仅允许受信任的 OpenAI 私有 Tunnel；不要公开此无认证端口。"
    }`,
  );
}
// Node resolves the entry module through symlinks (/var -> /private/var on
// macOS, npm bin links, etc.); argv[1] is not a canonical module identity.
// Canonical paths also work on the supported Node releases predating import.meta.main.
let entrypoint = false;
try {
  entrypoint =
    !!process.argv[1] &&
    realpathSync(process.argv[1]) ===
      realpathSync(fileURLToPath(import.meta.url));
} catch {
  /* An imported module need not have a filesystem entrypoint. */
}
if (entrypoint) {
  void main().catch((error) => {
    console.error(
      `exec-mcp：${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}

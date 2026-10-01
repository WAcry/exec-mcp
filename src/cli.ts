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
import { ConfigEditor } from "./web/config-edit.js";
import { ServiceController } from "./service-controller.js";
import { runWithToken, WITH_TOKEN_USAGE } from "./with-token.js";
import { SessionNotes } from "./session-notes.js";
import { sessionNotesPath } from "./session-notes-file.js";
import { ProtocolCounter } from "./http/protocol-stats.js";

export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv[0] === "with-token") {
    if (argv.length === 2 && (argv[1] === "--help" || argv[1] === "-h")) {
      console.log(WITH_TOKEN_USAGE);
      return;
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    try {
      process.exitCode = await runWithToken(argv.slice(1), controller.signal);
    } finally {
      process.removeListener("SIGINT", abort);
      process.removeListener("SIGTERM", abort);
    }
    return;
  }
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
      `exec-mcp: Use exec to combine local tools and MCP tools.\n\nUsage: exec-mcp init|serve|doctor|tunnel [--config FILE]\ninit        Create a configuration file. It does not replace an existing file.\nserve       Start MCP on the loopback address. Check public requests as the configuration specifies.\ndoctor      Check the configuration and the pinned Codex parts, then run a real V8 probe.\ntunnel      Run the Cloudflare or Tailscale client in the foreground for a running protected server.\nwith-token  Put a protected token file into the environment of a program, then start the program.\n${WITH_TOKEN_USAGE}\n`,
    );
    return;
  }
  if (positionals.length !== 1) throw new Error("Give only one subcommand.");
  const filename = values.config ?? defaultConfigPath();
  if (command === "init") {
    await initializeConfig(filename);
    console.log(
      `Created the configuration: ${filename}\nCheck the permission settings, then run exec-mcp serve.`,
    );
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
        throw new Error("The Code Mode probe failed.");
      console.log(
        `The configuration is valid. Platform: ${process.platform}/${process.arch}. The Codex ${PINNED_CODEX_VERSION} V8 probe passed. Configured downstream MCP servers: ${config.mcpServers.length} (not connected).`,
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
            `The ${plan.provider} client started. MCP address: ${plan.publicUrl}\nTo know if public access works, check the client status and make a real request. Ctrl+C stops only this tunnel.`,
          ),
      });
    } finally {
      process.removeListener("SIGINT", abort);
      process.removeListener("SIGTERM", abort);
    }
    return;
  }
  if (command !== "serve")
    throw new Error(`Unknown subcommand: ${command}. Run exec-mcp --help.`);
  const editor = new ConfigEditor(filename);
  const initial = await editor.read();
  const config = initial.config;
  const web = effectiveWebConfig(config.web);
  const activity = new ActivityStore({ enabled: web.enabled });
  // Conversation messages outlive the process; audit records stay in memory.
  const notes = new SessionNotes(undefined, undefined, {
    file: sessionNotesPath(filename),
  });
  const startup = new AbortController();
  const cancelStartup = () => startup.abort(new Error("Startup was canceled."));
  process.once("SIGINT", cancelStartup);
  process.once("SIGTERM", cancelStartup);
  let server: Awaited<ReturnType<typeof startServer>>;
  try {
    server = await startServer(config, {
      activity,
      notes,
      protocol: new ProtocolCounter(),
      signal: startup.signal,
      onDownstreamProgress: (event) =>
        console.error(
          event.status === "connecting"
            ? `Downstream MCP ${JSON.stringify(event.server)}: connecting and reading all tools…`
            : event.status === "ready"
              ? `Downstream MCP ${JSON.stringify(event.server)}: loaded ${event.tools} tools.`
              : event.message,
        ),
    });
  } finally {
    process.removeListener("SIGINT", cancelStartup);
    process.removeListener("SIGTERM", cancelStartup);
  }

  let webServer: Awaited<ReturnType<typeof startWebServer>> | undefined;
  let displayedWeb = web;
  const controller = new ServiceController(
    editor,
    { server, config, revision: initial.revision },
    {
      onReady: async () => {
        const next = controller.current;
        const nextWeb = effectiveWebConfig(next.config.web);
        // Preserve the current tab/token for unchanged listeners; rebind only explicit changes.
        if (
          JSON.stringify(nextWeb) !== JSON.stringify(displayedWeb) ||
          (nextWeb.enabled && !webServer)
        ) {
          await webServer?.close();
          webServer = undefined;
          displayedWeb = nextWeb;
          if (nextWeb.enabled) {
            try {
              webServer = await startWebServer(
                next.server.runtime,
                next.config,
                {
                  host: nextWeb.host,
                  port: nextWeb.port,
                  configPath: filename,
                  mcpUrl: next.server.url,
                  controller,
                },
              );
            } catch {
              next.server.runtime.activity.disable();
              console.error(
                "The exec service restarted, but the Web UI cannot listen. Check the [web] settings.",
              );
            }
          }
        }
        console.log(
          `The exec service restarted: ${next.server.url}${webServer ? `\nWeb UI: ${webServer.loopbackUrl}` : ""}`,
        );
      },
      onProgress: (event) => {
        if (event.status === "error") console.error(event.message);
      },
    },
  );
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    const tasks = [
      controller.close(),
      ...(webServer ? [webServer.close()] : []),
    ];
    void Promise.allSettled(tasks).then(async (results) => {
      // Last, so changes from calls that ended during shutdown are saved too.
      await notes.close();
      if (results.some((result) => result.status === "rejected")) {
        console.error("A cleanup error occurred while the service stopped.");
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
        controller,
      });
    } catch (error) {
      server.runtime.activity.disable();
      console.warn(
        `The Web UI did not start. MCP is still available: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (stopping) {
    await webServer?.close();
    return;
  }

  const webMsg = webServer
    ? `\nWeb UI console:\n  - Local access: ${webServer.loopbackUrl}${
        webServer.lanUrls.length
          ? `\n  - LAN access (the link fragment contains the Web access key):\n${webServer.lanUrls.map((url) => `    ${url}`).join("\n")}`
          : ""
      }`
    : "";

  console.log(
    `exec-mcp ${VERSION} is ready: ${server.url}${webMsg}\n${
      config.access === "public"
        ? `Public authentication is on. External address: ${config.public_url}/mcp. Run exec-mcp tunnel in another terminal.`
        : "Use only a trusted OpenAI private tunnel. This port has no authentication. Do not make it public."
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
      `exec-mcp: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}

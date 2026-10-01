import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { startServer } from "../src/server.js";
import { ServiceController } from "../src/service-controller.js";
import { ActivityStore } from "../src/web/activity.js";
import { ConfigEditor } from "../src/web/config-edit.js";
import { startWebServer } from "../src/web/server.js";
import { jsonOutput } from "./helpers.js";
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), "exec-restart-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "config.toml");
  await writeFile(
    file,
    '[server]\naccess="openai-tunnel"\nhost="127.0.0.1"\nport=0\n[web]\nenabled=true\nhost="127.0.0.1"\nport=0\n',
  );
  const editor = new ConfigEditor(file);
  const first = await editor.read();
  // Like the CLI: the audit records calls when the Web console is on.
  const server = await startServer(first.config, {
    activity: new ActivityStore({ enabled: true }),
  });
  const controller = new ServiceController(editor, {
    server,
    config: first.config,
    revision: first.revision,
  });
  cleanups.push(() => controller.close());
  const web = await startWebServer(server.runtime, first.config, {
    controller,
    configPath: file,
  });
  cleanups.push(() => web.close());
  const connect = async () => {
    const client = new Client({ name: "restart-test", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(controller.current.server.url)),
    );
    cleanups.push(() => client.close());
    return client;
  };
  return { dir, file, editor, controller, web, connect };
}

describe("managed runtime replacement", () => {
  it("restarts with fresh native store and the same conversation while retaining the Web listener", async () => {
    const s = await setup();
    const client = await s.connect();
    const meta = { "openai/session": "stable-chat" };
    const saved = await client.callTool({
      name: "exec",
      arguments: {
        source: 'store("old",42);text(load("old"));',
      },
      _meta: meta,
    });
    expect(saved.isError).not.toBe(true);
    expect(jsonOutput(saved)).toBe(42);
    const a = s.controller.restart(),
      b = s.controller.restart();
    expect(a).toBe(b);
    await a;
    expect(s.controller.state).toBe("ready");
    expect(s.controller.generation).toBe(2);
    const next = await s.connect();
    const result = await next.callTool({
      name: "exec",
      arguments: { source: 'text({empty:load("old")===undefined});' },
      _meta: meta,
    });
    expect(result.isError).not.toBe(true);
    expect(jsonOutput(result)).toEqual({ empty: true });
    const status = await fetch(new URL("api/status", s.web.loopbackUrl));
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ status: "ready" });
  });
  it("keeps call history and streams the new runtime's calls right after a restart", async () => {
    const s = await setup();
    const client = await s.connect();
    const meta = { "openai/session": "history-chat" };
    await client.callTool({
      name: "exec",
      arguments: { source: "text('before restart')" },
      _meta: meta,
    });
    const stream = await fetch(new URL("api/events", s.web.loopbackUrl));
    expect(stream.status).toBe(200);
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    const events: { type: string; state?: string }[] = [];
    let pending = "";
    const until = async (
      match: (event: { type: string; state?: string }) => boolean,
    ) => {
      while (!events.some(match)) {
        const { value, done } = await reader.read();
        if (done) throw new Error("The event stream ended.");
        pending += decoder.decode(value, { stream: true });
        const frames = pending.split("\n\n");
        pending = frames.pop() ?? "";
        for (const frame of frames)
          for (const line of frame.split("\n"))
            if (line.startsWith("data: "))
              events.push(JSON.parse(line.slice(6)));
      }
    };
    cleanups.push(() => reader.cancel().catch(() => undefined));
    await until((event) => event.type === "connected");

    await s.controller.restart();
    await until((event) => event.type === "runtime" && event.state === "ready");
    expect(
      events.filter((event) => event.type === "runtime").map((e) => e.state),
    ).toEqual(["restarting", "ready"]);

    // No Web request in between: the stream must already follow the new runtime.
    const next = await s.connect();
    await next.callTool({
      name: "exec",
      arguments: { source: "text('after restart')" },
      _meta: meta,
    });
    await until((event) => event.type === "call:finish");
    expect(events.map((event) => event.type)).not.toContain("call:clear");

    const calls = (await (
      await fetch(new URL("api/calls?pageSize=10", s.web.loopbackUrl))
    ).json()) as { items: { args: { source: string } }[] };
    expect(calls.items.map((call) => call.args.source)).toEqual([
      "text('after restart')",
      "text('before restart')",
    ]);
  });
  it("keeps management recoverable after startup failure, allowing a configured MCP to be switched off and retried", async () => {
    const s = await setup();
    const original = await readFile(s.file, "utf8");
    await writeFile(
      s.file,
      original +
        '\n[mcp_servers.broken]\ncommand="exec-mcp-no-such-process"\nstartup_timeout_sec=1\n',
    );
    await expect(s.controller.restart()).rejects.toThrow();
    expect(s.controller.state).toBe("error");
    const state = (await (
      await fetch(new URL("api/management", s.web.loopbackUrl))
    ).json()) as { revision: string; state: string };
    expect(state.state).toBe("error");
    const saved = await fetch(new URL("api/config/toggle", s.web.loopbackUrl), {
      method: "POST",
      headers: { "x-exec-web": "1", "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "mcp",
        name: "broken",
        enabled: false,
        revision: state.revision,
      }),
    });
    expect(saved.status).toBe(200);
    await s.controller.restart();
    expect(s.controller.state).toBe("ready");
    const list = (await (
      await fetch(new URL("api/mcp-servers", s.web.loopbackUrl))
    ).json()) as {
      servers: { name: string; enabled: boolean; active: boolean }[];
    };
    expect(list.servers).toContainEqual({
      name: "broken",
      transport: "stdio",
      enabled: false,
      active: false,
    });
    const next = await s.connect();
    expect(
      (await next.callTool({ name: "exec", arguments: { source: "text(42)" } }))
        .isError,
    ).not.toBe(true);
  });
  it("rejects cross-origin or unmarked management writes and leaves invalid TOML visible for correction", async () => {
    const s = await setup();
    expect(
      (
        await fetch(new URL("api/runtime/restart", s.web.loopbackUrl), {
          method: "POST",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(new URL("api/runtime/restart", s.web.loopbackUrl), {
          method: "POST",
          headers: {
            "x-exec-web": "1",
            Origin: "https://foreign.example.test",
          },
        })
      ).status,
    ).toBe(403);
    await writeFile(s.file, "invalid = [");
    await expect(s.controller.restart()).rejects.toThrow();
    expect(s.controller.current.server.runtime.ready).toBe(true);
    expect(
      (await fetch(new URL("api/management", s.web.loopbackUrl))).status,
    ).toBe(422);
  });
  it("closes safely during an in-flight restart without reopening a listener", async () => {
    const s = await setup();
    let release!: () => void;
    const original = s.editor.read.bind(s.editor);
    s.editor.read = async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return original();
    };
    const restart = s.controller.restart().catch(() => undefined);
    const stopping = s.controller.close();
    release();
    await restart;
    await stopping;
    expect(s.controller.state).toBe("stopped");
    await expect(s.controller.restart()).rejects.toThrow("stopped");
  });
});

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
} from "@modelcontextprotocol/client";
import { startServer } from "../src/server.js";
import { startWebServer } from "../src/web/server.js";
import { ActivityStore } from "../src/web/activity.js";
import { ArtifactStore } from "../src/files/artifacts.js";
import { sessionScopeKey } from "../src/code-mode/service.js";
import { ServiceController } from "../src/service-controller.js";
import { ConfigEditor } from "../src/web/config-edit.js";
import { cellId, jsonOutput, nodeCommand } from "./helpers.js";
import { TOP_LEVEL_TOOL_NAMES } from "../src/tool-names.js";
import { modelTextBytes } from "../src/session-notes.js";
import type { SessionNotesPage } from "../src/session-notes-types.js";
import type { SessionSummary } from "../src/web/types.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function directory() {
  const root = await mkdtemp(path.join(tmpdir(), "exec-notes-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function clientFor(url: string, legacy = false) {
  const client = new Client(
    { name: "notes-test", version: "1" },
    { versionNegotiation: { mode: legacy ? "legacy" : "auto" } },
  );
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  cleanups.push(() => client.close());
  return client;
}
function webApi(url: string) {
  return (
    route: string,
    method = "GET",
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(new URL(route, url), {
      method,
      headers: {
        "x-exec-web": "1",
        "Content-Type": "application/json",
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
}
const scopeA = "original-chat-A";
const scopeB = "original-chat-B";
const hashA = sessionScopeKey(scopeA)!;
const noteBlocks = (response: CallToolResult) =>
  response.content.filter(
    (c) => c.type === "text" && c.text.startsWith("用户补充（来源："),
  );

async function fixture(legacy = false) {
  const root = await directory();
  const bytes = Buffer.from("imported fixture");
  const artifacts = new ArtifactStore(undefined, {
    download: async () =>
      Object.assign(Readable.from([bytes]), {
        headers: { "content-length": String(bytes.length) },
      }),
  });
  const activity = new ActivityStore({ maxCalls: 2 });
  const config = {
    host: "127.0.0.1" as const,
    port: 0,
    access: "openai-tunnel" as const,
    mcpServers: [],
  };
  const server = await startServer(config, { artifacts, activity });
  cleanups.push(() => server.close());
  const web = await startWebServer(server.runtime, config, {
    port: 0,
    publicDir: root,
  });
  cleanups.push(() => web.close());
  const client = await clientFor(server.url, legacy);
  const api = webApi(web.loopbackUrl);
  const call = (
    name: string,
    args: Record<string, unknown>,
    scope: string | undefined = scopeA,
  ) =>
    client.callTool({
      name,
      arguments: args,
      ...(scope === undefined ? {} : { _meta: { "openai/session": scope } }),
    });
  await call("tool_search", { query: "apply_patch", limit: 1 });
  await call("tool_search", { query: "apply_patch", limit: 1 }, scopeB);
  const send = async (id: string, text: string, target = hashA) => {
    const response = await api(`/api/sessions/${target}/notes`, "POST", {
      id,
      text,
    });
    expect(response.status, await response.clone().text()).toBe(200);
    return response.json();
  };
  const page = async (target = hashA) =>
    (await (
      await api(`/api/sessions/${target}/notes`)
    ).json()) as SessionNotesPage;
  return { root, server, web, client, api, call, send, page, activity };
}

describe.each([false, true])(
  "Web side notes over actual MCP (legacy=%s)",
  (legacy) => {
    it("keeps all ten tools unchanged, delivers via every outer entry and preserves files/media", async () => {
      const f = await fixture(legacy);
      const listed = (await f.client.listTools()).tools;
      expect(listed.map((t) => t.name)).toEqual(TOP_LEVEL_TOOL_NAMES);
      expect(JSON.stringify(listed)).not.toMatch(
        /ack_user_input|request_user_input_async|get_user_input/,
      );
      const outputFile = path.join(f.root, "output.txt");
      const image = path.join(f.root, "pixel.png");
      await writeFile(outputFile, "export fixture");
      await writeFile(
        image,
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZAAAAABJRU5ErkJggg==",
          "base64",
        ),
      );
      const process = jsonOutput<{ session_id: string }>(
        await f.call("exec_command", {
          cmd: nodeCommand("setInterval(()=>{},1000);"),
          yield_time_ms: 0,
        }),
      );
      const cell = cellId(
        await f.call("exec", {
          source: "yield_control();await new Promise(()=>{});",
        }),
      );
      const inputs: Record<string, Record<string, unknown>> = {
        exec: { source: "text(7);", max_output_tokens: 0 },
        wait: { cell_id: cell, yield_time_ms: 0, max_tokens: 0 },
        list_skills: {},
        import_file: {
          file: {
            file_id: "fixture",
            download_url: "https://fixture.example/input",
          },
          destination: path.join(f.root, "input.txt"),
        },
        export_file: { path: outputFile },
        exec_command: {
          cmd: nodeCommand('console.log("command")'),
          yield_time_ms: 0,
        },
        write_stdin: { session_id: process.session_id, yield_time_ms: 0 },
        apply_patch: {
          workdir: f.root,
          patch:
            "*** Begin Patch\n*** Add File: patch.txt\n+fixture\n*** End Patch\n",
        },
        view_image: { path: image },
        tool_search: { query: "apply_patch", limit: 1 },
      };
      for (const name of TOP_LEVEL_TOOL_NAMES) {
        await f.send(`note-${name}`, `user supplement for ${name}`);
        const response = await f.call(name, inputs[name]!);
        expect(response.isError, JSON.stringify(response)).not.toBe(true);
        expect(noteBlocks(response)).toEqual([
          expect.objectContaining({
            text: expect.stringContaining(`user supplement for ${name}`),
          }),
        ]);
        expect(modelTextBytes(response)).toBeLessThanOrEqual(37_000);
        if (name === "view_image")
          expect(response.content.some((c) => c.type === "image")).toBe(true);
        if (name === "export_file")
          expect(response.content.some((c) => c.type === "resource_link")).toBe(
            true,
          );
        expect((await f.page()).pendingCount).toBe(0);
      }
      await f.call("wait", { cell_id: cell, terminate: true });
      expect((await f.page()).items).toHaveLength(10);
      expect(
        noteBlocks(await f.call("tool_search", { query: "write_stdin" })),
      ).toHaveLength(0);
    });

    it("isolates conversations and missing metadata; discovery/resource reads do not drain pending notes", async () => {
      const f = await fixture(legacy);
      const file = path.join(f.root, "resource.txt");
      await writeFile(file, "resource fixture");
      const exported = await f.call("export_file", { path: file });
      const resource = exported.content.find(
        (c) => c.type === "resource_link",
      )!;
      if (resource.type !== "resource_link")
        throw new Error("missing resource link");
      await f.send("private-a", "ONLY_A");
      expect(
        noteBlocks(
          await f.call("tool_search", { query: "apply_patch" }, scopeB),
        ),
      ).toHaveLength(0);
      const noScope = await f.client.callTool({
        name: "tool_search",
        arguments: { query: "apply_patch" },
      });
      expect(noteBlocks(noScope)).toHaveLength(0);
      await f.client.listTools();
      await f.client.readResource({
        uri: resource.uri,
        _meta: { "openai/session": scopeA },
      });
      expect((await f.page()).pendingCount).toBe(1);
      expect(
        (
          await f.api("/api/sessions/unscoped/notes", "POST", {
            id: "id",
            text: "not routed",
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await f.api("/api/sessions/not-a-real-hash/notes", "POST", {
            id: "id",
            text: "not routed",
          })
        ).status,
      ).toBe(404);
      const second = await clientFor(f.server.url, legacy);
      const response = await second.callTool({
        name: "view_image",
        arguments: { path: path.join(f.root, "missing.png") },
        _meta: { "openai/session": scopeA },
      });
      expect(response.isError).toBe(true);
      expect(noteBlocks(response)).toHaveLength(1);
      expect(JSON.stringify(await f.page())).not.toContain(scopeA);
      await f.send("error", "ALSO_ON_SYNTAX_ERROR");
      const syntax = await f.call("exec", { source: "const = ;" });
      expect(syntax.isError).toBe(true);
      expect(noteBlocks(syntax)).toHaveLength(1);
    });

    it("picks up notes submitted during write_stdin and wait without waking the running task", async () => {
      const f = await fixture(legacy);
      for (const nested of [false, true]) {
        const gate = path.join(f.root, `gate-${nested}`);
        const first = jsonOutput<{ session_id: string }>(
          await f.call("exec_command", {
            cmd: nodeCommand(
              `const fs=require('node:fs');setInterval(()=>{if(fs.existsSync(${JSON.stringify(gate)}))process.exit(0);else console.log('progress');},30);`,
            ),
            yield_time_ms: 0,
          }),
        );
        const args = { session_id: first.session_id };
        const id = nested
          ? cellId(
              await f.call("exec", {
                source: `text(await tools.write_stdin(${JSON.stringify(args)}));`,
                yield_time_ms: 0,
              }),
            )
          : undefined;
        let settled = false;
        const pending = (
          nested ? f.call("wait", { cell_id: id }) : f.call("write_stdin", args)
        ).finally(() => {
          settled = true;
        });
        const session = f.server.runtime.terminal["sessions"].get(
          first.session_id,
        )!;
        await vi.waitFor(
          () => expect(session.exitReady).toBeTypeOf("function"),
          { timeout: 10_000 },
        );
        await f.send(`during-${nested}`, "supplement during long operation");
        expect(settled).toBe(false);
        expect((await f.page()).pendingCount).toBe(1);
        await writeFile(gate, "done");
        const response = await pending;
        expect(noteBlocks(response)).toHaveLength(1);
        expect(response.isError).not.toBe(true);
      }
    });

    it("does not consume a pending note when an in-flight terminal observer is cancelled", async () => {
      const f = await fixture(legacy);
      const first = jsonOutput<{ session_id: string }>(
        await f.call("exec_command", {
          cmd: nodeCommand("setInterval(()=>{},1000);"),
          yield_time_ms: 0,
        }),
      );
      const controller = new AbortController();
      const pending = f.client.callTool(
        {
          name: "write_stdin",
          arguments: { session_id: first.session_id },
          _meta: { "openai/session": scopeA },
        },
        { signal: controller.signal },
      );
      const rejected = expect(pending).rejects.toThrow();
      const session = f.server.runtime.terminal["sessions"].get(
        first.session_id,
      )!;
      await vi.waitFor(() => expect(session.exitReady).toBeTypeOf("function"), {
        timeout: 10_000,
      });
      await f.send("cancelled-observer", "still queued");
      controller.abort();
      await rejected;
      await vi.waitFor(() => expect(session.observers).toBe(0), {
        timeout: 10_000,
      });
      expect((await f.page()).pendingCount).toBe(1);
      expect(session.exitCode).toBeUndefined();
      const next = await f.call("write_stdin", {
        session_id: first.session_id,
        yield_time_ms: 0,
      });
      expect(noteBlocks(next)).toHaveLength(1);
    });

    it("retains messages and manual labels through audit eviction/clear, keeps original text and rejects cross-site changes", async () => {
      const f = await fixture(legacy);
      await f.api(`/api/sessions/${hashA}`, "PATCH", { label: "My task" });
      const text = "用户补充\n  preserve whitespace\n<script>not HTML</script>";
      await f.send("retry", text);
      await f.send("retry", text);
      expect((await f.page()).items).toHaveLength(1);
      for (let i = 0; i < 3; i++)
        await f.call("tool_search", { query: "exec_command" }, scopeB);
      await f.api("/api/calls", "DELETE");
      const groups = (await (
        await f.api("/api/sessions?search=My%20task")
      ).json()) as { items: SessionSummary[] };
      expect(groups.items).toEqual([
        expect.objectContaining({
          id: hashA,
          label: "My task",
          pendingNotes: 1,
        }),
      ]);
      expect((await f.page()).items[0]!.text).toBe(text);
      const route = `/api/sessions/${hashA}/notes`;
      expect(
        (
          await f.api(
            route,
            "POST",
            { id: "cross", text: "not accepted" },
            { Origin: "https://evil.example" },
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await fetch(new URL(route, f.web.loopbackUrl), {
            method: "POST",
            body: JSON.stringify({
              id: "missing-header",
              text: "not accepted",
            }),
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await f.api(route, "POST", {
            id: "too-big",
            text: "汉".repeat(10_001),
          })
        ).status,
      ).toBe(413);
      const escaped = "\u0001".repeat(29_999) + "x";
      await f.send("escaped", escaped); // Encoded JSON is larger than the usual 64 KB admin cap.
      expect((await f.page()).items.at(-1)!.text).toBe(escaped);
      await f.api(`${route}/retry`, "DELETE");
      expect((await f.page()).items[0]!.status).toBe("withdrawn");
    });
  },
);

it("keeps the same notes store across an execution-service restart, not a new conversation or database", async () => {
  const root = await directory();
  const configPath = path.join(root, "config.toml");
  await writeFile(
    configPath,
    '[server]\naccess="openai-tunnel"\nport=0\n[web]\nenabled=true\nport=0\n',
  );
  const editor = new ConfigEditor(configPath);
  const saved = await editor.read();
  const server = await startServer(saved.config, {
    activity: new ActivityStore(),
  });
  const controller = new ServiceController(editor, {
    server,
    config: saved.config,
    revision: saved.revision,
  });
  cleanups.push(() => controller.close());
  const web = await startWebServer(server.runtime, saved.config, {
    port: 0,
    controller,
    publicDir: root,
  });
  cleanups.push(() => web.close());
  const api = webApi(web.loopbackUrl);
  const client = await clientFor(server.url);
  await client.callTool({
    name: "exec",
    arguments: { source: "store('old',1);" },
    _meta: { "openai/session": scopeA },
  });
  expect(
    (
      await api(`/api/sessions/${hashA}/notes`, "POST", {
        id: "restart",
        text: "keep this message",
      })
    ).status,
  ).toBe(200);
  await api(`/api/sessions/${hashA}`, "PATCH", { label: "manual" });
  await controller.restart();
  expect(controller.current.server.runtime.notes).toBe(server.runtime.notes);
  const page = (await (
    await api(`/api/sessions/${hashA}/notes`)
  ).json()) as SessionNotesPage;
  expect(page.label).toBe("manual");
  expect(page.pendingCount).toBe(1);
  const next = await clientFor(controller.current.server.url);
  const response = await next.callTool({
    name: "exec",
    arguments: { source: "text({empty:load('old')===undefined});" },
    _meta: { "openai/session": scopeA },
  });
  expect(jsonOutput(response)).toEqual({ empty: true });
  expect(noteBlocks(response)).toHaveLength(1);
  expect(await readFile(configPath, "utf8")).not.toContain("keep this message");
});

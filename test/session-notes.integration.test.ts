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
import type { UserQuestionsPage } from "../src/user-questions-types.js";

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
const noteBlocks = (response: CallToolResult) => {
  if (response.structuredContent !== undefined) {
    // Model consumers may read only structuredContent when it is present.
    expect(response.content.some((item) => item.type === "text")).toBe(false);
    const envelope = response.structuredContent as { user_notes?: string[] };
    return (envelope.user_notes ?? []).map((text) => ({
      type: "text" as const,
      text: `用户额外补充：\n${text}`,
    }));
  }
  return response.content.filter(
    (c) => c.type === "text" && c.text.startsWith("用户额外补充：\n"),
  );
};

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
    it("streams one private notification hint for a submitted question request without changing tool acceptance", async () => {
      const f = await fixture(legacy);
      const controller = new AbortController();
      const deadline = setTimeout(() => controller.abort(), 10_000);
      try {
        const stream = await fetch(new URL("/api/events", f.web.loopbackUrl), {
          signal: controller.signal,
        });
        expect(stream.status).toBe(200);
        const reader = stream.body!.getReader();
        let buffer = "";
        const decoder = new TextDecoder();
        const next = async (): Promise<Record<string, unknown>> => {
          while (true) {
            const boundary = buffer.indexOf("\n\n");
            if (boundary >= 0) {
              const line = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              if (line.startsWith("data: ")) return JSON.parse(line.slice(6));
            } else {
              const chunk = await reader.read();
              if (chunk.done)
                throw new Error("Event stream ended before question delivery");
              buffer += decoder.decode(chunk.value, { stream: true });
            }
          }
        };
        expect((await next()).type).toBe("connected");
        const accepted = jsonOutput<{ accepted: boolean; request_id: string }>(
          await f.call("request_user_input_async", {
            questions: [
              {
                title: "PRIVATE_QUESTION",
                options: ["PRIVATE_A", "PRIVATE_B"],
              },
            ],
          }),
        );
        expect(accepted.accepted).toBe(true);
        let hint;
        do {
          hint = await next();
        } while (hint.type !== "session:notes");
        expect(hint).toEqual({
          type: "session:notes",
          sessionId: hashA,
          questionRequest: { id: accepted.request_id, count: 1 },
        });
        expect(JSON.stringify(hint)).not.toContain("PRIVATE_");
        expect(f.server.runtime.notes.questions(hashA).pendingCount).toBe(1);
        await reader.cancel();
      } finally {
        clearTimeout(deadline);
        controller.abort();
      }
    });
    it("submits once from either entry, groups questions by conversation and sends Web answers through user_notes", async () => {
      const f = await fixture(legacy);
      const input = {
        request_key: "database",
        questions: [
          { title: "Which database?", options: ["SQLite", "PostgreSQL"] },
          { title: "How to roll out?", options: ["Tests first", "Deploy now"] },
        ],
      };
      const accepted = jsonOutput<{ accepted: true; request_id: string }>(
        await f.call("request_user_input_async", input),
      );
      expect(accepted).toEqual({
        accepted: true,
        request_id: expect.stringMatching(/^ask_/),
      });
      const repeated = await f.call("exec", {
        source: `text(await tools.request_user_input_async(${JSON.stringify(input)}));`,
      });
      expect(jsonOutput(repeated)).toEqual(accepted);
      const grouped = (await (
        await f.api("/api/sessions?pendingQuestions=true")
      ).json()) as { pendingQuestionsTotal: number; items: SessionSummary[] };
      expect(grouped.pendingQuestionsTotal).toBe(2);
      expect(grouped.items).toHaveLength(1);
      expect(grouped.items[0]).toMatchObject({
        id: hashA,
        pendingQuestions: 2,
        questionPreview: "Which database?",
      });
      const questions = (await (
        await f.api(`/api/sessions/${hashA}/questions`)
      ).json()) as UserQuestionsPage;
      expect(questions.items.map((q) => q.title)).toEqual(
        input.questions.map((q) => q.title),
      );
      expect(questions.items.every((q) => q.pending && !q.answer)).toBe(true);
      const answer = {
        id: "choice",
        option_index: 0,
        note: "先只实现接口，不要迁移旧数据。\n  保留这行缩进。",
      };
      const url = `/api/sessions/${hashA}/questions/${questions.items[0]!.id}/answer`;
      expect(
        (
          await f.api(url, "POST", answer, {
            Origin: "https://untrusted.example",
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await f.api(url, "POST", {
            ...answer,
            title: "browser rewrites original",
          })
        ).status,
      ).toBe(400);
      const submitted = await f.api(url, "POST", answer);
      expect(submitted.status).toBe(200);
      const saved = await submitted.json();
      expect(await (await f.api(url, "POST", answer)).json()).toEqual(saved);
      expect(
        (
          await f.api(url, "POST", {
            ...answer,
            id: "conflicting",
            option_index: 1,
          })
        ).status,
      ).toBe(409);
      expect(
        (
          await f.api(
            `/api/sessions/${sessionScopeKey(scopeB)}/questions/${questions.items[0]!.id}/answer`,
            "POST",
            answer,
          )
        ).status,
      ).toBe(404);
      await f.send("after-answer", "其他工作继续");
      expect(
        noteBlocks(
          await f.call("tool_search", { query: "apply_patch" }, scopeB),
        ),
      ).toHaveLength(0);
      const response = await f.call("tool_search", {
        query: "apply_patch",
        limit: 1,
      });
      expect(response.content).toEqual([]);
      expect(response.structuredContent).toMatchObject({
        user_notes: [
          `问题：Which database?\n选择：SQLite\n补充：${answer.note}`,
          "其他工作继续",
        ],
      });
      expect(JSON.stringify(response)).not.toContain(questions.items[0]!.id);
      expect((await f.api(url, "POST", answer)).status).toBe(200); // Lost Web acknowledgements never enqueue again.
      expect((await f.page()).pendingCount).toBe(0);
      const second = await f.api(
        `/api/sessions/${hashA}/questions/${questions.items[1]!.id}/answer`,
        "POST",
        { id: "custom", option_index: null, note: "先做影子流量验证。" },
      );
      expect(second.status).toBe(200);
      const failed = await f.call("exec", { source: "const = ;" });
      expect(failed.isError).toBe(true);
      expect(noteBlocks(failed)).toEqual([
        {
          type: "text",
          text: "用户额外补充：\n问题：How to roll out?\n选择：以上都不是\n补充：先做影子流量验证。",
        },
      ]);
      const detail = f.activity.getCalls({ tool: "request_user_input_async" });
      // Audit is deliberately tiny in this fixture; the questions outlive its eviction.
      expect(detail.total).toBe(0);
      expect(
        (await (await f.api(`/api/sessions/${hashA}/questions`)).json())
          .pendingCount,
      ).toBe(0);
    });

    it("requires actual Web availability and a scope, without creating or polling a global question box", async () => {
      const f = await fixture(legacy);
      const args = { questions: [{ title: "Choose?", options: ["A", "B"] }] };
      const missing = await f.client.callTool({
        name: "request_user_input_async",
        arguments: args,
      });
      expect(missing.isError).toBe(true);
      expect(JSON.stringify(missing)).toContain("对话标识");
      const before = await f.api(`/api/sessions/${hashA}/questions`);
      expect((await before.json()).total).toBe(0);
      await f.web.close();
      const unavailable = await f.call("request_user_input_async", args);
      expect(unavailable.isError).toBe(true);
      expect(JSON.stringify(unavailable)).toContain("Web");
      expect(
        (await f.call("exec", { source: "text('ordinary work continues');" }))
          .isError,
      ).not.toBe(true);
    });

    it("accepts Web answers during a long terminal wait without waking it or leaking answers into another conversation", async () => {
      const f = await fixture(legacy);
      await f.call("request_user_input_async", {
        questions: [
          { title: "Keep compatibility?", options: ["Keep", "Remove"] },
        ],
      });
      const q = (
        (await (
          await f.api(`/api/sessions/${hashA}/questions`)
        ).json()) as UserQuestionsPage
      ).items[0]!;
      const gate = path.join(f.root, "answer-wait-gate");
      const first = jsonOutput<{ session_id: string }>(
        await f.call("exec_command", {
          cmd: nodeCommand(
            `const fs=require('node:fs');setInterval(()=>{if(fs.existsSync(${JSON.stringify(gate)}))process.exit(0);else console.log('still working');},25);`,
          ),
          yield_time_ms: 0,
        }),
      );
      let completed = false;
      const pending = f
        .call("write_stdin", { session_id: first.session_id })
        .finally(() => {
          completed = true;
        });
      await vi.waitFor(
        () =>
          expect(
            f.server.runtime.terminal["sessions"].get(first.session_id)!
              .exitReady,
          ).toBeTypeOf("function"),
        { timeout: 10_000 },
      );
      expect(
        (
          await f.api(
            `/api/sessions/${hashA}/questions/${q.id}/answer`,
            "POST",
            { id: "during-wait", option_index: 0, note: "Node 20 too." },
          )
        ).status,
      ).toBe(200);
      expect(completed).toBe(false);
      await writeFile(gate, "done");
      const result = await pending;
      expect(result.structuredContent).toMatchObject({
        result: { exit_code: 0 },
        user_notes: [
          "问题：Keep compatibility?\n选择：Keep\n补充：Node 20 too.",
        ],
      });
    });

    it("delivers notes via every outer entry, including asynchronous questions, and preserves files/media", async () => {
      const f = await fixture(legacy);
      const listed = (await f.client.listTools()).tools;
      expect(listed.map((t) => t.name)).toEqual(TOP_LEVEL_TOOL_NAMES);
      expect(JSON.stringify(listed)).not.toMatch(
        /ack_user_input|get_user_input/,
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
        request_user_input_async: {
          questions: [
            { title: "Use which mode?", options: ["First", "Second"] },
          ],
        },
      };
      for (const name of TOP_LEVEL_TOOL_NAMES) {
        await f.send(`note-${name}`, `user supplement for ${name}`);
        const response = await f.call(name, inputs[name]!);
        expect(response.isError, JSON.stringify(response)).not.toBe(true);
        expect(noteBlocks(response)).toEqual([
          { type: "text", text: `用户额外补充：\nuser supplement for ${name}` },
        ]);
        if (response.structuredContent !== undefined) {
          expect(response.structuredContent).toHaveProperty("result");
          expect(response.structuredContent).toHaveProperty("user_notes", [
            `user supplement for ${name}`,
          ]);
        }
        expect(JSON.stringify(response)).not.toContain(`note-${name}`);
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
      expect((await f.page()).items).toHaveLength(TOP_LEVEL_TOOL_NAMES.length);
      expect(
        noteBlocks(await f.call("tool_search", { query: "write_stdin" })),
      ).toHaveLength(0);
    });

    it("keeps a running terminal handle and short user messages in structuredContent without a text mirror", async () => {
      const f = await fixture(legacy);
      const first = jsonOutput<{ session_id: string }>(
        await f.call("exec_command", {
          cmd: nodeCommand(
            'setInterval(()=>console.log("sleep progress"),20);',
          ),
          yield_time_ms: 0,
        }),
      );
      const session = f.server.runtime.terminal["sessions"].get(
        first.session_id,
      )!;
      await vi.waitFor(() => expect(session.buffer.pending).toBe(true), {
        timeout: 10_000,
      });
      const text = "请说明收到了 side note；这次 sleep 也用于验证投递。";
      await f.send("private-note-id", text);
      const response = await f.call("write_stdin", {
        session_id: first.session_id,
        yield_time_ms: 0,
      });
      expect(response.content).toEqual([]);
      expect(response.structuredContent).toMatchObject({
        result: {
          output: expect.stringContaining("sleep progress"),
          session_id: first.session_id,
        },
        user_notes: [text],
      });
      expect(JSON.stringify(response)).not.toMatch(
        /private-note-id|Web 操作者|用户补充（来源/,
      );
      const record = f.activity.getCalls({ tool: "write_stdin" }).items[0]!;
      expect(record.output).toMatchObject({
        content: [],
        structuredContent: response.structuredContent,
      });
      expect((await f.page()).items[0]).toMatchObject({
        id: "private-note-id",
        sequence: 1,
        status: "attached",
        callId: record.id,
      });
      const next = await f.call("write_stdin", {
        session_id: first.session_id,
        terminate: true,
      });
      expect(next.structuredContent).toHaveProperty("exit_code");
      expect(next.structuredContent).not.toHaveProperty("user_notes");
    });

    it.each([0, 50_000])(
      "preserves a failed command with notes in its selected output channel (padding=%s)",
      async (padding) => {
        const f = await fixture(legacy);
        await f.send("oversized-result-note", "用户限制仍需保留。");
        const response = await f.call("exec_command", {
          cmd: nodeCommand(
            `process.stdout.write("BEGIN"+"x".repeat(${padding})+"END",()=>process.exit(3));`,
          ),
          yield_time_ms: 10_000,
        });
        expect(response.isError).toBe(true);
        if (padding) {
          expect(response.structuredContent).toBeUndefined();
          expect(JSON.stringify(response)).toContain("保留首尾");
        } else {
          expect(response.content).toEqual([]);
          expect(response.structuredContent).toMatchObject({
            result: { output: "BEGINEND", exit_code: 3 },
            user_notes: ["用户限制仍需保留。"],
          });
        }
        expect(noteBlocks(response)).toEqual([
          { type: "text", text: "用户额外补充：\n用户限制仍需保留。" },
        ]);
        const encoded = JSON.stringify(response);
        expect(encoded).toContain("BEGIN");
        expect(encoded).toContain("END");
        expect(modelTextBytes(response)).toBeLessThanOrEqual(37_000);
        expect((await f.page()).pendingCount).toBe(0);
      },
    );

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

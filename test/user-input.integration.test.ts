import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
} from "@modelcontextprotocol/client";
import { startServer } from "../src/server.js";
import { startWebServer } from "../src/web/server.js";
import { UserInputStore } from "../src/user-input/store.js";
import { sessionScopeKey } from "../src/code-mode/service.js";
import type { AnswerEvent } from "../src/user-input/contracts.js";
import { jsonOutput, texts, cellId } from "./helpers.js";
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function setup(legacy: boolean, web = true) {
  const dir = await mkdtemp(path.join(tmpdir(), "exec-question-mcp-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const store = new UserInputStore(path.join(dir, "questions.sqlite3"));
  cleanup.push(() => store.close());
  const config = {
    host: "127.0.0.1" as const,
    port: 0,
    access: "openai-tunnel" as const,
    mcpServers: [],
    web: { enabled: web, host: "127.0.0.1" as const, port: 0 },
  };
  const server = await startServer(config, { userInput: store });
  cleanup.push(() => server.close());
  const console = web
    ? await startWebServer(server.runtime, config)
    : undefined;
  if (console) cleanup.push(() => console.close());
  const client = new Client(
    { name: "question-test", version: "1" },
    { versionNegotiation: { mode: legacy ? "legacy" : "auto" } },
  );
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
  cleanup.push(() => client.close());
  const call = (
    source: string,
    scope: string | undefined = "chat-a",
    extra: Record<string, unknown> = {},
  ) =>
    client.callTool({
      name: "exec",
      arguments: { source, ...extra },
      ...(scope ? { _meta: { "openai/session": scope } } : {}),
    });
  return { dir, store, config, server, console, client, call };
}
function answers(result: CallToolResult) {
  return texts(result)
    .filter((text) => text.startsWith("用户答复（"))
    .map(
      (text) => JSON.parse(text.slice(text.indexOf("\n") + 1)) as AnswerEvent,
    );
}
const request = {
  request_key: "choice",
  questions: [{ title: "使用哪种存储？", options: ["SQLite", "Postgres"] }],
};
const createSource = `const accepted=await tools.request_user_input_async(${JSON.stringify(request)});text(accepted);text('independent work continues');`;
function respond(store: UserInputStore, id: string, notes = "先不要迁移数据") {
  return store.answer(id, {
    question_id: "q1",
    expected_revision: 0,
    selected_option_id: "o1",
    notes,
  });
}

describe.each([false, true])(
  "asynchronous questions on the real MCP/host (legacy=%s)",
  (legacy) => {
    it("creates without waiting, exposes no Widget, and delivers exact answers until the originating conversation acknowledges", async () => {
      const s = await setup(legacy);
      const tools = (await s.client.listTools()).tools;
      expect(tools.map((tool) => tool.name)).toEqual(["exec", "wait"]);
      expect(JSON.stringify(tools)).not.toMatch(
        /outputTemplate|ui\/resourceUri|elicitation/,
      );
      const created = await s.call(createSource);
      expect(created.isError).not.toBe(true);
      expect(texts(created)).toContain("independent work continues");
      const id = jsonOutput<{ request_id: string }>(created).request_id;
      expect(answers(created)).toEqual([]);
      respond(s.store, id);
      const other = await s.call('text("other conversation")', "chat-b");
      expect(answers(other)).toEqual([]);
      const first = await s.call('text("regular output")');
      const event = answers(first)[0]!;
      expect(event).toMatchObject({
        request_id: id,
        answer_from_user: {
          selected_option_label: "SQLite",
          notes: "先不要迁移数据",
        },
      });
      expect(first.structuredContent).toBeUndefined();
      expect(texts(first)).toContain("regular output");
      const duplicate = await s.call("text(1)");
      expect(answers(duplicate)[0]!.event_id).toBe(event.event_id);
      const wrong = await s.call('text("MUST_NOT_RUN")', "chat-b", {
        ack_user_input: [event.event_id],
      });
      expect(wrong.isError).toBe(true);
      expect(texts(wrong)).not.toContain("MUST_NOT_RUN");
      expect(answers(wrong)).toEqual([]);
      const acked = await s.call('text("after reading answer")', "chat-a", {
        ack_user_input: [event.event_id],
      });
      expect(acked.isError).not.toBe(true);
      expect(answers(acked)).toEqual([]);
      const again = await s.call("text(2)", "chat-a", {
        ack_user_input: [event.event_id],
      });
      expect(again.isError).not.toBe(true);
      const state = await s.call(
        `text(await tools.get_user_input({request_id:${JSON.stringify(id)}}))`,
      );
      expect(
        jsonOutput<{
          questions: { answer: { notes: string; delivery: string } }[];
        }>(state).questions[0]!.answer,
      ).toMatchObject({ notes: "先不要迁移数据", delivery: "acknowledged" });
    });
    it("requires a scope and an available Web UI, not merely a live MCP connection or configured checkbox", async () => {
      const s = await setup(legacy);
      const noScope = await s.client.callTool({
        name: "exec",
        arguments: { source: createSource },
      });
      expect(noScope.isError).toBe(true);
      expect(texts(noScope).join("\n")).toContain("openai/session");
      await s.console!.close();
      const noWeb = await s.call(createSource);
      expect(noWeb.isError).toBe(true);
      expect(texts(noWeb).join("\n")).toContain("Web UI");
      expect(s.store.list().total).toBe(0);
      const off = await setup(legacy, false);
      expect(
        (await off.client.listTools()).tools[0]!.description,
      ).not.toContain("request_user_input_async");
    });
    it("attaches answers on errors, zero output budgets and waits where the answer arrives after waiting began", async () => {
      const s = await setup(legacy);
      const id = jsonOutput<{ request_id: string }>(
        await s.call(createSource),
      ).request_id;
      const running = await s.call(
        'yield_control();await new Promise(resolve=>setTimeout(resolve,300));text("finished");',
      );
      const pending = s.client.callTool({
        name: "wait",
        arguments: {
          cell_id: cellId(running),
          yield_time_ms: 5000,
          max_tokens: 0,
        },
        _meta: { "openai/session": "chat-a" },
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      respond(s.store, id);
      const final = await pending;
      expect(final.isError).not.toBe(true);
      expect(answers(final)).toHaveLength(1);
      expect(texts(final).join("\n")).toContain("Script completed");
      const badSyntax = await s.call("const a = ;");
      expect(badSyntax.isError).toBe(true);
      expect(answers(badSyntax)).toHaveLength(1);
      const invalidCell = await s.client.callTool({
        name: "wait",
        arguments: { cell_id: "missing", max_tokens: 0 },
        _meta: { "openai/session": "chat-a" },
      });
      expect(invalidCell.isError).toBe(true);
      expect(answers(invalidCell)).toHaveLength(1);
    });
    it("reserves space for complete answer records without breaking native attachments or the 36000-byte ceiling", async () => {
      const s = await setup(legacy);
      const id = jsonOutput<{ request_id: string }>(
        await s.call(createSource),
      ).request_id;
      const notes = '说明"\\\n' + "完整意见".repeat(400);
      respond(s.store, id, notes);
      await writeFile(path.join(s.dir, "result.txt"), "artifact data");
      const result = await s.call(
        'text("HEAD"+"x".repeat(100000)+"TAIL");await tools.export_file({path:"result.txt"});',
        "chat-a",
        { workdir: s.dir },
      );
      expect(result.isError).not.toBe(true);
      expect(Buffer.byteLength(texts(result).join("\n\n"))).toBeLessThanOrEqual(
        36000,
      );
      expect(answers(result)[0]!.answer_from_user.notes).toBe(notes);
      const links = result.content.filter(
        (item) => item.type === "resource_link",
      );
      expect(links).toHaveLength(1);
      expect(
        (await s.client.readResource({ uri: links[0]!.uri })).contents,
      ).toHaveLength(1);
    });
    it("stores Web choice plus notes, rejects concurrent stale submissions and protects the API with existing Web boundaries", async () => {
      const s = await setup(legacy);
      const id = jsonOutput<{ request_id: string }>(
        await s.call(createSource),
      ).request_id;
      const base = s.console!.loopbackUrl;
      const send = (body: unknown, header = true) =>
        fetch(new URL(`api/user-input/${id}`, base), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(header ? { "x-exec-web": "1" } : {}),
          },
          body: JSON.stringify(body),
        });
      const body = {
        question_id: "q1",
        expected_revision: 0,
        selected_option_id: "o2",
        notes: "保持所有旧数据\n第二行",
      };
      expect((await send(body, false)).status).toBe(403);
      expect((await send({ ...body, question_id: "no-question" })).status).toBe(
        404,
      );
      const saved = await send(body);
      expect(saved.status).toBe(200);
      expect((await send({ ...body, notes: "stale tab" })).status).toBe(409);
      const list = (await (
        await fetch(new URL("api/user-input", base))
      ).json()) as { items: { questions: { answer: { notes: string } }[] }[] };
      expect(list.items[0]!.questions[0]!.answer.notes).toBe(body.notes);
      const cross = await fetch(new URL(`api/user-input/${id}`, base), {
        headers: { Origin: "https://evil.example.test" },
      });
      expect(cross.status).toBe(403);
      expect(
        answers(await s.call("text(1)"))[0]!.answer_from_user
          .selected_option_label,
      ).toBe("Postgres");
    });
    it("keeps a durable answer accessible after native session retirement and uses explicit events rather than hidden _meta", async () => {
      const s = await setup(legacy);
      const id = jsonOutput<{ request_id: string }>(
        await s.call(createSource),
      ).request_id;
      respond(s.store, id);
      await s.server.runtime.codeMode.close();
      // A failed exec on the retired host is still an opportunity to receive a saved answer.
      const result = await s.call('text("closed host")');
      expect(result.isError).toBe(true);
      expect(answers(result)[0]!.request_id).toBe(id);
      expect(JSON.stringify(result._meta ?? {})).not.toContain(id);
      expect(
        s.store.getForScope(sessionScopeKey("chat-a"), id).questions[0]!.answer
          ?.notes,
      ).toBe("先不要迁移数据");
    });
  },
);

// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../App";
import { AuthProvider } from "../../context/AuthContext";
import { LocaleProvider } from "../../context/LocaleContext";
import { ThemeProvider } from "../../context/ThemeContext";
import { LANGUAGE_KEY } from "../../lib/locale";
import { messages } from "../../lib/messages";
import type {
  CallListItem,
  LiveEvent,
  NotesResponse,
  QuestionsResponse,
  SessionsResponse,
  StatusResponse,
} from "../../types";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

class FakeEventSource {
  static all: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((message: { data: string }) => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeEventSource.all.push(this);
  }
  close() {
    this.closed = true;
  }
}

interface Request {
  method: string;
  path: string;
  body?: unknown;
}
type Reply = { status?: number; body: unknown };

const SESSION = "chat-1";
let requests: Request[];
let routes: Map<string, (request: Request) => Reply>;
let root: Root | undefined;

function fixture(options: { question: boolean }) {
  const now = Date.now();
  const iso = (ago: number) => new Date(now - ago).toISOString();
  const call: CallListItem = {
    id: "call-1",
    sessionId: SESSION,
    tool: "exec",
    status: "completed",
    startedAt: iso(60_000),
    endedAt: iso(59_000),
    durationMs: 1000,
    args: { source: 'text("hello timeline")' },
    subcallCount: 0,
    truncated: false,
    steps: [],
  };
  const status = {
    status: "ready",
    generation: 1,
    version: "1.0.0",
    uptime: 10,
    isLoopback: true,
    mcp: { host: "127.0.0.1", port: 8891, access: "openai-tunnel" },
    web: {
      host: "127.0.0.1",
      port: 8893,
      exposed: false,
      loopbackUrl: "http://127.0.0.1:8893/",
      lanUrls: [],
    },
    stats: {
      totalCalls: 1,
      activeSessions: 1,
      errorCalls: 0,
      runningCalls: 0,
      avgDurationMs: 1000,
      truncatedFields: 0,
      omittedSubcalls: 0,
    },
    memory: {
      highWaterBytes: 1,
      highWaterMib: 1,
      status: "normal",
      idleRetentionHours: 1,
    },
    system: {
      hostname: "test-host",
      platform: "linux",
      arch: "x64",
      nodeVersion: "20",
    },
  } satisfies StatusResponse;
  const sessions: SessionsResponse = {
    items: [
      {
        id: SESSION,
        label: "Build chat",
        callCount: 1,
        errorCount: 0,
        firstSeen: iso(70_000),
        lastActive: iso(40_000),
        pendingQuestions: options.question ? 1 : 0,
        unreadMessages: 1,
        canMessage: true,
      },
    ],
    total: 1,
    page: 1,
    pageSize: 100,
    totalPages: 1,
    pendingQuestionsTotal: options.question ? 1 : 0,
  };
  const notes: NotesResponse = {
    sessionId: SESSION,
    label: "Build chat",
    pendingCount: 0,
    pendingQuestions: options.question ? 1 : 0,
    items: [
      {
        id: "note-1",
        sequence: 1,
        text: "check the staging logs",
        createdAt: iso(55_000),
        status: "attached",
        attachedAt: iso(54_000),
        callId: "call-1",
      },
    ],
    agentMessages: [
      { id: "msg-1", text: "Build finished", createdAt: iso(40_000) },
    ],
    page: 1,
    totalPages: 1,
    maxMessageBytes: 30_000,
    retentionHours: 72,
  };
  const questions: QuestionsResponse = {
    items: options.question
      ? [
          {
            id: "q-1",
            requestId: "ask-1",
            title: "Which branch?",
            options: ["main", "dev"],
            createdAt: iso(45_000),
            pending: true,
          },
        ]
      : [],
    pendingCount: options.question ? 1 : 0,
    total: options.question ? 1 : 0,
    page: 1,
    totalPages: 1,
  };
  const ok = (body: unknown) => () => ({ body });
  routes = new Map<string, (request: Request) => Reply>([
    ["GET /api/status", ok(status)],
    ["GET /api/sessions", ok(sessions)],
    ["GET /api/native-sessions", ok({ sessions: [], memory: status.memory })],
    ["GET /api/terminals", ok({ sessions: [] })],
    ["GET /api/management", ok({ available: false })],
    [
      "GET /api/calls",
      ok({ items: [call], total: 1, page: 1, pageSize: 50, totalPages: 1 }),
    ],
    ["GET /api/sessions/chat-1/notes", ok(notes)],
    ["GET /api/sessions/chat-1/questions", ok(questions)],
    ["POST /api/sessions/chat-1/messages/read", ok({ success: true })],
  ]);
}

beforeEach(() => {
  vi.useFakeTimers();
  requests = [];
  FakeEventSource.all = [];
  localStorage.setItem(LANGUAGE_KEY, "en");
  window.location.hash = "#/c/" + SESSION;
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const url = new URL(input, "http://127.0.0.1:8893");
      const request: Request = {
        method: (init.method ?? "GET").toUpperCase(),
        path: url.pathname,
        ...(typeof init.body === "string"
          ? { body: JSON.parse(init.body) }
          : {}),
      };
      requests.push(request);
      const route = routes.get(request.method + " " + request.path);
      const reply = route
        ? route(request)
        : { status: 404, body: { error: "not_found", message: "Unknown" } };
      const status = reply.status ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => reply.body,
      } as Response;
    }),
  );
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function settle(ms = 1000) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      <LocaleProvider>
        <ThemeProvider>
          <AuthProvider>
            <App />
          </AuthProvider>
        </ThemeProvider>
      </LocaleProvider>,
    ),
  );
  await settle();
  return container;
}

async function openStream() {
  const source = FakeEventSource.all.at(-1)!;
  await act(async () => source.onopen?.());
  await settle();
  return {
    source,
    async send(event: LiveEvent) {
      await act(async () =>
        source.onmessage?.({ data: JSON.stringify(event) }),
      );
      await settle();
    },
    async fail() {
      await act(async () => source.onerror?.());
    },
  };
}

function click(element: Element | null | undefined) {
  expect(element).toBeTruthy();
  act(() => {
    (element as HTMLElement).click();
  });
}

function button(scope: ParentNode, text: string) {
  return [...scope.querySelectorAll("button")].find((item) =>
    item.textContent?.includes(text),
  );
}

const count = (path: string) =>
  requests.filter((request) => request.path === path).length;

describe("conversation view", () => {
  it("shows calls, notes, questions and messages in one timeline", async () => {
    fixture({ question: true });
    const view = await mount();
    const text = view.textContent ?? "";
    expect(text).toContain("hello timeline");
    expect(text).toContain("check the staging logs");
    expect(text).toContain("Which branch?");
    expect(text).toContain("Build finished");
  });

  it("answers a question from the dock and translates a rejected answer", async () => {
    fixture({ question: true });
    const answers: unknown[] = [];
    let reject = true;
    routes.set("POST /api/sessions/chat-1/questions/q-1/answer", (request) => {
      answers.push(request.body);
      if (reject)
        return {
          status: 409,
          body: { error: "question_answered", message: "diagnostic only" },
        };
      return {
        body: {
          id: "note-2",
          sequence: 2,
          text: "Question: Which branch?\nSelected: main",
          createdAt: new Date().toISOString(),
          status: "pending",
          questionId: "q-1",
        },
      };
    });
    const view = await mount();
    const dock = view.querySelector(
      '[role=group][aria-label="' + messages["dock.label"].en + '"]',
    )!;
    expect(dock).toBeTruthy();
    const main = [...dock.querySelectorAll("[role=radio]")].find((item) =>
      item.textContent?.includes("main"),
    );
    click(main);
    click(button(dock, messages["question.submit"].en));
    await settle();
    expect(answers).toMatchObject([{ option_index: 0, note: "" }]);
    const alert = dock.querySelector("[role=alert]")?.textContent ?? "";
    expect(alert).toContain(messages["error.questionAnswered"].en);
    expect(alert).not.toContain("diagnostic only");

    reject = false;
    click(button(dock, messages["question.submit"].en));
    await settle();
    expect(answers).toHaveLength(2);
    expect(view.textContent).toContain(messages["question.saved"].en);
  });

  it("dismisses an unread message from the dock", async () => {
    fixture({ question: false });
    const view = await mount();
    const dock = view.querySelector(
      'section[aria-label="' + messages["agentMessage.dock"].en + '"]',
    )!;
    expect(dock.textContent).toContain("Build finished");
    click(button(dock, messages["agentMessage.dismiss"].en));
    await settle();
    expect(
      requests.filter(
        (request) => request.path === "/api/sessions/chat-1/messages/read",
      ),
    ).toMatchObject([{ method: "POST", body: { ids: ["msg-1"] } }]);
    expect(
      view.querySelector(
        'section[aria-label="' + messages["agentMessage.dock"].en + '"]',
      ),
    ).toBeNull();
  });

  it("stops list polling while the event stream is live and reloads after events", async () => {
    fixture({ question: false });
    await mount();
    const stream = await openStream();
    const before = {
      sessions: count("/api/sessions"),
      calls: count("/api/calls"),
      notes: count("/api/sessions/chat-1/notes"),
      status: count("/api/status"),
    };
    await settle(60_000);
    expect(count("/api/sessions")).toBe(before.sessions);
    expect(count("/api/calls")).toBe(before.calls);
    expect(count("/api/sessions/chat-1/notes")).toBe(before.notes);
    // Status renewal keeps the browser session alive.
    expect(count("/api/status")).toBeGreaterThan(before.status);

    await stream.send({
      type: "call:start",
      callId: "call-2",
      sessionId: SESSION,
    });
    expect(count("/api/calls")).toBe(before.calls + 1);
    await stream.send({ type: "session:notes", sessionId: SESSION });
    expect(count("/api/sessions/chat-1/notes")).toBe(before.notes + 1);

    await stream.fail();
    const offline = count("/api/calls");
    await settle(21_000);
    expect(count("/api/calls")).toBeGreaterThan(offline);
  });
});

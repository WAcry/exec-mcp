import type { CallToolResult } from "@modelcontextprotocol/client";
import { MAX_PAYLOAD_BYTES } from "./limits.js";
import { normalizeResult } from "./results.js";
import { randomHandle } from "./util.js";
import {
  REQUEST_USER_INPUT_SCHEMA,
  QUESTION_ANSWER_SCHEMA,
  type RequestUserInput,
  type QuestionAnswer,
} from "./user-questions.js";
import {
  formatUserAnswer,
  type UserQuestionRequest,
  type UserQuestionsPage,
  type UserQuestionView,
} from "./user-questions-types.js";
import type { PaginatedResult, SessionSummary } from "./web/types.js";
import {
  NOTE_LABEL_BYTES,
  NOTE_MAX_BYTES,
  NOTE_RETENTION_MS,
  NOTES_RESPONSE_BYTES,
  type SessionNote,
  type SessionNotesEvent,
  type SessionNotesPage,
} from "./session-notes-types.js";

interface Conversation {
  id: string;
  label: string;
  firstSeen: string;
  touched: number;
  sequence: number;
  notes: SessionNote[];
  requests: UserQuestionRequest[];
}

export class SessionNoteError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Count the representations the model receives, including structured-only direct results. */
export function modelTextBytes(result: CallToolResult): number {
  return (
    (result.structuredContent === undefined
      ? 0
      : Buffer.byteLength(JSON.stringify(result.structuredContent)) + 2) +
    result.content.reduce(
      (sum, item) =>
        sum + (item.type === "text" ? Buffer.byteLength(item.text) + 2 : 0),
      0,
    )
  );
}

const profileBytes = (c: Conversation) => 1024 + c.label.length * 2;
const noteBytes = (n: SessionNote) =>
  1024 + n.text.length * 2 + Buffer.byteLength(n.text);
const pendingCount = (c: Conversation) =>
  c.notes.filter((n) => n.status === "pending").length;
const requestBytes = (request: UserQuestionRequest) => {
  const value = JSON.stringify(request);
  return 1024 + value.length * 2 + Buffer.byteLength(value);
};
const questionPending = (
  c: Conversation,
  question: UserQuestionRequest["questions"][number],
) =>
  !question.answer ||
  c.notes.find((n) => n.id === question.answer!.noteId)?.status === "withdrawn";
const pendingQuestions = (c: Conversation) =>
  c.requests.reduce(
    (count, r) =>
      count + r.questions.filter((q) => questionPending(c, q)).length,
    0,
  );

/** Ephemeral user messages, independent of audit eviction and native host generations.
 * All selection/commit operations are synchronous: no reservation protocol or model-side polling.
 */
export class SessionNotes {
  private conversations = new Map<string, Conversation>();
  private bytes = 0;
  private webUsers = 0;
  private listeners = new Set<(event: SessionNotesEvent) => void>();

  constructor(
    private readonly maximumBytes = 16 * 1024 * 1024,
    private readonly now: () => number = Date.now,
  ) {}

  /** Capture conversation identities only while the management Web server is actually listening. */
  openWeb(listener: (event: SessionNotesEvent) => void): () => void {
    this.webUsers++;
    this.listeners.add(listener);
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      this.webUsers--;
      this.listeners.delete(listener);
    };
  }

  observe(id: string | undefined): void {
    if (!id || !this.webUsers) return;
    this.sweep();
    const existing = this.conversations.get(id);
    if (existing) {
      existing.touched = this.now();
      return;
    }
    // Observability capacity must not turn an otherwise valid tool call into a failure.
    if (this.bytes + 1024 > this.maximumBytes) return;
    this.conversations.set(id, {
      id,
      label: "",
      firstSeen: new Date(this.now()).toISOString(),
      touched: this.now(),
      sequence: 0,
      notes: [],
      requests: [],
    });
    this.bytes += 1024;
  }

  private require(id: string): Conversation {
    this.sweep();
    const conversation = this.conversations.get(id);
    if (!conversation)
      throw new SessionNoteError(
        404,
        "会话不存在、未提供对话标识或已过期；请等待该对话再次调用工具。",
      );
    return conversation;
  }

  rename(id: string, label: string): void {
    const conversation = this.require(id);
    if (Buffer.byteLength(label) > NOTE_LABEL_BYTES)
      throw new SessionNoteError(
        413,
        `备注名最多 ${NOTE_LABEL_BYTES} UTF-8 字节。`,
      );
    const next = label.trim();
    const delta = 2 * (next.length - conversation.label.length);
    this.admit(delta);
    conversation.label = next;
    conversation.touched = this.now();
    this.bytes += delta;
    this.emit(id);
  }

  enqueue(id: string, messageId: string, text: string): SessionNote {
    const conversation = this.require(id);
    const note = this.insertNote(conversation, messageId, text);
    this.emit(id);
    return { ...note };
  }

  private insertNote(
    conversation: Conversation,
    messageId: string,
    text: string,
    questionId?: string,
  ): SessionNote {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(messageId))
      throw new SessionNoteError(400, "消息提交 ID 无效。");
    if (!text.trim()) throw new SessionNoteError(400, "请填写补充内容。");
    if (Buffer.byteLength(text) > NOTE_MAX_BYTES)
      throw new SessionNoteError(
        413,
        `补充内容最多 ${NOTE_MAX_BYTES} UTF-8 字节。`,
      );
    const prior = conversation.notes.find((n) => n.id === messageId);
    if (prior) {
      if (prior.text !== text || prior.questionId !== questionId)
        throw new SessionNoteError(
          409,
          "同一提交 ID 的内容已改变；请作为新消息发送。",
        );
      return { ...prior };
    }
    const note: SessionNote = {
      id: messageId,
      sequence: conversation.sequence + 1,
      text,
      createdAt: new Date(this.now()).toISOString(),
      status: "pending",
      ...(questionId ? { questionId } : {}),
    };
    this.admit(noteBytes(note));
    conversation.sequence++;
    conversation.notes.push(note);
    conversation.touched = this.now();
    this.bytes += noteBytes(note);
    return { ...note };
  }

  ask(
    id: string | undefined,
    raw: RequestUserInput,
  ): { accepted: true; request_id: string } {
    if (!this.webUsers)
      throw new SessionNoteError(
        503,
        "异步提问需要已启动的 Web 控制台；请在原对话中与用户沟通。",
      );
    if (!id)
      throw new SessionNoteError(
        400,
        "宿主未提供对话标识，无法确定提问归属；请在原对话中与用户沟通。",
      );
    const input = REQUEST_USER_INPUT_SCHEMA.parse(raw);
    this.observe(id);
    const c = this.require(id);
    const existing =
      input.request_key === undefined
        ? undefined
        : c.requests.find((r) => r.request_key === input.request_key);
    if (existing) {
      if (
        JSON.stringify(
          existing.questions.map(({ title, options }) => ({ title, options })),
        ) !== JSON.stringify(input.questions)
      )
        throw new SessionNoteError(
          409,
          "同一 request_key 的问题已改变；请使用新的键。",
        );
      return { accepted: true, request_id: existing.id };
    }
    const request: UserQuestionRequest = {
      id: randomHandle("ask"),
      ...(input.request_key === undefined
        ? {}
        : { request_key: input.request_key }),
      createdAt: new Date(this.now()).toISOString(),
      touched: this.now(),
      questions: input.questions.map((q) => ({
        ...q,
        options: [...q.options],
        id: randomHandle("q"),
      })),
    };
    const cost = requestBytes(request);
    this.admit(cost);
    c.requests.push(request);
    c.touched = this.now();
    this.bytes += cost;
    this.emit(id, { id: request.id, count: request.questions.length });
    return { accepted: true, request_id: request.id };
  }

  questions(id: string, page = 1, pendingOnly = false): UserQuestionsPage {
    const c = this.require(id);
    const all: UserQuestionView[] = c.requests.toReversed().flatMap((r) =>
      r.questions.map((q) => {
        const delivery = q.answer
          ? c.notes.find((n) => n.id === q.answer!.noteId)?.status
          : undefined;
        return {
          ...structuredClone(q),
          requestId: r.id,
          createdAt: r.createdAt,
          pending: questionPending(c, q),
          ...(delivery ? { delivery } : {}),
        };
      }),
    );
    // Keep unanswered work visible even when newer requests have already been answered.
    all.sort((a, b) => Number(b.pending) - Number(a.pending));
    const filtered = pendingOnly ? all.filter((q) => q.pending) : all;
    const totalPages = Math.max(1, Math.ceil(filtered.length / 20));
    const current = Math.max(1, Math.min(page, totalPages));
    return {
      items: filtered.slice((current - 1) * 20, current * 20),
      pendingCount: pendingQuestions(c),
      total: filtered.length,
      page: current,
      totalPages,
    };
  }

  answer(id: string, questionId: string, raw: QuestionAnswer): SessionNote {
    const input = QUESTION_ANSWER_SCHEMA.parse(raw);
    const c = this.require(id);
    const request = c.requests.find((r) =>
      r.questions.some((q) => q.id === questionId),
    );
    const question = request?.questions.find((q) => q.id === questionId);
    if (!request || !question)
      throw new SessionNoteError(404, "问题不存在或已过期。");
    if (
      input.option_index !== null &&
      input.option_index >= question.options.length
    )
      throw new SessionNoteError(400, "请选择此问题提供的选项。");
    if (input.option_index === null && !input.note.trim())
      throw new SessionNoteError(400, "选择‘以上都不是’时，请填写自己的回答。");
    const text = formatUserAnswer(question, input.option_index, input.note);
    // Every admitted answer can fit even the JSON-based notes channel of a small response.
    if (
      Buffer.byteLength(text) > NOTE_MAX_BYTES ||
      Buffer.byteLength(JSON.stringify(text)) > NOTE_MAX_BYTES
    )
      throw new SessionNoteError(
        413,
        `问题、选择和补充合计最多 ${NOTE_MAX_BYTES} 字节（含 JSON 编码）；请缩短补充。`,
      );
    const noteId = `${question.id}_${input.id}`;
    const prior = c.notes.find((n) => n.id === noteId);
    if (prior) {
      if (prior.text !== text || prior.questionId !== questionId)
        throw new SessionNoteError(
          409,
          "同一次提交的答复已改变；请刷新后确认。",
        );
      return { ...prior };
    }
    if (!questionPending(c, question))
      throw new SessionNoteError(
        409,
        "此问题已在另一处回答；草稿保留，可复制为补充消息。",
      );
    const answeredAt = new Date(this.now()).toISOString();
    const answer = {
      option_index: input.option_index,
      note: input.note,
      noteId,
      answeredAt,
    };
    const replacement = {
      ...request,
      touched: this.now(),
      questions: request.questions.map((q) =>
        q === question ? { ...q, answer } : q,
      ),
    };
    const delta = requestBytes(replacement) - requestBytes(request);
    this.admit(
      delta +
        noteBytes({
          id: noteId,
          sequence: c.sequence + 1,
          text,
          createdAt: answeredAt,
          status: "pending",
        }),
    );
    const note = this.insertNote(c, noteId, text, questionId);
    question.answer = answer;
    request.touched = replacement.touched;
    this.bytes += delta;
    this.emit(id);
    return note;
  }

  withdraw(id: string, noteId: string): void {
    const conversation = this.require(id);
    const note = conversation.notes.find((n) => n.id === noteId);
    if (!note) throw new SessionNoteError(404, "消息不存在或已过期。");
    if (note.status === "attached")
      throw new SessionNoteError(
        409,
        "消息已附入工具响应，无法撤回；可再发一条补充。",
      );
    note.status = "withdrawn";
    this.emit(id);
  }

  page(id: string, page = 1): SessionNotesPage {
    const c = this.require(id);
    const totalPages = Math.max(1, Math.ceil(c.notes.length / 30));
    const current = Math.max(1, Math.min(page, totalPages));
    const end = Math.max(0, c.notes.length - (current - 1) * 30);
    return {
      sessionId: id,
      label: c.label,
      pendingCount: pendingCount(c),
      pendingQuestions: pendingQuestions(c),
      items: c.notes.slice(Math.max(0, end - 30), end).map((n) => ({ ...n })),
      page: current,
      totalPages,
      maxMessageBytes: NOTE_MAX_BYTES,
      retentionHours: NOTE_RETENTION_MS / 3_600_000,
    };
  }

  sessions(
    audit: readonly SessionSummary[],
    options: {
      page: number;
      pageSize: number;
      search?: string;
      pendingQuestionsOnly?: boolean;
    },
  ): PaginatedResult<SessionSummary> & { pendingQuestionsTotal: number } {
    this.sweep();
    const merged = new Map(
      audit.map((s) => [s.id, { ...s, canMessage: false }]),
    );
    for (const c of this.conversations.values()) {
      const previous = merged.get(c.id);
      merged.set(c.id, {
        ...(previous ?? {
          id: c.id,
          callCount: 0,
          errorCount: 0,
          firstSeen: c.firstSeen,
        }),
        lastActive: new Date(
          Math.max(c.touched, Date.parse(previous?.lastActive ?? c.firstSeen)),
        ).toISOString(),
        label: c.label,
        pendingNotes: pendingCount(c),
        pendingQuestions: pendingQuestions(c),
        questionPreview:
          c.requests
            .flatMap((r) => r.questions)
            .find((q) => questionPending(c, q))
            ?.title.slice(0, 240) ?? "",
        canMessage: true,
      });
    }
    const query = options.search?.toLowerCase();
    const all = [...merged.values()]
      .filter(
        (s) => !options.pendingQuestionsOnly || (s.pendingQuestions ?? 0) > 0,
      )
      .filter(
        (s) =>
          !query ||
          [s.id, s.label, s.lastCall?.preview].some((v) =>
            v?.toLowerCase().includes(query),
          ),
      )
      .sort(
        (a, b) =>
          b.lastActive.localeCompare(a.lastActive) || a.id.localeCompare(b.id),
      );
    const totalPages = Math.max(1, Math.ceil(all.length / options.pageSize));
    const page = Math.max(1, Math.min(options.page, totalPages));
    return {
      pendingQuestionsTotal: [...this.conversations.values()].reduce(
        (sum, c) => sum + pendingQuestions(c),
        0,
      ),
      items: all.slice((page - 1) * options.pageSize, page * options.pageSize),
      total: all.length,
      page,
      pageSize: options.pageSize,
      totalPages,
    };
  }

  /** Use spare space only. A head that does not fit holds the queue; no truncation, skipping or retry. */
  attach(
    result: CallToolResult,
    id: string | undefined,
    callId: string,
    signal?: AbortSignal,
  ): CallToolResult {
    if (!id || signal?.aborted) return result;
    this.sweep();
    const conversation = this.conversations.get(id);
    if (!conversation?.notes.some((note) => note.status === "pending"))
      return result;
    try {
      // Keep user notes in the same textual channel as the tool result. Some
      // consumers prefer structuredContent and never inspect content text.
      const structured = result.structuredContent !== undefined;
      const userNotes: string[] = [];
      const originalContent = structured
        ? (normalizeResult(result) as CallToolResult).content
        : result.content;
      const resultText = originalContent.filter((item) => item.type === "text");
      const response: CallToolResult = structured
        ? {
            ...result,
            structuredContent: {
              result: result.structuredContent,
              ...(resultText.length ? { result_content: resultText } : {}),
              user_notes: userNotes,
            },
            content: originalContent.filter((item) => item.type !== "text"),
          }
        : { ...result, content: [...result.content] };
      let remaining = NOTES_RESPONSE_BYTES - modelTextBytes(response);
      const selected: SessionNote[] = [];
      for (const note of conversation.notes) {
        if (note.status !== "pending") continue;
        const text = `用户额外补充：\n${note.text}`;
        // JSON escaping and array separators count too; do not estimate a
        // structured note using only the UTF-8 length of its unescaped text.
        const bytes = structured
          ? Buffer.byteLength(JSON.stringify(note.text)) +
            (selected.length ? 1 : 0)
          : Buffer.byteLength(text) + 2;
        if (bytes > remaining) break;
        selected.push(note);
        if (structured) userNotes.push(note.text);
        else response.content.push({ type: "text", text });
        remaining -= bytes;
      }
      if (!selected.length) return result;
      // The media/transport boundary remains independent of the model text budget.
      if (
        Buffer.byteLength(JSON.stringify(response)) > MAX_PAYLOAD_BYTES ||
        signal?.aborted
      )
        return result;
      const attachedAt = new Date(this.now()).toISOString();
      for (const note of selected) {
        note.status = "attached";
        note.attachedAt = attachedAt;
        if (callId !== "audit-disabled") note.callId = callId;
      }
      this.emit(id);
      return response;
    } catch {
      // A delivery/encoding failure cannot make an executed operation appear safe to replay.
      return result;
    }
  }

  private admit(bytes: number): void {
    if (this.bytes + bytes > this.maximumBytes)
      throw new SessionNoteError(
        429,
        "补充消息临时空间已满；请复制到原对话，或等待旧记录过期。",
      );
  }

  private sweep(): void {
    const deadline = this.now() - NOTE_RETENTION_MS;
    for (const [id, c] of this.conversations) {
      c.notes = c.notes.filter((note) => {
        if (Date.parse(note.createdAt) > deadline) return true;
        this.bytes -= noteBytes(note);
        return false;
      });
      c.requests = c.requests.filter((request) => {
        if (request.touched > deadline) return true;
        this.bytes -= requestBytes(request);
        return false;
      });
      if (!c.notes.length && !c.requests.length && c.touched <= deadline) {
        this.bytes -= profileBytes(c);
        this.conversations.delete(id);
      }
    }
  }

  private emit(
    id: string,
    questionRequest?: SessionNotesEvent["questionRequest"],
  ): void {
    for (const listener of this.listeners) {
      try {
        listener({
          type: "session:notes",
          sessionId: id,
          ...(questionRequest ? { questionRequest } : {}),
        });
      } catch {
        /* Observers never change delivery. */
      }
    }
  }
}

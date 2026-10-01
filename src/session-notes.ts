import type { CallToolResult } from "@modelcontextprotocol/client";
import { MAX_PAYLOAD_BYTES } from "./limits.js";
import { normalizeResult } from "./results.js";
import { randomHandle } from "./util.js";
import {
  SEND_MESSAGE_TO_USER_SCHEMA,
  type SendMessageToUser,
} from "./agent-messages.js";
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
import type { ApiErrorCode } from "./web/api-types.js";
import {
  NOTE_LABEL_BYTES,
  NOTE_MAX_BYTES,
  NOTE_RETENTION_MS,
  NOTES_RESPONSE_BYTES,
  TITLE_REMINDER,
  USER_NOTE_TEXT_PREFIX,
  type SessionNote,
  type AgentMessage,
  type SessionNotesEvent,
  type SessionNotesPage,
} from "./session-notes-types.js";
import {
  loadNotesFile,
  saveNotesFile,
  type StoredConversation,
} from "./session-notes-file.js";

type Conversation = StoredConversation;

export const SESSION_NOTES_BYTES = 16 * 1024 * 1024;

export class SessionNoteError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface SessionNotesOptions {
  /** JSON file that keeps the store across process restarts. */
  file?: string | undefined;
  /** One line per load problem or failed write streak. */
  log?: ((line: string) => void) | undefined;
  /** Delay before saving user or agent content. */
  saveDelayMs?: number;
  /** Delay before saving changes that only record activity. */
  touchSaveDelayMs?: number;
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
const noteBytes = (n: Pick<SessionNote, "text">) =>
  1024 + n.text.length * 2 + Buffer.byteLength(n.text);
const pendingCount = (c: Conversation) =>
  c.notes.filter((n) => n.status === "pending").length;
const requestBytes = (request: UserQuestionRequest) => {
  const value = JSON.stringify(request);
  return 1024 + value.length * 2 + Buffer.byteLength(value);
};
const conversationBytes = (c: Conversation) =>
  profileBytes(c) +
  c.notes.reduce((sum, note) => sum + noteBytes(note), 0) +
  c.requests.reduce((sum, request) => sum + requestBytes(request), 0) +
  c.messages.reduce((sum, message) => sum + noteBytes(message), 0);
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

/** How soon a change must reach the file. */
type Urgency = "now" | "soon" | "idle";

/** User messages, questions, and agent messages, independent of audit eviction and native host generations.
 * All selection/commit operations are synchronous: no reservation protocol or model-side polling.
 * With a file, the store survives process restarts; writes are debounced and atomic.
 */
export class SessionNotes {
  private conversations = new Map<string, Conversation>();
  private bytes = 0;
  private webUsers = 0;
  private listeners = new Set<(event: SessionNotesEvent) => void>();
  readonly #file: string | undefined;
  readonly #log: (line: string) => void;
  readonly #delays: Record<Urgency, number>;
  #dirty = false;
  #timer: NodeJS.Timeout | undefined;
  #deadline = Infinity;
  #queue: Promise<void> = Promise.resolve();
  #failing = false;
  #closed = false;

  constructor(
    private readonly maximumBytes = SESSION_NOTES_BYTES,
    private readonly now: () => number = Date.now,
    options: SessionNotesOptions = {},
  ) {
    this.#file = options.file;
    this.#log = options.log ?? ((line) => console.error(line));
    this.#delays = {
      now: 0,
      soon: options.saveDelayMs ?? 1000,
      idle: options.touchSaveDelayMs ?? 30_000,
    };
    if (this.#file !== undefined) this.#load(this.#file);
  }

  #load(file: string): void {
    const loaded = loadNotesFile(file);
    if (loaded.status === "missing") return;
    if (loaded.status === "rejected") {
      this.#log(
        loaded.movedTo === undefined
          ? `exec-mcp: Cannot use the saved conversation messages in ${file} because ${loaded.reason}. The file stays in place, and this run does not save messages.`
          : `exec-mcp: Cannot use the saved conversation messages because ${loaded.reason}. Moved the file to ${loaded.movedTo} and started with no messages.`,
      );
      // Never replace a file we could not move aside.
      if (loaded.movedTo === undefined) this.#closed = true;
      return;
    }
    for (const conversation of loaded.conversations) {
      if (this.conversations.has(conversation.id)) continue;
      this.conversations.set(conversation.id, conversation);
      this.bytes += conversationBytes(conversation);
    }
    this.sweep();
    if (this.bytes <= this.maximumBytes) return;
    // Only a file from another budget or a manual edit can exceed it.
    const oldest = [...this.conversations.values()].sort(
      (a, b) => a.touched - b.touched,
    );
    for (const conversation of oldest) {
      if (this.bytes <= this.maximumBytes) break;
      this.conversations.delete(conversation.id);
      this.bytes -= conversationBytes(conversation);
    }
    this.#changed("soon");
    this.#log(
      `exec-mcp: The saved conversation messages were larger than the ${this.maximumBytes}-byte budget. Removed the least recently used conversations.`,
    );
  }

  #changed(urgency: Urgency): void {
    if (this.#file === undefined || this.#closed) return;
    this.#dirty = true;
    const deadline = Date.now() + this.#delays[urgency];
    if (this.#timer !== undefined && this.#deadline <= deadline) return;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#deadline = deadline;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#deadline = Infinity;
      void this.flush();
    }, this.#delays[urgency]);
    this.#timer.unref();
  }

  /** Writes pending changes now. Saving never throws; failures are logged and retried later. */
  flush(): Promise<void> {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
      this.#deadline = Infinity;
    }
    this.#queue = this.#queue.then(() => this.#write());
    return this.#queue;
  }

  /** Saves pending changes and stops saving. Normal shutdown calls this last. */
  async close(): Promise<void> {
    await this.flush();
    this.#closed = true;
  }

  async #write(): Promise<void> {
    if (!this.#dirty || this.#file === undefined) return;
    this.#dirty = false;
    try {
      await saveNotesFile(this.#file, [...this.conversations.values()]);
      this.#failing = false;
    } catch (error) {
      this.#dirty = true;
      if (!this.#failing)
        this.#log(
          `exec-mcp: Cannot save conversation messages to ${this.#file} (${(error as NodeJS.ErrnoException).code ?? "unknown error"}). Messages stay in memory, and the next change tries again.`,
        );
      this.#failing = true;
    }
  }

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
      this.#changed("idle");
      return;
    }
    // Observability capacity must not turn an otherwise valid tool call into a failure.
    if (this.bytes + 1024 > this.maximumBytes) return;
    this.conversations.set(id, {
      id,
      label: "",
      titled: false,
      firstSeen: new Date(this.now()).toISOString(),
      touched: this.now(),
      sequence: 0,
      notes: [],
      requests: [],
      messages: [],
    });
    this.bytes += 1024;
    this.#changed("idle");
  }

  private require(id: string): Conversation {
    this.sweep();
    const conversation = this.conversations.get(id);
    if (!conversation)
      throw new SessionNoteError(
        404,
        "conversation_not_found",
        "This conversation is not known, has no ID, or has expired. Wait until it calls a tool again.",
      );
    return conversation;
  }

  rename(id: string, label: string): void {
    const conversation = this.require(id);
    if (Buffer.byteLength(label) > NOTE_LABEL_BYTES)
      throw new SessionNoteError(
        413,
        "label_too_long",
        `The name is longer than ${NOTE_LABEL_BYTES} UTF-8 bytes.`,
      );
    const next = label.trim();
    const delta = 2 * (next.length - conversation.label.length);
    this.admit(delta);
    conversation.label = next;
    conversation.touched = this.now();
    this.bytes += delta;
    this.#changed("soon");
    this.emit(id);
  }

  /** One agent title per unlabeled conversation. It runs beside real work, so nothing here throws. */
  setTitle(id: string | undefined, title: string): { set: boolean } {
    if (!id || !this.webUsers) return { set: false };
    this.observe(id);
    const c = this.conversations.get(id);
    if (!c || c.label || c.titled) return { set: false };
    let label = "";
    for (const character of title.replace(/\s+/g, " ").trim()) {
      if (Buffer.byteLength(label + character) > NOTE_LABEL_BYTES) break;
      label += character;
    }
    const delta = 2 * label.length;
    if (!label || this.bytes + delta > this.maximumBytes) return { set: false };
    c.label = label;
    c.titled = true;
    c.touched = this.now();
    this.bytes += delta;
    this.#changed("soon");
    this.emit(id);
    return { set: true };
  }

  enqueue(id: string, messageId: string, text: string): SessionNote {
    const conversation = this.require(id);
    const note = this.insertNote(conversation, messageId, text);
    this.#changed("soon");
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
      throw new SessionNoteError(
        400,
        "note_invalid_id",
        "The message ID must have 1 to 80 letters, digits, underscores, or hyphens.",
      );
    if (!text.trim())
      throw new SessionNoteError(400, "note_empty", "The message is empty.");
    if (Buffer.byteLength(text) > NOTE_MAX_BYTES)
      throw new SessionNoteError(
        413,
        "note_too_long",
        `The message is longer than ${NOTE_MAX_BYTES} UTF-8 bytes.`,
      );
    const prior = conversation.notes.find((n) => n.id === messageId);
    if (prior) {
      if (prior.text !== text || prior.questionId !== questionId)
        throw new SessionNoteError(
          409,
          "note_changed",
          "A message with this ID has different content. Send it as a new message.",
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

  sendMessage(
    id: string | undefined,
    raw: SendMessageToUser,
    callId?: string,
  ): { accepted: true } {
    if (!this.webUsers)
      throw new SessionNoteError(
        503,
        "web_unavailable",
        "The Web console is not running, so the user cannot see this message. Tell the user in your reply instead.",
      );
    if (!id)
      throw new SessionNoteError(
        400,
        "conversation_unknown",
        "The host did not send a conversation ID, so this message has no destination. Tell the user in your reply instead.",
      );
    const { message } = SEND_MESSAGE_TO_USER_SCHEMA.parse(raw);
    if (Buffer.byteLength(message) > NOTE_MAX_BYTES)
      throw new SessionNoteError(
        413,
        "message_too_long",
        `message is longer than ${NOTE_MAX_BYTES} UTF-8 bytes. Send a shorter message.`,
      );
    this.observe(id);
    const c = this.require(id);
    const entry: AgentMessage = {
      id: randomHandle("msg"),
      text: message,
      createdAt: new Date(this.now()).toISOString(),
      ...(callId && callId !== "audit-disabled" ? { callId } : {}),
    };
    this.admit(noteBytes(entry));
    c.messages.push(entry);
    c.touched = this.now();
    this.bytes += noteBytes(entry);
    this.#changed("soon");
    this.emit(id, undefined, { id: entry.id });
    return { accepted: true };
  }

  /** Dismissal is Web-only state and never reaches the model. */
  readMessages(id: string, ids: readonly string[]): void {
    const c = this.require(id);
    const wanted = new Set(ids);
    const readAt = new Date(this.now()).toISOString();
    let changed = false;
    for (const message of c.messages)
      if (wanted.has(message.id) && !message.readAt) {
        message.readAt = readAt;
        changed = true;
      }
    if (!changed) return;
    this.#changed("soon");
    this.emit(id);
  }

  ask(
    id: string | undefined,
    raw: RequestUserInput,
  ): { accepted: true; request_id: string } {
    if (!this.webUsers)
      throw new SessionNoteError(
        503,
        "web_unavailable",
        "The Web console is not running, so no one can see or answer this question. Ask the user in your reply instead.",
      );
    if (!id)
      throw new SessionNoteError(
        400,
        "conversation_unknown",
        "The host did not send a conversation ID, so this question has no destination. Ask the user in your reply instead.",
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
          "request_key_changed",
          `request_key ${JSON.stringify(input.request_key)} already belongs to different questions in this conversation. Use a new request_key, or send the original questions again without changes.`,
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
    this.#changed("soon");
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
      throw new SessionNoteError(
        404,
        "question_not_found",
        "This question does not exist or has expired.",
      );
    if (
      input.option_index !== null &&
      input.option_index >= question.options.length
    )
      throw new SessionNoteError(
        400,
        "invalid_option",
        "Select one of the options of this question.",
      );
    if (input.option_index === null && !input.note.trim())
      throw new SessionNoteError(
        400,
        "answer_required",
        "None of the above needs your own answer in the note.",
      );
    const text = formatUserAnswer(question, input.option_index, input.note);
    // Every admitted answer can fit even the JSON-based notes channel of a small response.
    if (
      Buffer.byteLength(text) > NOTE_MAX_BYTES ||
      Buffer.byteLength(JSON.stringify(text)) > NOTE_MAX_BYTES
    )
      throw new SessionNoteError(
        413,
        "answer_too_long",
        `The question, the choice, and the note together are longer than ${NOTE_MAX_BYTES} bytes, including JSON encoding. Make the note shorter.`,
      );
    const noteId = `${question.id}_${input.id}`;
    const prior = c.notes.find((n) => n.id === noteId);
    if (prior) {
      if (prior.text !== text || prior.questionId !== questionId)
        throw new SessionNoteError(
          409,
          "answer_changed",
          "This submission already has a different answer. Refresh the page and check it.",
        );
      return { ...prior };
    }
    if (!questionPending(c, question))
      throw new SessionNoteError(
        409,
        "question_answered",
        "This question already has an answer from another page. The draft stays, and you can send it as a note.",
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
    this.admit(delta + noteBytes({ text }));
    const note = this.insertNote(c, noteId, text, questionId);
    question.answer = answer;
    request.touched = replacement.touched;
    this.bytes += delta;
    this.#changed("soon");
    this.emit(id);
    return note;
  }

  withdraw(id: string, noteId: string): void {
    const conversation = this.require(id);
    const note = conversation.notes.find((n) => n.id === noteId);
    if (!note)
      throw new SessionNoteError(
        404,
        "note_not_found",
        "This message does not exist or has expired.",
      );
    if (note.status === "attached")
      throw new SessionNoteError(
        409,
        "note_attached",
        "This message is already in a tool response, so it cannot be withdrawn. Send a new note to correct it.",
      );
    note.status = "withdrawn";
    this.#changed("soon");
    this.emit(id);
  }

  page(id: string, page = 1): SessionNotesPage {
    const c = this.require(id);
    const totalPages = Math.max(
      1,
      Math.ceil(Math.max(c.notes.length, c.messages.length) / 30),
    );
    const current = Math.max(1, Math.min(page, totalPages));
    const end = Math.max(0, c.notes.length - (current - 1) * 30);
    const messageEnd = Math.max(0, c.messages.length - (current - 1) * 30);
    const messageStart = Math.max(0, messageEnd - 30);
    // The first page carries every unread message so none stays unseen behind paging.
    const olderUnread =
      current === 1
        ? c.messages.slice(0, messageStart).filter((m) => !m.readAt)
        : [];
    return {
      sessionId: id,
      label: c.label,
      pendingCount: pendingCount(c),
      pendingQuestions: pendingQuestions(c),
      items: c.notes.slice(Math.max(0, end - 30), end).map((n) => ({ ...n })),
      agentMessages: [
        ...olderUnread,
        ...c.messages.slice(messageStart, messageEnd),
      ].map((m) => ({ ...m })),
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
      const unread = c.messages.filter((message) => !message.readAt);
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
        unreadMessages: unread.length,
        messagePreview: unread.at(-1)?.text.slice(0, 240) ?? "",
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
        const text = USER_NOTE_TEXT_PREFIX + note.text;
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
      // exec/wait results are textual; a structured envelope keeps only its result and notes.
      if (
        !structured &&
        !conversation.label &&
        !conversation.titled &&
        Buffer.byteLength(TITLE_REMINDER) + 2 <= remaining
      )
        response.content.push({ type: "text", text: TITLE_REMINDER });
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
      // Save delivery at once, so a restart does not deliver the same note again.
      this.#changed("now");
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
        "notes_full",
        "Storage for conversation messages is full. Old records leave after 72 hours; until then, use the conversation itself.",
      );
  }

  private sweep(): void {
    const deadline = this.now() - NOTE_RETENTION_MS;
    let removed = false;
    for (const [id, c] of this.conversations) {
      c.notes = c.notes.filter((note) => {
        if (Date.parse(note.createdAt) > deadline) return true;
        this.bytes -= noteBytes(note);
        removed = true;
        return false;
      });
      c.requests = c.requests.filter((request) => {
        if (request.touched > deadline) return true;
        this.bytes -= requestBytes(request);
        removed = true;
        return false;
      });
      c.messages = c.messages.filter((message) => {
        if (Date.parse(message.createdAt) > deadline) return true;
        this.bytes -= noteBytes(message);
        removed = true;
        return false;
      });
      if (
        !c.notes.length &&
        !c.requests.length &&
        !c.messages.length &&
        c.touched <= deadline
      ) {
        this.bytes -= profileBytes(c);
        this.conversations.delete(id);
        removed = true;
      }
    }
    if (removed) this.#changed("idle");
  }

  private emit(
    id: string,
    questionRequest?: SessionNotesEvent["questionRequest"],
    agentMessage?: SessionNotesEvent["agentMessage"],
  ): void {
    for (const listener of this.listeners) {
      try {
        listener({
          type: "session:notes",
          sessionId: id,
          ...(questionRequest ? { questionRequest } : {}),
          ...(agentMessage ? { agentMessage } : {}),
        });
      } catch {
        /* Observers never change delivery. */
      }
    }
  }
}

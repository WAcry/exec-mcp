import type { CallToolResult } from "@modelcontextprotocol/client";
import { MAX_PAYLOAD_BYTES } from "./limits.js";
import { normalizeResult } from "./results.js";
import type { PaginatedResult, SessionSummary } from "./web/types.js";
import {
  NOTE_LABEL_BYTES,
  NOTE_MAX_BYTES,
  NOTE_RETENTION_MS,
  NOTES_RESPONSE_BYTES,
  type SessionNote,
  type SessionNotesPage,
} from "./session-notes-types.js";

interface Conversation {
  id: string;
  label: string;
  firstSeen: string;
  touched: number;
  sequence: number;
  notes: SessionNote[];
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

/** Ephemeral user messages, independent of audit eviction and native host generations.
 * All selection/commit operations are synchronous: no reservation protocol or model-side polling.
 */
export class SessionNotes {
  private conversations = new Map<string, Conversation>();
  private bytes = 0;
  private webUsers = 0;
  private listeners = new Set<
    (event: { type: "session:notes"; sessionId: string }) => void
  >();

  constructor(
    private readonly maximumBytes = 16 * 1024 * 1024,
    private readonly now: () => number = Date.now,
  ) {}

  /** Capture conversation identities only while the management Web server is actually listening. */
  openWeb(
    listener: (event: { type: "session:notes"; sessionId: string }) => void,
  ): () => void {
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
      if (prior.text !== text)
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
    };
    this.admit(noteBytes(note));
    conversation.sequence++;
    conversation.notes.push(note);
    conversation.touched = this.now();
    this.bytes += noteBytes(note);
    this.emit(id);
    return { ...note };
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
      items: c.notes.slice(Math.max(0, end - 30), end).map((n) => ({ ...n })),
      page: current,
      totalPages,
      maxMessageBytes: NOTE_MAX_BYTES,
      retentionHours: NOTE_RETENTION_MS / 3_600_000,
    };
  }

  sessions(
    audit: readonly SessionSummary[],
    options: { page: number; pageSize: number; search?: string },
  ): PaginatedResult<SessionSummary> {
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
        canMessage: true,
      });
    }
    const query = options.search?.toLowerCase();
    const all = [...merged.values()]
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
      if (!c.notes.length && c.touched <= deadline) {
        this.bytes -= profileBytes(c);
        this.conversations.delete(id);
      }
    }
  }

  private emit(id: string): void {
    for (const listener of this.listeners) {
      try {
        listener({ type: "session:notes", sessionId: id });
      } catch {
        /* Observers never change delivery. */
      }
    }
  }
}

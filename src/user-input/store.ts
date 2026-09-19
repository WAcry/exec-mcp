import Database from "better-sqlite3";
import { closeSync, openSync, mkdirSync, chmodSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  REQUEST_INPUT_SCHEMA,
  ANSWER_INPUT_SCHEMA,
  UserInputError,
  type InputRequest,
  type InputAnswer,
  type InputQuestion,
  type AnswerEvent,
} from "./contracts.js";

interface RequestRow {
  id: string;
  scope: string;
  request_key: string;
  payload: string;
  created_at: number;
}
interface EventRow {
  id: string;
  request_id: string;
  question_id: string;
  revision: number;
  payload: string;
  answered_at: number;
  attempted_at: number | null;
  acknowledged_at: number | null;
}
export interface QuestionView extends InputQuestion {
  answer:
    | (AnswerEvent["answer_from_user"] & {
        event_id: string;
        delivery: "saved" | "attempted" | "acknowledged";
      })
    | null;
}
export interface InputRequestView {
  id: string;
  session_id: string;
  request_key: string;
  created_at: string;
  status: "pending" | "answered";
  questions: QuestionView[];
}
export interface InputChange {
  type: "user-input:changed";
  request_id: string;
  reason: "created" | "answered" | "acknowledged";
}
export function userInputDatabasePath(configPath: string): string {
  return path.join(
    path.dirname(configPath),
    ".exec-mcp",
    `${path.basename(configPath)}.questions.sqlite3`,
  );
}
const latest = `NOT EXISTS (SELECT 1 FROM answer_events newer WHERE newer.request_id=e.request_id AND newer.question_id=e.question_id AND newer.revision>e.revision)`;
const eventText = (event: AnswerEvent) =>
  `用户答复（question_from_agent 是提问内容，answer_from_user 是用户提交的决定与补充；按 event_id 去重并确认）：\n${JSON.stringify(event)}`;

/** Durable decision records, independent of native sessions, cells and transient audit history. */
export class UserInputStore {
  private readonly db: Database.Database;
  private readonly listeners = new Set<(event: InputChange) => void>();
  private webClients = 0;
  private closed = false;
  constructor(readonly filename: string) {
    if (filename !== ":memory:") {
      mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
      closeSync(openSync(filename, "a", 0o600));
      if (process.platform !== "win32") chmodSync(filename, 0o600);
    }
    this.db = new Database(filename, { timeout: 5000 });
    try {
      this.db.pragma("foreign_keys = ON");
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("synchronous = FULL");
      const version = this.db.pragma("user_version", {
        simple: true,
      }) as number;
      if (version > 1)
        throw new Error("问答数据库版本较新，请使用对应版本的 exec-mcp。");
      this.db.exec(`CREATE TABLE IF NOT EXISTS input_requests (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, request_key TEXT NOT NULL,
        payload TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(scope,request_key));
        CREATE TABLE IF NOT EXISTS answer_events (
        id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES input_requests(id) ON DELETE CASCADE,
        question_id TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL,
        answered_at INTEGER NOT NULL, attempted_at INTEGER, acknowledged_at INTEGER,
        UNIQUE(request_id,question_id,revision));
        CREATE INDEX IF NOT EXISTS request_scope ON input_requests(scope,created_at);
        CREATE INDEX IF NOT EXISTS pending_answers ON answer_events(acknowledged_at,answered_at);
        PRAGMA user_version = 1;`);
      this.prune();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  get webAvailable() {
    return !this.closed && this.webClients > 0;
  }
  attachWeb(): () => void {
    this.webClients++;
    let attached = true;
    return () => {
      if (attached) {
        attached = false;
        this.webClients--;
      }
    };
  }
  subscribe(listener: (event: InputChange) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit(event: InputChange) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* Delivery remains saved. */
      }
    }
  }
  private requireScope(scope?: string): string {
    if (!scope)
      throw new UserInputError(
        400,
        "异步问答需要 ChatGPT 提供 openai/session 对话标识。",
      );
    return scope;
  }
  private row(id: string, scope?: string): RequestRow {
    const row = this.db
      .prepare("SELECT * FROM input_requests WHERE id=?")
      .get(id) as RequestRow | undefined;
    if (!row || (scope !== undefined && row.scope !== scope))
      throw new UserInputError(404, "当前对话中未找到该问答请求。");
    return row;
  }
  private questions(row: RequestRow): InputQuestion[] {
    return (JSON.parse(row.payload) as InputRequest).questions.map(
      (question, index) => ({
        id: `q${index + 1}`,
        title: question.title,
        options: (question.options ?? []).map((label, option) => ({
          id: `o${option + 1}`,
          label,
        })),
      }),
    );
  }
  private view(row: RequestRow): InputRequestView {
    const events = this.db
      .prepare(
        `SELECT e.* FROM answer_events e WHERE e.request_id=? AND ${latest}`,
      )
      .all(row.id) as EventRow[];
    const questions = this.questions(row).map((question) => {
      const row = events.find((event) => event.question_id === question.id);
      const event = row ? (JSON.parse(row.payload) as AnswerEvent) : undefined;
      return {
        ...question,
        answer:
          row && event
            ? {
                ...event.answer_from_user,
                event_id: row.id,
                delivery:
                  row.acknowledged_at !== null
                    ? ("acknowledged" as const)
                    : row.attempted_at !== null
                      ? ("attempted" as const)
                      : ("saved" as const),
              }
            : null,
      };
    });
    return {
      id: row.id,
      session_id: row.scope,
      request_key: row.request_key,
      created_at: new Date(row.created_at).toISOString(),
      status: questions.every((question) => question.answer)
        ? "answered"
        : "pending",
      questions,
    };
  }
  create(scope: string | undefined, input: InputRequest) {
    const owner = this.requireScope(scope);
    const parsed = REQUEST_INPUT_SCHEMA.safeParse(input);
    if (!parsed.success)
      throw new UserInputError(
        400,
        "问题参数无效或过长，请检查标题、选项和请求键。",
      );
    const payload = JSON.stringify(parsed.data);
    let created = false;
    const result = this.db
      .transaction(() => {
        const existing = this.db
          .prepare(
            "SELECT * FROM input_requests WHERE scope=? AND request_key=?",
          )
          .get(owner, input.request_key) as RequestRow | undefined;
        if (existing) {
          if (existing.payload !== payload)
            throw new UserInputError(
              409,
              "request_key 已用于不同问题；修改题意请使用新键。",
            );
          return this.view(existing);
        }
        const row = {
          id: `question_${randomUUID()}`,
          scope: owner,
          request_key: input.request_key,
          payload,
          created_at: Date.now(),
        };
        this.db
          .prepare(
            "INSERT INTO input_requests VALUES (@id,@scope,@request_key,@payload,@created_at)",
          )
          .run(row);
        created = true;
        return this.view(row);
      })
      .immediate();
    if (created)
      this.emit({
        type: "user-input:changed",
        request_id: result.id,
        reason: "created",
      });
    return {
      accepted: true,
      request_id: result.id,
      status: result.status,
      question_ids: result.questions.map((question) => question.id),
    };
  }
  getForScope(scope: string | undefined, id: string) {
    return this.view(this.row(id, this.requireScope(scope)));
  }
  get(id: string) {
    return this.view(this.row(id));
  }
  list(
    options: {
      scope?: string;
      page?: number;
      status?: "pending" | "answered";
    } = {},
  ) {
    const where = [options.scope ? "scope=@scope" : "1=1"];
    // A request is answered when every immutable question has at least one answer.
    if (options.status)
      where.push(
        `${options.status === "pending" ? "NOT" : ""} (json_array_length(json_extract(payload,'$.questions'))=(SELECT COUNT(DISTINCT question_id) FROM answer_events WHERE request_id=input_requests.id))`,
      );
    const clause = where.join(" AND ");
    const params = options.scope ? { scope: options.scope } : {};
    const total = (
      this.db
        .prepare(`SELECT COUNT(*) AS count FROM input_requests WHERE ${clause}`)
        .get(params) as { count: number }
    ).count;
    const page = Math.max(
      1,
      Math.min(options.page ?? 1, Math.max(1, Math.ceil(total / 20))),
    );
    const rows = this.db
      .prepare(
        `SELECT * FROM input_requests WHERE ${clause} ORDER BY created_at DESC,id LIMIT 20 OFFSET @offset`,
      )
      .all({ ...params, offset: (page - 1) * 20 }) as RequestRow[];
    const pending = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS count FROM input_requests WHERE json_array_length(json_extract(payload,'$.questions'))>(SELECT COUNT(DISTINCT question_id) FROM answer_events WHERE request_id=input_requests.id)`,
        )
        .get() as { count: number }
    ).count;
    return {
      items: rows.map((row) => this.view(row)),
      total,
      page,
      pageSize: 20,
      pending,
    };
  }
  answer(id: string, input: InputAnswer): InputRequestView {
    const parsed = ANSWER_INPUT_SCHEMA.safeParse(input);
    if (!parsed.success)
      throw new UserInputError(
        400,
        "答复参数无效；自定义回答需要说明，说明最多 6000 个 UTF-8 字节。",
      );
    const result = this.db
      .transaction(() => {
        const row = this.row(id);
        const question = this.questions(row).find(
          (question) => question.id === input.question_id,
        );
        if (!question) throw new UserInputError(404, "问题不存在。");
        const previous = this.db
          .prepare(
            "SELECT * FROM answer_events WHERE request_id=? AND question_id=? ORDER BY revision DESC LIMIT 1",
          )
          .get(id, question.id) as EventRow | undefined;
        if ((previous?.revision ?? 0) !== input.expected_revision)
          throw new UserInputError(
            409,
            "此问题已有更新，请刷新并确认后再提交；你的输入尚未覆盖已保存答复。",
          );
        const option = question.options.find(
          (option) => option.id === input.selected_option_id,
        );
        if (input.selected_option_id !== null && !option)
          throw new UserInputError(400, "所选选项不存在。");
        const now = Date.now();
        const event: AnswerEvent = {
          type: "user_input_answer",
          event_id: `answer_${randomUUID()}`,
          request_id: id,
          question_id: question.id,
          question_from_agent: question,
          answer_from_user: {
            kind: option ? "option" : "text",
            selected_option_id: option?.id ?? null,
            selected_option_label: option?.label ?? null,
            notes: input.notes,
            revision: (previous?.revision ?? 0) + 1,
            answered_at: new Date(now).toISOString(),
          },
          ...(previous ? { supersedes_event_id: previous.id } : {}),
        };
        if (Buffer.byteLength(eventText(event)) > 16_000)
          throw new UserInputError(
            400,
            "问题与答复合计过长，请缩短补充说明后提交。",
          );
        this.db
          .prepare(
            "INSERT INTO answer_events (id,request_id,question_id,revision,payload,answered_at) VALUES (?,?,?,?,?,?)",
          )
          .run(
            event.event_id,
            id,
            question.id,
            event.answer_from_user.revision,
            JSON.stringify(event),
            now,
          );
        return this.view(row);
      })
      .immediate();
    this.emit({
      type: "user-input:changed",
      request_id: id,
      reason: "answered",
    });
    return result;
  }
  acknowledge(scope: string | undefined, ids: readonly string[]) {
    if (!ids.length) return;
    const owner = this.requireScope(scope);
    const changed = new Set<string>();
    this.db
      .transaction(() => {
        for (const id of new Set(ids)) {
          const event = this.db
            .prepare(
              "SELECT e.*,r.scope FROM answer_events e JOIN input_requests r ON r.id=e.request_id WHERE e.id=?",
            )
            .get(id) as (EventRow & { scope: string }) | undefined;
          if (!event || event.scope !== owner)
            throw new UserInputError(404, "当前对话中未找到待确认的答复事件。");
          if (event.acknowledged_at === null) {
            this.db
              .prepare("UPDATE answer_events SET acknowledged_at=? WHERE id=?")
              .run(Date.now(), id);
            changed.add(event.request_id);
          }
        }
      })
      .immediate();
    for (const id of changed)
      this.emit({
        type: "user-input:changed",
        request_id: id,
        reason: "acknowledged",
      });
    this.prune();
  }
  delivery(
    scope: string | undefined,
    maxBytes = 18_000,
  ): { content: { type: "text"; text: string }[]; bytes: number } {
    if (!scope) return { content: [], bytes: 0 };
    return this.db
      .transaction(() => {
        const where = `r.scope=? AND e.acknowledged_at IS NULL AND ${latest}`;
        const count = (
          this.db
            .prepare(
              `SELECT COUNT(*) AS count FROM answer_events e JOIN input_requests r ON r.id=e.request_id WHERE ${where}`,
            )
            .get(scope) as { count: number }
        ).count;
        const rows = this.db
          .prepare(
            `SELECT e.* FROM answer_events e JOIN input_requests r ON r.id=e.request_id WHERE ${where} ORDER BY e.rowid LIMIT 100`,
          )
          .all(scope) as EventRow[];
        const content: { type: "text"; text: string }[] = [];
        let bytes = 0;
        for (const row of rows) {
          const text = eventText(JSON.parse(row.payload) as AnswerEvent);
          const size = Buffer.byteLength(text) + 2;
          if (bytes + size + 512 > maxBytes) break;
          content.push({ type: "text", text });
          bytes += size;
          this.db
            .prepare("UPDATE answer_events SET attempted_at=? WHERE id=?")
            .run(Date.now(), row.id);
        }
        if (content.length) {
          const text = `已附 ${content.length} 条完整答复；其余 ${count - content.length} 条将在后续响应提供。读到后，在下一次 exec/wait 的 ack_user_input 中确认 event_id；重复事件按 ID 去重。`;
          content.push({ type: "text", text });
          bytes += Buffer.byteLength(text) + 2;
        }
        return { content, bytes };
      })
      .immediate();
  }
  /** Retain pending/unacknowledged work; prune only completely acknowledged requests older than 30 days. */
  prune(now = Date.now()) {
    this.db
      .prepare(
        `DELETE FROM input_requests WHERE created_at < ?
      AND json_array_length(json_extract(payload,'$.questions'))=(SELECT COUNT(DISTINCT question_id) FROM answer_events WHERE request_id=input_requests.id)
      AND NOT EXISTS (SELECT 1 FROM answer_events e WHERE e.request_id=input_requests.id AND ${latest} AND (e.acknowledged_at IS NULL OR e.acknowledged_at >= ?))`,
      )
      .run(now - 30 * 86400_000, now - 30 * 86400_000);
  }
  close() {
    if (!this.closed) {
      this.closed = true;
      this.listeners.clear();
      this.db.close();
    }
  }
}

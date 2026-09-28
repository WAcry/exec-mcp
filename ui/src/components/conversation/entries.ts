import type {
  SessionNote,
  AgentMessage,
} from "../../../../src/session-notes-types.js";
import type { UserQuestionView } from "../../../../src/user-questions-types.js";
import type { CallListItem, CallStatus } from "../../types.js";

export type Entry =
  | {
      kind: "call";
      key: string;
      at: string;
      call: CallListItem;
      /** Questions this call asked; they render under it instead of on their own. */
      questions: UserQuestionView[];
      /** Messages this call sent to the operator. */
      messages: AgentMessage[];
    }
  | { kind: "note"; key: string; at: string; note: SessionNote }
  | { kind: "agent"; key: string; at: string; message: AgentMessage }
  | {
      kind: "question";
      key: string;
      at: string;
      question: UserQuestionView;
      order: number;
    };

const RANK = { call: 0, question: 1, agent: 2, note: 3 } as const;

/** One chronological story; answers live inside their question, not as loose notes. */
export function buildEntries(
  calls: Iterable<CallListItem>,
  notes: readonly SessionNote[],
  questions: readonly UserQuestionView[],
  includeMessages: boolean,
  agentMessages: readonly AgentMessage[] = [],
): Entry[] {
  const entries: Entry[] = [];
  const askedBy = new Map<string, Extract<Entry, { kind: "call" }>>();
  const byId = new Map<string, Extract<Entry, { kind: "call" }>>();
  for (const call of calls) {
    const entry = {
      kind: "call" as const,
      key: call.id,
      at: call.startedAt,
      call,
      questions: [],
      messages: [],
    };
    entries.push(entry);
    byId.set(call.id, entry);
    for (const step of call.steps ?? [])
      if (step.name === "request_user_input_async" && step.handle)
        askedBy.set(step.handle, entry);
  }
  if (includeMessages) {
    for (const message of agentMessages) {
      const sender = message.callId ? byId.get(message.callId) : undefined;
      if (sender) sender.messages.push(message);
      else
        entries.push({
          kind: "agent",
          key: message.id,
          at: message.createdAt,
          message,
        });
    }
    for (const note of notes)
      if (!note.questionId)
        entries.push({
          kind: "note",
          key: note.id,
          at: note.createdAt,
          note,
        });
    questions.forEach((question, order) => {
      const asker = askedBy.get(question.requestId);
      if (asker) asker.questions.push(question);
      else
        entries.push({
          kind: "question",
          key: question.id,
          at: question.createdAt,
          question,
          order,
        });
    });
    for (const entry of askedBy.values())
      entry.questions.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  return entries.sort(
    (a, b) =>
      a.at.localeCompare(b.at) ||
      RANK[a.kind] - RANK[b.kind] ||
      (a.kind === "question" && b.kind === "question" ? a.order - b.order : 0),
  );
}

/** Cell IDs are only unique within a conversation. */
export function cellKey(sessionId: string, cell: string): string {
  return `cell:${sessionId}:${cell}`;
}

/** Hover key shared by an exec, the waits that resume it, and notes it carried. */
export function hoverKey(call: CallListItem): string {
  const cell = call.tool === "wait" ? call.args.cell_id : call.cellId;
  return cell ? cellKey(call.sessionId, cell) : `call:${call.id}`;
}

export interface Links {
  /** The exec whose yielded cell a wait resumes. */
  origin: Map<string, CallListItem>;
  /** Waits that resumed an exec's cell, oldest first. */
  continuations: Map<string, CallListItem[]>;
  /** Notes (including answers) attached to each call's response. */
  carried: Map<string, SessionNote[]>;
}

export function buildLinks(
  calls: Iterable<CallListItem>,
  notes: readonly SessionNote[],
): Links {
  const byCell = new Map<string, CallListItem>();
  const ordered = [...calls].sort((a, b) =>
    a.startedAt.localeCompare(b.startedAt),
  );
  for (const call of ordered)
    if (call.tool === "exec" && call.cellId)
      byCell.set(cellKey(call.sessionId, call.cellId), call);
  const origin = new Map<string, CallListItem>();
  const continuations = new Map<string, CallListItem[]>();
  for (const call of ordered) {
    const cell = call.tool === "wait" ? call.args.cell_id : undefined;
    const source = cell ? byCell.get(cellKey(call.sessionId, cell)) : undefined;
    if (!source) continue;
    origin.set(call.id, source);
    continuations.set(source.id, [
      ...(continuations.get(source.id) ?? []),
      call,
    ]);
  }
  const carried = new Map<string, SessionNote[]>();
  for (const note of notes)
    if (note.callId)
      carried.set(note.callId, [...(carried.get(note.callId) ?? []), note]);
  return { origin, continuations, carried };
}

/** A yielded script's row reflects how its cell eventually ended. */
export function effectiveStatus(
  call: CallListItem,
  continuations: readonly CallListItem[] | undefined,
): CallStatus {
  if (call.status !== "yielding" || !continuations?.length) return call.status;
  const last = continuations[continuations.length - 1]!;
  return last.status === "running" ? "running" : last.status;
}

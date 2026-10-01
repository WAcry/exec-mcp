import type { ClientErrorCode } from "./api";
import { ApiError } from "./api";
import {
  feedback,
  message,
  type Feedback,
  type MessageKey,
  type Translate,
} from "./locale";

/** Every server error code has UI text, so a new code fails the type check until it is translated. */
const ERROR_TEXT: Record<ClientErrorCode, MessageKey> = {
  network: "error.network",
  unauthorized: "error.unauthorized",
  invalid_token: "error.invalidToken",
  forbidden_origin: "error.forbiddenOrigin",
  missing_action_header: "error.missingActionHeader",
  loopback_only: "error.loopbackOnly",
  invalid_url: "error.invalidRequest",
  invalid_json: "error.invalidRequest",
  invalid_request: "error.invalidRequest",
  body_too_large: "error.bodyTooLarge",
  not_found: "error.notFound",
  method_not_allowed: "error.notFound",
  call_not_found: "error.callNotFound",
  media_not_found: "error.mediaNotFound",
  conversation_not_found: "error.conversationNotFound",
  question_not_found: "error.questionNotFound",
  note_not_found: "error.noteNotFound",
  note_invalid_id: "error.invalidRequest",
  note_empty: "error.noteEmpty",
  note_too_long: "error.tooLong",
  message_too_long: "error.tooLong",
  label_too_long: "error.tooLong",
  answer_too_long: "error.tooLong",
  note_changed: "error.noteChanged",
  note_attached: "error.noteAttached",
  invalid_option: "error.invalidOption",
  answer_required: "error.answerRequired",
  answer_changed: "error.answerChanged",
  question_answered: "error.questionAnswered",
  notes_full: "error.notesFull",
  web_unavailable: "error.webUnavailable",
  conversation_unknown: "error.conversationNotFound",
  request_key_changed: "error.invalidRequest",
  management_unavailable: "error.managementUnavailable",
  restart_in_progress: "error.restartInProgress",
  config_conflict: "error.configConflict",
  config_unreadable: "error.configUnreadable",
  config_entry_missing: "error.configEntryMissing",
  config_unsafe_edit: "error.configUnsafeEdit",
  too_many_event_clients: "error.tooManyEventClients",
  internal_error: "error.internal",
};

/** These codes carry a diagnostic that the user needs, such as a configuration field. */
const WITH_DIAGNOSTIC = new Set<ClientErrorCode>(["config_unreadable"]);

/** Translated text for a known code; otherwise the raw diagnostic, which keeps its language. */
export function errorFeedback(error: unknown): Feedback {
  if (error instanceof ApiError) {
    const key = error.code === undefined ? undefined : ERROR_TEXT[error.code];
    if (!key) return error.message;
    return WITH_DIAGNOSTIC.has(error.code!)
      ? message(key, error.message)
      : message(key);
  }
  return error instanceof Error ? error.message : String(error);
}

export function errorText(error: unknown, t: Translate): string {
  return feedback(errorFeedback(error), t);
}

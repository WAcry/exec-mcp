/** Questions and answers share the lifetime and delivery queue of session notes. */
export interface UserQuestionInput {
  title: string;
  options: string[];
}

export interface UserQuestion extends UserQuestionInput {
  id: string;
  answer?: {
    option_index: number | null;
    note: string;
    noteId: string;
    answeredAt: string;
  };
}

export interface UserQuestionRequest {
  id: string;
  request_key?: string;
  createdAt: string;
  touched: number;
  questions: UserQuestion[];
}

export interface UserQuestionView extends UserQuestion {
  requestId: string;
  createdAt: string;
  pending: boolean;
  delivery?: "pending" | "attached" | "withdrawn";
}

export interface UserQuestionsPage {
  items: UserQuestionView[];
  pendingCount: number;
  total: number;
  page: number;
  totalPages: number;
}

/** Called by both the composer and server; the server supplies the original question. */
export function formatUserAnswer(
  question: UserQuestionInput,
  optionIndex: number | null,
  note: string,
): string {
  return `问题：${question.title}\n选择：${optionIndex === null ? "以上都不是" : question.options[optionIndex]}${note ? `\n补充：${note}` : ""}`;
}

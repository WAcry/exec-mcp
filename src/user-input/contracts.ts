import { z } from "zod/v4";

function text(bytes: number) {
  return z
    .string()
    .refine(
      (value) => value.trim().length > 0 && Buffer.byteLength(value) <= bytes,
      `须为非空文本，最多 ${bytes} 个 UTF-8 字节。`,
    );
}
// Mirrors Codex's questions/title/options shape. IDs are assigned from immutable positions.
export const QUESTION_SCHEMA = z
  .object({
    title: text(1500).describe("完整问题及必要上下文。"),
    options: z
      .array(text(500))
      .min(1)
      .max(8)
      .optional()
      .describe(
        "候选答案，推荐项放首位；省略时为自由文本。界面另外提供自定义回答和补充说明。",
      ),
  })
  .strict()
  .refine(
    (value) =>
      !value.options || new Set(value.options).size === value.options.length,
    "同题选项须互不相同。",
  )
  .refine(
    (value) => Buffer.byteLength(JSON.stringify(value)) <= 8000,
    "单题编码后最多 8000 字节，以保留完整答复空间。",
  );
export const REQUEST_INPUT_SCHEMA = z
  .object({
    request_key: text(128).describe(
      "本对话内稳定的请求键；同键同题返回已有请求，题意变化使用新键。",
    ),
    questions: z.array(QUESTION_SCHEMA).min(1).max(8),
  })
  .strict()
  .refine(
    (value) => Buffer.byteLength(JSON.stringify(value)) <= 24_000,
    "问题组过长，请拆成独立请求。",
  );
export const GET_INPUT_SCHEMA = z
  .object({ request_id: z.string().min(1).max(100) })
  .strict();
export const ACK_INPUT_SCHEMA = z
  .array(z.string().min(1).max(100))
  .max(100)
  .optional()
  .describe(
    "已读用户答复的 event_id；仅确认本对话的这些事件，可重复提交。确认不表示已执行。",
  );
export const ANSWER_INPUT_SCHEMA = z
  .object({
    question_id: z.string().min(1).max(30),
    expected_revision: z.number().int().min(0),
    selected_option_id: z.string().max(30).nullable(),
    notes: z
      .string()
      .refine(
        (value) => Buffer.byteLength(value) <= 6000,
        "补充说明最多 6000 个 UTF-8 字节。",
      ),
  })
  .strict()
  .refine(
    (value) =>
      value.selected_option_id !== null || value.notes.trim().length > 0,
    "自定义回答需要填写内容。",
  );
export type InputRequest = z.infer<typeof REQUEST_INPUT_SCHEMA>;
export type InputAnswer = z.infer<typeof ANSWER_INPUT_SCHEMA>;
export interface InputOption {
  id: string;
  label: string;
}
export interface InputQuestion {
  id: string;
  title: string;
  options: InputOption[];
}
export interface AnswerEvent {
  type: "user_input_answer";
  event_id: string;
  request_id: string;
  question_id: string;
  question_from_agent: InputQuestion;
  answer_from_user: {
    kind: "option" | "text";
    selected_option_id: string | null;
    selected_option_label: string | null;
    notes: string;
    revision: number;
    answered_at: string;
  };
  supersedes_event_id?: string;
}
export class UserInputError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

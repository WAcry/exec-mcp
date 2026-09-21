import { z } from "zod";
import { NOTE_MAX_BYTES } from "./session-notes-types.js";

/** Mirror Codex's questions/title/options shape, with options required for this Web workflow. */
export const REQUEST_USER_INPUT_SCHEMA = z
  .object({
    questions: z
      .array(
        z
          .object({
            title: z
              .string()
              .trim()
              .min(1)
              .max(2000)
              .describe("完整、简短的问题，包含作答需要的上下文。"),
            options: z
              .array(z.string().trim().min(1).max(500))
              .min(2)
              .max(6)
              .refine(
                (options) => new Set(options).size === options.length,
                "同一问题的选项不能重复",
              )
              .describe(
                "按展示顺序列出选项，推荐项放首位；界面自动提供‘以上都不是’与所有选项的补充文本框。",
              ),
          })
          .strict(),
      )
      .min(1)
      .max(3)
      .describe("一起提交的 1 至 3 个独立问题。"),
    request_key: z
      .string()
      .min(1)
      .max(80)
      .optional()
      .describe("可选去重键；同一对话同键同内容返回原请求，同键改题报错。"),
  })
  .strict();

/** Web-only submission, deliberately not exposed as an MCP tool. */
export const QUESTION_ANSWER_SCHEMA = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
    option_index: z.number().int().min(0).nullable(),
    note: z.string().max(NOTE_MAX_BYTES),
  })
  .strict();

export type RequestUserInput = z.infer<typeof REQUEST_USER_INPUT_SCHEMA>;
export type QuestionAnswer = z.infer<typeof QUESTION_ANSWER_SCHEMA>;

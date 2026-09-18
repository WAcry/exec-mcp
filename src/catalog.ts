import { z } from "zod/v4";
import type { CodeModeToolDefinition } from "./code-mode/types.js";
import { SESSION_IDLE_MS } from "./code-mode/session-pool.js";
import { DEFAULT_SKILL_MAX_CHARS } from "./skills/types.js";
import {
  HOST_FILE_SCHEMA,
  IMPORT_FILE_SCHEMA,
  EXPORT_FILE_SCHEMA,
  REVOKE_FILE_SCHEMA,
} from "./files/contracts.js";

const ms = (maximum: number, description: string) =>
  z.number().int().min(0).max(maximum).describe(description).optional();
const tokenBudget = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER)
  .describe(
    "本次文本输出的近似 token 预算（约 4 个 UTF-8 字节/token）；省略不限量，0 省略文本。保留首尾并标记截断，不影响嵌套结果、存储和媒体；状态/提示不计入。",
  )
  .optional();
export const EXEC_SCHEMA = z
  .object({
    max_output_tokens: tokenBudget,
    files: z
      .array(HOST_FILE_SCHEMA)
      .optional()
      .describe(
        "可选的 ChatGPT 原生文件引用数组；按原顺序原样传入，不填文件名、路径、URL 或内容。宿主绑定为文件对象；JS 用 import_file 的零基 index 选择，不直接访问下载凭据。",
      ),
    source: z
      .string()
      .min(1)
      .describe("JavaScript 源码，不要加 Markdown 围栏；不是 Shell 命令。"),
    workdir: z
      .string()
      .min(1)
      .describe(
        "本次本机工具的默认目录；省略或相对路径均基于服务用户主目录。Shell cd 不改变此值。",
      )
      .optional(),
    yield_time_ms: ms(
      30_000,
      "首次等待毫秒数，默认 10000；仅控制本次返回时间。",
    ),
  })
  .strict();
export const WAIT_SCHEMA = z
  .object({
    max_tokens: tokenBudget,
    cell_id: z
      .string()
      .min(1)
      .describe("exec 返回的运行中 cell_id，不是终端 session_id。"),
    yield_time_ms: ms(
      110_000,
      "最长等待毫秒数；默认、推荐和上限均为 110000；有完成或主动 yield 时提前返回。",
    ),
    terminate: z
      .boolean()
      .describe(
        "true 尽力终止 cell 及尚未完成的嵌套调用；不会回滚副作用或终止已交回 session_id 的进程。",
      )
      .optional(),
  })
  .strict();
export const COMMAND_SCHEMA = z
  .object({
    cmd: z.string().min(1).describe("由所选 Shell 解释的命令。"),
    workdir: z
      .string()
      .min(1)
      .describe("本次命令目录；相对路径基于 exec.workdir。")
      .optional(),
    shell: z
      .string()
      .min(1)
      .describe(
        "Shell 可执行文件；Windows 默认 powershell.exe，其他系统使用用户 Shell 或 /bin/sh。不支持 cmd.exe。",
      )
      .optional(),
    login: z
      .boolean()
      .describe("是否加载 Shell profile；默认 false。")
      .optional(),
    tty: z.boolean().describe("true 使用交互式 PTY；默认普通管道。").optional(),
    yield_time_ms: ms(30_000, "等待命令结果，默认 10000 毫秒。"),
  })
  .strict();
export const STDIN_SCHEMA = z
  .object({
    session_id: z.string().min(1).describe("exec_command 返回的终端句柄。"),
    chars: z
      .string()
      .describe("写入的字符；省略或空字符串时仅读取。")
      .optional(),
    close_stdin: z
      .boolean()
      .describe("普通管道可在写入后关闭 stdin；PTY 不支持。")
      .optional(),
    yield_time_ms: ms(
      110_000,
      "无未读输出时的最长等待；写入默认 250 毫秒，纯轮询默认 110000 毫秒。",
    ),
    cols: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .describe("PTY 列数；与 rows 一起使用。")
      .optional(),
    rows: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .describe("PTY 行数；与 cols 一起使用。")
      .optional(),
    terminate: z
      .boolean()
      .describe("true 终止该进程树，并读取剩余输出。")
      .optional(),
  })
  .strict()
  .refine(
    (value) => (value.cols === undefined) === (value.rows === undefined),
    "cols 和 rows 必须同时提供",
  );
export const IMAGE_SCHEMA = z
  .object({
    path: z
      .string()
      .min(1)
      .describe("已有 PNG/JPEG/WebP/GIF 图片；相对路径基于 exec.workdir。"),
    detail: z
      .enum(["high", "original"])
      .describe("默认 high；original 请求原始细节。")
      .optional(),
  })
  .strict();
export const SEARCH_SCHEMA = z
  .object({
    query: z
      .string()
      .min(1)
      .describe("工具用途、名称或服务名；支持标识符与中文词项的 BM25。"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .describe("最多返回的结果数，默认 8。")
      .optional(),
  })
  .strict();
const PATCH_SCHEMA = z.string().min(1);
const SKILL_SCHEMA = z
  .object({
    workdir: z
      .string()
      .min(1)
      .optional()
      .describe(
        "项目发现起点；相对 exec.workdir 解析。省略时继承显式的 exec.workdir，否则只列用户级 Skills。",
      ),
  })
  .strict();
const TERMINAL_OUTPUT = {
  type: "object",
  properties: {
    output: { type: "string" },
    wall_time_seconds: { type: "number" },
    session_id: { type: "string" },
    exit_code: { type: "integer" },
  },
  required: ["output", "wall_time_seconds"],
  additionalProperties: false,
};
const PATCH_GRAMMAR = `start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?
hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?
filename: /(.+)/
add_line: "+" /(.*)/ LF
change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF
%import common.LF`;
interface NativeContract {
  name: string;
  description: string;
  schema: z.ZodType;
  output?: Record<string, unknown>;
  freeform?: boolean;
}
export const NATIVE_CONTRACTS: readonly NativeContract[] = [
  {
    name: "list_skills",
    schema: SKILL_SCHEMA,
    output: { type: "string" },
    description: `实时返回 Skill 目录文本，用 text(result) 一次输出。始终扫描 ~/.agents/skills、~/.codex/skills；有 workdir 时加上从该目录到最近 Git 根的 .agents/skills，无 Git 根时只检查该目录。跟随软链接，按真实路径去重，同名不同文件都保留；不返回正文。按 [skills] max_chars 压缩，默认 ${DEFAULT_SKILL_MAX_CHARS} Unicode 字符（约 10000 tokens）；路径可无损展开，描述公平保留前缀，名称/路径/策略超出目标也不隐藏条目。仅显式 Skill 不展示触发描述；只在用户明确要求使用该项时读全文，“不要使用”或其他文档推荐不算授权。勿另设过小的 exec.max_output_tokens 截断目录。`,
  },
  {
    name: "import_file",
    schema: IMPORT_FILE_SCHEMA,
    description:
      "将本次 exec.files[index] 流式保存到显式 destination，返回 {path,size,sha256}；不会自动下载未使用的文件。默认不覆盖，失败清理临时文件；成功后用返回路径处理文件，不保存或输出下载 URL。",
  },
  {
    name: "export_file",
    schema: EXPORT_FILE_SCHEMA,
    description:
      "显式交付文件快照，返回 {id,name,mime_type,size,sha256,expires_at,uri}。成功后 exec/wait 自动附带原生 resource_link，无需 text()，不受文本预算影响。默认 resource 至多 32 MiB，经本实例私有 MCP 入口 resources/read 获取；url 需配置独立 HTTPS 下载入口，任何持有链接者均可下载。过期失效，不承诺写入 ChatGPT sandbox。",
  },
  {
    name: "revoke_file",
    schema: REVOKE_FILE_SCHEMA,
    description:
      "撤销当前对话的文件导出，返回 {revoked:true}；拒绝新的资源读取和 URL 下载。已开始或已完成的下载不能收回。",
  },
  {
    name: "exec_command",
    schema: COMMAND_SCHEMA,
    output: TERMINAL_OUTPUT,
    description:
      "运行本机命令。返回对象；仍在运行或有未读输出时返回 session_id，用 write_stdin 续读。每次最多读取 1 MiB，其余保留在进程会话中，不丢弃。",
  },
  {
    name: "write_stdin",
    schema: STDIN_SCHEMA,
    output: TERMINAL_OUTPUT,
    description:
      "写入、轮询、调整 PTY 或终止终端；返回与 exec_command 相同的对象，只包含尚未读取的输出。",
  },
  {
    name: "apply_patch",
    schema: PATCH_SCHEMA,
    freeform: true,
    output: {
      type: "object",
      properties: {
        success: { type: "boolean" },
        exit_code: { type: "integer" },
        output: { type: "string" },
      },
      required: ["success", "exit_code", "output"],
      additionalProperties: false,
    },
    description: `接收单个补丁字符串，不要传 {patch,workdir}。相对路径基于 exec.workdir；失败可能部分生效，请检查 success。补丁遵循以下 Lark grammar：\n${PATCH_GRAMMAR}`,
  },
  {
    name: "view_image",
    schema: IMAGE_SCHEMA,
    description:
      "读取本机已有图片，返回 MCP CallToolResult；用 image(result.content[0]) 显式交给模型，不能 text() 图片的 base64。",
  },
  {
    name: "tool_search",
    schema: SEARCH_SCHEMA,
    description:
      "按需连接配置的下游 MCP，缓存目录并进行 BM25 搜索。返回 {tools:[{name,description}],errors,note}，描述含完整契约。新发现或更新的方法从下一次 exec 可用；同一脚本不能调用尚未绑定的方法。",
  },
];
export function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _dialect, ...value } = z.toJSONSchema(schema, {
    unrepresentable: "throw",
  });
  return value;
}
export function describeContract(contract: NativeContract): string {
  return `${contract.description}\n调用：await tools.${contract.name}(${contract.freeform ? "patch" : "args"})\n输入 JSON Schema：${JSON.stringify(jsonSchema(contract.schema))}${contract.output ? `\n返回 JSON Schema：${JSON.stringify(contract.output)}` : ""}`;
}
export function bindNative(
  contract: NativeContract,
  call: CodeModeToolDefinition["call"],
): CodeModeToolDefinition {
  return {
    name: contract.name,
    description: describeContract(contract),
    kind: contract.freeform ? "freeform" : "function",
    ...(!contract.freeform ? { inputSchema: jsonSchema(contract.schema) } : {}),
    ...(contract.output ? { outputSchema: contract.output } : {}),
    call: async (raw, context) => {
      const parsed = contract.schema.safeParse(raw);
      if (!parsed.success)
        throw new Error(
          `工具 ${contract.name} 参数无效：${parsed.error.issues.map((issue) => `${issue.path.join(".") || "/"} ${issue.code}`).join(", ")}；尚未执行。`,
        );
      return call(parsed.data, context);
    },
  };
}
export const EXEC_DESCRIPTION = `在隔离 V8 中执行 JavaScript 异步模块，通过 tools.* 组合、并发本机及下游 MCP 调用。无 Node、文件系统、网络、console 或 import；仅输入 JS。
首次使用本实例或进入尚未发现 Skills 的项目时，先 text(await tools.list_skills({})) 输出完整目录；匹配任务后用 exec_command 读取其真实路径的完整 SKILL.md 再执行。目录仍在上下文中时无需重复列出；仅显式 Skill 必须由用户明确要求使用，不能按任务相似性或其他文档推荐自行读取。
附件通过顶层 files 绑定，不要写入 source；import_file(index) 在机器端下载。export_file 显式交付文件并由 exec/wait 原生返回资源链接，不把完整文件 Base64 搬进模型。
本次默认目录来自 workdir；不同 exec 不共享普通 JS 变量或当前目录。Shell 的 cd 不改变工具默认目录，下游 MCP 参数不改写。
store(key,value)/load(key) 直接使用 Codex 原生的对话内存存储，不另设存储配额。key 为字符串，未命中返回 undefined；需宿主的 openai/session，缺失时调用报错。所有 cell 收尾且空闲 ${SESSION_IDLE_MS / 3_600_000} 小时，或服务/host 重启后数据丢失。新 cell 读启动快照，host 完成时合并写入，不依赖外层 wait 收取；脚本报错也可能提交。load 返回副本，修改后需 store，并发同键非事务；大数据或长期数据用文件。
用 await tools.<name>(args) 调用；apply_patch 接收字符串，其他工具接收对象。独立操作可 Promise.all，必须 await；未等待的 Promise 不是可靠后台任务。
ALL_TOOLS 是本次已绑定工具的 {name,description}[]；find/filter 可读取完整契约。外部能力先 tools.tool_search；新方法下一次 exec 才绑定。不要猜名称或参数。
返回值不会自动交给模型；text(value) 输出文字或 JSON，image(block)/audio(block) 输出原生媒体块，generatedImage({image_url,output_hint?}) 输出已有图片和可选说明，不调用生成 API；image_url 仅支持 base64 data URL，不接受 HTTP URL 或路径。MCP 返回先检查 isError，有 structuredContent 优先使用，仅从 content 补充不同内容，避免重复 JSON。
超过等待窗口返回 Script running 与 cell_id，只用 wait 续取；yield_control() 主动交回累计输出并继续执行；exit() 结束脚本。setTimeout/clearTimeout 可用，但计时器必须通过 Promise 等待。notify 不支持。
source 可用首行 // @exec: {"yield_time_ms":10000,"max_output_tokens":1000}；同名顶层参数优先。仅显式设置 max_output_tokens/wait.max_tokens 才按近似预算截断本次文本，不影响原始工具结果或 store；wait 预算不继承 exec，省略不截断。截断文本未必是有效 JSON，被省略内容不由后续 wait 补发。
cell_id 不等于终端 session_id；已交回句柄的进程通过后续 exec 内 write_stdin 操作。取消不回滚副作用。仅显式输出必要结果；默认不截断，不自动落盘，超出真实传输边界会报错，操作可能已发生，不自动重试。

本机及发现契约：\n${NATIVE_CONTRACTS.map((contract) => `### ${contract.name}\n${describeContract(contract)}`).join("\n\n")}`;
export const WAIT_DESCRIPTION =
  "续取 exec 返回的运行中 cell_id 的新增输出，或终止该 cell。默认、推荐和最长等待均为 110 秒；完成、主动 yield 或终止时提前返回。可用 max_tokens 限制本次近似文本预算，省略不限量且不继承 exec；媒体与状态保留。终端 session_id 由 exec 内的 write_stdin 操作。";

import { z } from "zod/v4";
import type { CodeModeToolDefinition } from "./code-mode/types.js";
import { SESSION_IDLE_MS } from "./code-mode/session-pool.js";
import { shellDescription, type CommandShell } from "./host/shell.js";
import {
  HOST_FILE_SCHEMA,
  IMPORT_FILE_SCHEMA,
  EXPORT_FILE_SCHEMA,
} from "./files/contracts.js";

const ms = (maximum: number, description: string) =>
  z.number().int().min(0).max(maximum).describe(description).optional();
const tokenBudget = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER)
  .describe(
    "本次文本的近似 token 预算，0 省略文本；最终响应仍限 36,000 UTF-8 字节。超限保留首尾；媒体和状态保留，嵌套结果及 store 不变。",
  )
  .optional();
export const EXEC_SCHEMA = z
  .object({
    max_output_tokens: tokenBudget,
    files: z
      .array(HOST_FILE_SCHEMA)
      .optional()
      .describe(
        "ChatGPT 原生文件引用数组，按原顺序原样传入；宿主绑定文件对象，脚本通过 import_file 的零基 index 选择。",
      ),
    source: z
      .string()
      .min(1)
      .describe(
        "JavaScript 异步模块源码字符串；Shell 命令通过 tools.exec_command({cmd:...}) 执行。",
      ),
    workdir: z
      .string()
      .min(1)
      .describe("本次本机工具的默认目录；省略或相对路径均基于服务用户主目录。")
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
      "最长等待毫秒数，默认 110000；完成或主动 yield 时提前返回。",
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
    cmd: z.string().min(1).describe("交给所选 Shell 的命令代码。"),
    workdir: z
      .string()
      .min(1)
      .describe("本次命令目录；相对路径基于 exec.workdir。")
      .optional(),
    shell: z
      .string()
      .min(1)
      .refine((value) => !!value.trim() && !value.includes("\0"))
      .describe(
        "本次 Shell 可执行文件名或路径；省略使用实例默认值。相对路径基于本次命令目录。",
      )
      .optional(),
    login: z
      .boolean()
      .describe(
        "本次启动模式；省略继承实例配置。PowerShell 控制 profile，其他 Shell 控制 login；不改变后续命令。",
      )
      .optional(),
    tty: z.boolean().describe("true 分配 PTY；默认普通管道。").optional(),
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
      "无未读输出时的最长等待；新输出或进程结束时提前返回。写入默认 250 毫秒，纯轮询默认 110000 毫秒。",
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
      .describe(
        "本机已有 PNG/JPEG/WebP/GIF 图片路径；相对 exec.workdir，支持 ~/。",
      ),
    detail: z
      .enum(["high", "original"])
      .describe("默认 high；original 请求原始细节。")
      .optional(),
  })
  .strict();
export const SEARCH_SCHEMA = z
  .object({
    query: z.string().min(1).describe("所需工具的用途、名称或服务名。"),
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
const SKILL_INVOCATION_RULE =
  "普通 Skill 可按目录中的触发描述自动选择；标记为仅显式的 Skill 只有用户明确点名要求使用时才能读取。";
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
    truncated: { type: "boolean", const: true },
    omitted_bytes: { type: "integer", minimum: 0 },
    stderr_bytes: {
      type: "integer",
      minimum: 0,
      description:
        "普通管道累计收到的 stderr 字节数（含已截断部分）；不等同于执行失败。PTY 不区分流。",
    },
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
const NATIVE_CONTRACTS: readonly NativeContract[] = [
  {
    name: "list_skills",
    schema: SKILL_SCHEMA,
    output: { type: "string" },
    description: `返回可用 Skill 的名称、用途和 SKILL.md 真实路径，以 text(result) 输出目录。始终包含用户级 Skills；有 workdir 时加入适用的项目 Skills。${SKILL_INVOCATION_RULE}选定后读取完整 SKILL.md。`,
  },
  {
    name: "import_file",
    schema: IMPORT_FILE_SCHEMA,
    description:
      "将本次 exec.files[index] 保存到 destination，返回 {path,size,sha256}。默认保留已有目标；overwrite=true 时，下载校验成功后替换。后续操作使用返回的本机路径。",
  },
  {
    name: "export_file",
    schema: EXPORT_FILE_SCHEMA,
    description:
      "向用户交付独立文件快照，返回 {id,name,mime_type,size,sha256,expires_at,uri}；exec/wait 自动附带原生 resource_link。默认 resource 至多 32 MiB，由宿主经 resources/read 获取；url 需已配置 HTTPS 下载入口，持有链接者均可下载。到期失效；宿主决定文件展示或挂载方式。",
  },
  {
    name: "exec_command",
    schema: COMMAND_SCHEMA,
    output: TERMINAL_OUTPUT,
    description:
      "运行或输出待取时返回 session_id，用 write_stdin 续取。exit_code 为 Shell 退出码；每次≤4 MiB，缓冲溢出由 truncated/omitted_bytes 标记。",
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
    description: `新增、删除、更新或移动文本文件。接收完整补丁字符串，相对路径基于 exec.workdir；检查返回的 success，失败时可能已有部分变更。补丁遵循以下 Lark grammar：\n${PATCH_GRAMMAR}`,
  },
  {
    name: "view_image",
    schema: IMAGE_SCHEMA,
    description:
      "读取本机已有图片用于视觉检查，返回 MCP CallToolResult；用 image(result.content[0]) 输出其中的图片。",
  },
  {
    name: "tool_search",
    schema: SEARCH_SCHEMA,
    description:
      "在已加载的下游目录中进行 BM25 搜索，返回 {tools:[{name,description}],errors}；description 含完整调用契约。",
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
export function nativeContracts(
  shell: CommandShell,
): readonly NativeContract[] {
  return NATIVE_CONTRACTS.map((contract) =>
    contract.name === "exec_command"
      ? {
          ...contract,
          description: shellDescription(shell) + contract.description,
        }
      : contract,
  );
}

export function execDescription(
  contracts: readonly NativeContract[],
  idleHours = SESSION_IDLE_MS / 3_600_000,
): string {
  return `执行 JavaScript 异步模块，通过 tools.* 编排本机及下游 MCP 调用。每次使用新的隔离 V8；V8 本身没有 Node.js、console 或模块导入，文件与网络等外部操作由 tools.* 在实际机器执行。本机任务使用这里的工具；ChatGPT 容器不共享本机的文件和网络环境。
首次使用本实例或进入尚未发现 Skills 的项目时，先 text(await tools.list_skills({})) 输出目录。${SKILL_INVOCATION_RULE}选定后读取完整 SKILL.md；目录仍在上下文中时可直接使用。
用 await tools.<name>(args) 调用；apply_patch 接收字符串，其他工具接收对象。独立操作可 await Promise.all([...])；脚本结束时，未等待的 Promise 会被丢弃。
ALL_TOOLS 是本次已绑定工具的 {name,description}[]；find/filter 可读取完整契约，tools.tool_search 可检索下游。已知工具可直接 tools[name](args)；目录更新从下一次 exec 生效。
本机工具的默认目录由 workdir 指定；不同 exec 的普通 JS 变量和 Shell 当前目录不共享，Shell 的 cd 只影响该进程。
通过输出助手显式交回结果：text(value) 输出字符串或 JSON；image(dataUrlOrBlock, detail?)、audio(dataUrlOrBlock) 输出 base64 data URL 或 MCP content 中的单个媒体块，例如 image(result.content[0])；generatedImage({image_url,output_hint?}) 输出已有图片的 data URL 及可选说明。对下游 MCP 的 CallToolResult，先检查 isError，有 structuredContent 时优先使用，再从 content 补充不同文本与媒体。
文件引用通过顶层 files 绑定，tools.import_file({index,destination}) 保存到机器；tools.export_file({path}) 交付快照，exec/wait 自动附带原生资源链接。
store(key,value) 跨 exec 保存可序列化值，load(key) 返回副本，未命中为 undefined；key 为字符串，依赖宿主的对话标识 openai/session。每次 exec 读启动快照，结束时合并写入，脚本报错也可能提交；修改 load 的副本后需再次 store，并发同键写入非事务。空闲 ${idleHours} 小时、内存回收或重启后存储可能清空；同一对话可重新 exec，长期数据用文件。
Script completed 仅表示 JavaScript 编排结束；命令还需检查 exit_code 与输出，stderr_bytes 表示管道收到过错误流（不等同于失败）。
超出等待窗口返回 Script running 与 cell_id，用 wait 续取新增输出；yield_control() 立即交回累计输出并继续运行；exit() 成功结束脚本。setTimeout/clearTimeout 可用，等待定时器需显式 await Promise。
source 可用首行 // @exec: {"yield_time_ms":10000,"max_output_tokens":1000}；同名顶层参数优先。最终文本合计最多 36,000 UTF-8 字节，超出保留首尾。先在 JS 内筛选/汇总大结果，跨轮使用可先 store；max_output_tokens/wait.max_tokens 可再缩小本次输出，wait 单独设置，媒体和资源链接保留。被截断的 JSON 可能不完整，后续 wait 不补发。
cell_id 用于脚本，exec_command 返回的 session_id 用于独立终端，后者通过 exec 内 write_stdin 操作。通常组合独立调用以节省每轮工具次数。取消或调用失败时，副作用可能已发生；仅在确认未执行后重试。若宿主拒绝执行，先检查请求是否合规，再修正或拆分复杂脚本。

本机及发现契约：\n${contracts.map((contract) => `### ${contract.name}\n${describeContract(contract)}`).join("\n\n")}`;
}
export const WAIT_DESCRIPTION =
  "续取 exec 返回的 cell_id：仍运行时返回新增输出及同一 cell_id，完成时返回最终结果。默认及最长等待 110 秒，完成、主动 yield 或终止时提前返回；terminate=true 终止脚本。max_tokens 可缩小本次文本预算，不继承 exec；最终文本仍限 36,000 UTF-8 字节，媒体与状态保留。终端 session_id 用 exec 内的 write_stdin 续取。";

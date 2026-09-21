import { z } from "zod/v4";
import type { CodeModeToolDefinition } from "./code-mode/types.js";
import { SESSION_IDLE_MS } from "./code-mode/session-pool.js";
import { shellDescription, type CommandShell } from "./host/shell.js";
import type { NativeToolName } from "./tool-names.js";
import { REQUEST_USER_INPUT_SCHEMA } from "./user-questions.js";
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
    "本次文本的近似 token 预算，0 省略文本；普通结果仍限 36,000 UTF-8 字节。超限保留首尾；媒体和状态保留，嵌套结果及 store 不变；用户补充另计。",
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
    cmd: z.string().min(1).describe("交给所选 Shell 的命令原文。"),
    workdir: z
      .string()
      .min(1)
      .describe("命令目录；省略或相对路径基于 exec.workdir，支持 ~/。")
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
      300_000,
      "输出收集窗口：非空输入默认 250 毫秒，有效范围 250–30000；仅读取默认 5000，有效范围 5000–300000。进程结束提前返回，日志不结束窗口；显式 0 立即读取。",
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
        "项目发现起点，相对 exec.workdir。省略时继承显式的 exec.workdir；两者均省略则只列用户级 Skills。",
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
export interface NativeContract {
  name: NativeToolName;
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
    description: `返回可用 Skill 的名称、用途和 SKILL.md 真实路径。始终包含用户级 Skills；有 workdir 时加入适用的项目 Skills。${SKILL_INVOCATION_RULE}选定后读取完整 SKILL.md。`,
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
      "向 exec_command 的终端写入字符并收集未读输出；chars 省略或为空时只收集输出。可调整 PTY 尺寸、关闭管道 stdin 或终止进程。窗口到期不终止进程，返回的 session_id 可继续使用。",
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
    name: "request_user_input_async",
    schema: REQUEST_USER_INPUT_SCHEMA,
    output: {
      type: "object",
      properties: {
        accepted: { const: true, type: "boolean" },
        request_id: { type: "string" },
      },
      required: ["accepted", "request_id"],
      additionalProperties: false,
    },
    description:
      "在工作中向本对话的 Web 用户询问缺失信息、偏好或约束。问题提交后立即返回 accepted，不等待回答；可继续不依赖答案的工作。用户可选任一选项或‘以上都不是’，并附加补充；题目、选择与补充随后续任一工具响应作为 user_notes 或‘用户额外补充’返回。需已启动 Web 且宿主提供对话标识。",
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
export function nativeDefinition(
  contract: NativeContract,
): Omit<CodeModeToolDefinition, "call"> {
  return {
    name: contract.name,
    description: describeContract(contract),
    kind: contract.freeform ? "freeform" : "function",
    ...(!contract.freeform ? { inputSchema: jsonSchema(contract.schema) } : {}),
    ...(contract.output ? { outputSchema: contract.output } : {}),
  };
}
export function bindNative(
  contract: NativeContract,
  call: CodeModeToolDefinition["call"],
): CodeModeToolDefinition {
  return {
    ...nativeDefinition(contract),
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
  return `运行 JavaScript 异步模块，编排、并发调用工具并筛选结果。每次使用新的 V8；没有 Node.js、console 或模块导入，文件和网络操作通过 tools 在实际机器执行。ChatGPT 容器与该机器不共享文件和网络环境。
source 填写 JavaScript 源码。所有本机及下游工具通过 await tools.<name>(args) 调用；独立调用可用 Promise.all。脚本结束即销毁本次隔离环境，未 await 的 Promise 会被丢弃。
本机工具的完整契约列于下方；apply_patch 接收字符串，其他工具接收对象。workdir 指定本次默认目录，省略时为服务用户主目录；JS 普通变量不跨 exec 保留，Shell 的 cd 只影响该进程。
首次使用或进入新项目时用 list_skills 查看目录，按其规则选择并读取完整 SKILL.md；已在上下文中的目录无需重读。
创建和修改文本文件优先用 tools.apply_patch，避免命令行参数长度限制。多行字符串可用模板字面量；String.raw 保留反斜杠，反引号及 \${...} 仍遵循 JS 语法，Shell 引号和 Markdown 围栏不隔离外层模板。

## 工具发现
ALL_TOOLS 是本次已绑定工具的 {name,description}[]，description 含完整调用契约。下游契约按需查看，已知名称和参数可直接 await tools[name](args)。目录本身不自动输出，更新在下一次 exec 生效。
目录筛选示例：text(ALL_TOOLS.filter(t => /关键词/i.test(t.name + " " + t.description)))；只列名称可用 text(ALL_TOOLS.map(t => t.name))。

## 输出与全局助手
- text(value)：追加文本；非字符串按 JSON 序列化。工具返回值需显式输出，文件导出的资源链接除外。
- image(dataUrlOrBlock, detail?)：追加 base64 data URL、{image_url,detail?} 或单个 MCP ImageContent；例如 image(result.content[0])。detail 为 auto/low/high/original，可覆盖块内设置。
- audio(dataUrlOrBlock)：追加 base64 data URL、{audio_url} 或单个 MCP AudioContent。
- generatedImage({image_url,output_hint?})：追加已有图片的 data URL 和可选说明。
- store(key,value) / load(key)：key 为字符串，在同一宿主对话中保存可序列化值／读取副本，未命中为 undefined。每次 exec 读取启动快照，结束时合并写入，报错也可能提交；修改副本后需 store，并发同键写入非事务。空闲 ${idleHours} 小时、内存回收或重启可能清空存储，长期数据用文件。
- exit()：立即成功结束脚本。yield_control()：立即交回累计输出，脚本继续运行。
- setTimeout(callback,ms) / clearTimeout(id)：安排／取消定时器；定时器本身不保持脚本存活，等待需显式 await Promise。
对下游 MCP 的 CallToolResult，先检查 isError，有 structuredContent 时优先使用，再从 content 补充不同文本与媒体。本机工具按各自契约返回对象或字符串；view_image 返回 CallToolResult。
普通输出上限为 36,000 UTF-8 字节，超限保留首尾且不补发；先用 JS 筛选/汇总或 store 后分段读取，内层结果不受该出口限额提前裁剪。max_output_tokens 限本次输出，wait.max_tokens 单独设置；媒体与状态保留。用户补充随后续正常响应附带，含补充合计最多 37,000 字节。

## 执行与等待
exec 默认等待 10000 毫秒，最长 30000；超时返回 Script running 和 cell_id，使用外层 wait 续取。source 也可用首行 // @exec: {"yield_time_ms":10000,"max_output_tokens":1000}，同名 MCP 参数优先。
Script completed 表示本次 JS 结束，不代表所有命令成功；检查工具结果中的退出状态。cell_id 属于脚本；exec_command 返回的 session_id 属于独立终端，用 tools.write_stdin 操作。
停止 cell 用外层 wait 的 terminate=true；已交回 session_id 的独立终端用 tools.write_stdin({session_id,terminate:true}) 停止。取消或失败不回滚副作用，调用失败时先核对已发生的操作；宿主拒绝执行时检查请求，再修正或拆分复杂脚本。

## 本机工具
${contracts.map((contract) => `### ${contract.name}\n${describeContract(contract)}`).join("\n\n")}`;
}
export const WAIT_DESCRIPTION =
  "续取 exec 返回的 cell_id：仍运行时返回新增输出及同一 cell_id，完成时返回最终结果。默认及最长等待 110 秒，长等待减少轮询；完成、主动 yield 或终止时提前返回。terminate=true 终止脚本，取消本次等待只取消观察。max_tokens 可缩小本次文本预算，不继承 exec；普通文本仍限 36,000 UTF-8 字节，媒体与状态保留。用户补充另计，合计最多 37,000 UTF-8 字节。终端 session_id 在 exec 内用 tools.write_stdin 续取。";

import { z } from "zod/v4";
import type { CodeModeToolDefinition } from "./code-mode/types.js";
import { SESSION_IDLE_MS } from "./code-mode/session-pool.js";
import { shellDescription, type CommandShell } from "./host/shell.js";
import { NATIVE_TOOL_TITLES, type NativeToolName } from "./tool-names.js";
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
      .describe(
        "命令目录；省略或相对路径基于服务用户主目录，exec 内基于 exec.workdir。",
      )
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
      "最长等待毫秒数，默认且推荐 110000，减少轮询；进程结束时提前返回，已有或新增输出不提前唤醒。0 立即读取。",
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
        "本机已有 PNG/JPEG/WebP/GIF 图片路径；相对服务用户主目录，exec 内相对 exec.workdir，支持 ~/。",
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
export const DIRECT_PATCH_SCHEMA = z
  .object({
    patch: PATCH_SCHEMA.describe(
      "完整 Codex 补丁原文，保留换行；从 *** Begin Patch 开始。",
    ),
    workdir: z
      .string()
      .min(1)
      .optional()
      .describe(
        "补丁相对路径的基准目录；省略或相对路径基于服务用户主目录，支持 ~/。",
      ),
  })
  .strict();
export const DIRECT_IMPORT_SCHEMA = IMPORT_FILE_SCHEMA.omit({ index: true })
  .extend({
    file: HOST_FILE_SCHEMA.describe(
      "ChatGPT 原生文件引用；宿主绑定为文件对象，按原值传入。",
    ),
  })
  .strict();
const SKILL_INVOCATION_RULE =
  "普通 Skill 可按目录中的触发描述自动选择；标记为仅显式的 Skill 只有用户明确点名要求使用时才能读取。";
const SKILL_SCHEMA = z
  .object({
    workdir: z
      .string()
      .min(1)
      .optional()
      .describe(
        "项目发现起点；相对服务用户主目录，exec 内相对 exec.workdir。省略时只列用户级 Skills，exec 内继承显式的 exec.workdir。",
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
      "写入、等待、调整 PTY 或终止终端；写入后或仅读取都默认等进程结束或 110 秒，日志不提前唤醒。长等待减少轮询；需及时交互时缩短 yield_time_ms，0 立即读取。只返回未读输出，超时不终止进程。",
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
      "在本次 ALL_TOOLS 的全部本机及下游工具中进行 BM25 搜索，返回 {tools:[{name,description}],errors}；命中项含完整契约，可在同一 exec 调用。已知名称可直接调用。",
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

/** MCP requires object inputs. Only patch context and host file binding differ from Code Mode. */
export function directContract(contract: NativeContract) {
  let schema = contract.schema;
  let description = contract.description;
  switch (contract.name) {
    case "apply_patch":
      schema = DIRECT_PATCH_SCHEMA;
      description =
        description.replace(
          "相对路径基于 exec.workdir",
          "相对路径基于 workdir",
        ) +
        "\npatch 直接填写补丁原文，Markdown 围栏、反引号和 ${...} 按原样保留；仅按 JSON 字符串编码，不包 JavaScript。";
      break;
    case "import_file":
      schema = DIRECT_IMPORT_SCHEMA;
      description = description.replace(
        "本次 exec.files[index]",
        "宿主绑定的 file",
      );
      break;
    case "export_file":
      description = description.replace("exec/wait 自动附带", "本次响应附带");
      break;
    case "exec_command":
      description +=
        "cmd 直接填写 Shell 原文，保留多行与 Shell 自身的引号/反引号，仅按 JSON 字符串编码。";
      break;
    case "view_image":
      description = "读取本机已有图片用于视觉检查，直接返回原生 MCP 图片。";
      break;
    case "tool_search":
      description =
        "在当前全部本机及下游工具中进行 BM25 搜索，返回 {tools:[{name,description}],errors}。命中项含 exec 内的完整契约；下游工具通过 exec 中的 tools[name](args) 调用。";
      break;
  }
  if (contract.name === "exec_command")
    description +=
      "创建和修改文本文件优先使用 apply_patch，避免命令行参数长度限制。";
  if (contract.name !== "view_image")
    description +=
      "对象结果在 structuredContent，文本在 content；有用户补充时，structuredContent 为 {result:原结果,user_notes:[补充原文]}，文本用「用户额外补充：」附带。与 exec/wait 一样，普通结果限 36,000 UTF-8 字节，超出保留首尾，截断不补发；含用户补充合计最多 37,000 字节。";
  return {
    title: NATIVE_TOOL_TITLES[contract.name],
    schema,
    description:
      description +
      (contract.output
        ? `\n正常返回值形状：${JSON.stringify(contract.output)}`
        : ""),
  };
}

export function execDescription(
  contracts: readonly NativeContract[],
  idleHours = SESSION_IDLE_MS / 3_600_000,
): string {
  return `执行 JavaScript 异步模块，通过 tools.* 编排本机及下游 MCP 调用。每次使用新的隔离 V8；V8 本身没有 Node.js、console 或模块导入，文件与网络等外部操作由 tools.* 在实际机器执行。本机任务使用这里的工具；ChatGPT 容器不共享本机的文件和网络环境。
首次使用本实例或进入尚未发现 Skills 的项目时，先 text(await tools.list_skills({})) 输出目录。${SKILL_INVOCATION_RULE}选定后读取完整 SKILL.md；目录仍在上下文中时可直接使用。
本机工具 ${contracts.map((contract) => contract.name).join("、")} 同时可直接调用或通过 tools.* 调用。exec 内沿用同名参数；apply_patch 接收补丁字符串并使用 exec.workdir，import_file 使用 {index,destination,overwrite?} 选择 exec.files。本机对象结果直接返回，view_image 返回 CallToolResult；exec/wait 仅为外层工具。
exec 可合并、并发调用并用 JS 筛选/汇总结果，减少外层往返；命令和补丁需多处理一层 JS 字符串语法。直接调用省去该层嵌套，结果直接进入最终输出限制；Shell 或补丁本身也可组合多个操作。
用 await tools.<name>(args) 调用；独立操作可 await Promise.all([...])；脚本结束时，未等待的 Promise 会被丢弃。
创建和修改文本文件优先用 tools.apply_patch，避免把文件内容塞进终端命令而触及参数长度上限。
多行 JS 字符串可用模板字面量，保留反斜杠用 String.raw；Shell 引号、here-string 和 Markdown 围栏不隔离外层 JS。模板正文反引号用 \${"\`"}、围栏用 \${"\`".repeat(3)}、字面量 \${name} 用 \${"\${name}"} 插入；String.raw 也保留转义用的反斜杠。
ALL_TOOLS 是本次已绑定本机和下游工具的 {name,description}[]，含 exec 内的完整调用契约；find/filter 或 tools.tool_search 按需读取。数组本身不自动输出。已知工具可直接 tools[name](args)，目录更新从下一次 exec 生效。
本机工具的默认目录由 workdir 指定；不同 exec 的普通 JS 变量和 Shell 当前目录不共享，Shell 的 cd 只影响该进程。
通过输出助手显式交回结果：text(value) 输出字符串或 JSON；image(dataUrlOrBlock, detail?)、audio(dataUrlOrBlock) 输出 base64 data URL 或 MCP content 中的单个媒体块，例如 image(result.content[0])；generatedImage({image_url,output_hint?}) 输出已有图片的 data URL 及可选说明。对下游 MCP 的 CallToolResult，先检查 isError，有 structuredContent 时优先使用，再从 content 补充不同文本与媒体。
文件引用通过顶层 files 绑定，tools.import_file({index,destination}) 保存到机器；tools.export_file({path}) 交付快照，exec/wait 自动附带原生资源链接。
store(key,value) 跨 exec 保存可序列化值，load(key) 返回副本，未命中为 undefined；key 为字符串，依赖宿主的对话标识 openai/session。每次 exec 读启动快照，结束时合并写入，脚本报错也可能提交；修改 load 的副本后需再次 store，并发同键写入非事务。空闲 ${idleHours} 小时、内存回收或重启后存储可能清空；同一对话可重新 exec，长期数据用文件。
Script completed 仅表示 JavaScript 编排结束；命令还需检查 exit_code 与输出，stderr_bytes 表示管道收到过错误流（不等同于失败）。
超出等待窗口返回 Script running 与 cell_id，用 wait 续取新增输出；yield_control() 立即交回累计输出并继续运行；exit() 成功结束脚本。setTimeout/clearTimeout 可用，等待定时器需显式 await Promise。
source 可用首行 // @exec: {"yield_time_ms":10000,"max_output_tokens":1000}；同名顶层参数优先。本服务的 exec/wait 与直接调用均限每次最终文本 36,000 UTF-8 字节，超出保留首尾；exec 内的工具结果不受该出口限额提前裁剪。跨轮使用可先 store；max_output_tokens/wait.max_tokens 可再缩小本次输出，wait 单独设置，媒体和资源链接保留。被截断的 JSON 可能不完整，后续 wait 不补发。用户补充另计，合计最多 37,000 UTF-8 字节。
cell_id 用于脚本，exec_command 返回的 session_id 用于独立终端，后者通过 write_stdin 操作。取消或调用失败时，副作用可能已发生；仅在确认未执行后重试。若宿主拒绝执行，先检查请求是否合规，再修正或拆分复杂脚本。`;
}
export const WAIT_DESCRIPTION =
  "续取 exec 返回的 cell_id：仍运行时返回新增输出及同一 cell_id，完成时返回最终结果。默认及最长等待 110 秒，长等待减少轮询；完成、主动 yield 或终止时提前返回，terminate=true 终止脚本。max_tokens 可缩小本次文本预算，不继承 exec；普通文本仍限 36,000 UTF-8 字节，媒体与状态保留。用户补充另计，合计最多 37,000 UTF-8 字节。终端 session_id 用 write_stdin 续取。";

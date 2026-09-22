# ADR-002 工具发现与契约

当前生效，2026-09-22 更新。

## 工具入口与契约来源

顶层仅提供 exec/wait，本机工具的完整契约在 exec 描述中展开。名称、参数校验和说明共用可执行定义，
ALL_TOOLS 条目与 tools.* 绑定也由它生成。这样新 Agent 无需额外发现常用工具，下游契约则按需输出。
隐藏的直接入口和手写契约副本均不保留。

ALL_TOOLS 沿用 Codex 的 `{name, description}[]` 数组，包含本次已绑定的全部本机及下游方法。
description 保留完整输入和返回约束，包括必填项、枚举与引用。
数组留在运行时，只有显式输出才进入模型上下文，因此本机条目也可完整保留。
按名称或描述使用标准 JS 筛选，已知名称和参数时可在第一次 exec 直接调用。

取消 tool_search 及 BM25 索引，也不另设 schema/read/call API 或搜索后的解锁步骤。
因此没有内建相关性排名和同义词召回，但可用接口更少，目录与调用方式一致。
Web 下游页只筛选当前目录，展示完整契约与连接错误，不执行检索探针。

## 启动与目录更新

MCP 对外就绪前，所有启用的下游须连接成功，完成协议协商和凭据检查，读完工具目录并验证输入契约。
其中一个服务失败就停止本次启动并清理资源；不用的服务由用户显式停用。
这会增加启动时间，也让单个故障阻止就绪，但用户能在工作开始前处理登录或缺失工具的问题。
启动检查只读目录，不调用可能产生副作用的工具。

启动期限覆盖协商与全部分页，取消时清理 SDK 及其自有子进程。
stdio 继承完整环境，stderr 用于本机诊断，stdout 留给协议；HTTP 使用配置凭据。
用户在本机完成下游登录和授权。Widget、sampling、elicitation 及通用下游 OAuth 登录/刷新不在代理范围内，
ChatGPT 调用期间也不等待这些交互。ChatGPT 访问 exec-mcp 的入口 OAuth 单独配置。

每次 exec 的工具与 ALL_TOOLS 使用相同快照，目录更新只影响后续 exec。
断连后保留最后验证的契约，已知方法可据此重连；发送前重新核对契约。
工具移除、契约变化或无法核对时拒绝发送。已发送的调用失败后不自动重试，防止重复产生副作用。
名称规范化碰撞、重复工具及不存在的 enabled_tools 项都明确报错。

ChatGPT 可能缓存连接元数据。升级后，操作者需要重启并刷新连接，仅打开新聊天未必更新描述。
服务不在每次响应中重发 schema。回归同时检查实际 tools/list、ALL_TOOLS、首次嵌套调用和运行中的快照。

## 下游资源

MCP 通过 resources/list、resources/templates/list、resources/read 提供独立的数据接口。
有些服务只提供资源，工具也可能返回目录中没有的 resource_link。
exec 内保留 Codex 同名的三个辅助方法，复用现有下游连接及其认证、代理和请求生命周期。
它们按协议读取指定下游的资源，顶层工具仍只有 exec/wait。

指定服务时取一页，省略服务时并行汇总。资源和模板保留原始元数据，并附上配置中的准确服务名。
URI 与游标原样传递，由下游解析；已知 URI 可直接读取，来源可以是目录、模板展开或资源链接。
本机不修改 URI，也不额外要求 URI 必须先出现在目录中。

聚合保留成功服务的数据，通过 errors 报告失败。单服务分页不完整、循环或过大时明确失败。
资源正文在请求时读取；当前不缓存正文，也未加入订阅、模板补全或资源管理页。
使用 SDK 单页请求保留 nextCursor，读取时绕过缓存。enabled_tools 仅筛选工具，停用服务才排除它的资源。
结果先交给 JS 处理，沿用传输与并发保护，模型 token 预算在最终输出时生效。
本实例向宿主交付 export_file 的方向相反，见 [ADR-005](adr-005-file-transfer.md)。

## 模型契约与产品文档

本项目生成的 MCP instructions、工具及资源说明、schema 描述和 ALL_TOOLS 包装使用英语，
便于沿用 Codex 的同义原文；token 用量取决于具体模型和文本。
README、ADR、Web UI 和现有运行错误保持中文，用户补充、Skill 与第三方契约保留原文。

Agent 第一次阅读应能确定参数、默认值和返回类型，并知道如何输出结果及处理副作用。
描述只交代能力、环境和调用规则，省去个性、进度汇报及 Git 工作流指令。
工具描述与示例文档说明嵌套语言的语法风险；示例展示可行写法，具体构造方式由调用者选择。
Skill 的 explicit-only 来自用户元数据；压缩后的目录自行说明路径别名和省略方式。

完整语法和 schema 从代码生成。用户操作示例见 [Code Mode 示例](code-mode-examples.md)，
配置方法见[配置指南](configuration.md)，工具描述无需重复这些教程。

## Codex 参考与适配

参考固定 rust-v0.155.1，以及已核对的
[6149914 Code Mode prompt](https://github.com/openai/codex/blob/6149914a0e59363b6777080b3e953b05d592dbac/codex-rs/code-mode-protocol/src/description.rs)、
[Shell 定义](https://github.com/openai/codex/blob/6149914a0e59363b6777080b3e953b05d592dbac/codex-rs/core/src/tools/handlers/shell_spec.rs)、
[资源定义](https://github.com/openai/codex/blob/6149914a0e59363b6777080b3e953b05d592dbac/codex-rs/core/src/tools/handlers/mcp_resource_spec.rs)，
并查阅同快照的系统提示、图片和异步问题定义。运行组件另行固定，查阅源码不会触发升级。
Codex 的 Code Mode Only 使用 ALL_TOOLS；其他模型模式仍可能提供搜索工具。

| 保留的差异 | 原因 |
| --- | --- |
| MCP source/workdir/files 对象 | MCP 没有 Codex 的隐式 turn cwd；宿主附件在外层绑定，JS 使用索引。 |
| 补丁字符串及描述内的 Lark grammar | MCP inputSchema 没有 freeform grammar 槽，语法放在描述中供读取，固定引擎负责解析。 |
| 完整 JSON Schema 和字符串句柄 | 保留真实校验与当前执行器的字段类型。 |
| 外层预算和 110 秒 wait | 适配目标连接器，内层保留原值供 JS 处理，见 ADR-003。 |
| Shell 单次覆盖、EOF/resize/terminate 和零等待 | 保留现有进程操作；配置默认值允许单次参数覆盖。 |
| 原生 MCP 图片/文件块、Skills 和 Web 问答 | 适配 ChatGPT 的文件及消息交付方式，提供独立的 Skill 发现；未接入 notify 注入。 |
| 资源直接 URI 读取与聚合 errors | 支持模板和链接，并保留部分失败的信息。 |

含义相同处沿用上游原文，环境差异按实际行为说明。无需为措辞一致而接入完整 App Server、审批流程或另一套执行器。

# ADR-002：工具发现与契约

状态：生效。更新：2026-09-22。

## 一个入口，一份契约来源

**顶层仅 exec/wait，本机工具的完整契约在 exec 描述中一次性展开。**
名称、参数校验、说明、ALL_TOOLS 条目与 tools.* 绑定共用可执行定义；不维护隐藏的直接入口或手写镜像。
本机契约稍长，换取新 Agent 无需额外发现常用能力；下游契约不提前塞满提示上下文。

ALL_TOOLS 保持 Codex 的普通 `{name, description}[]` 数组，含本次已绑定的全部本机和下游方法。
description 保留完整输入与返回约束，不能用有损类型摘要省掉必填项、枚举或引用。
它留在运行时不会自动占用模型上下文，只有显式输出才进入上下文，因此不必排除本机条目。
按名称/描述使用标准 JS 查找、筛选；已知名称和参数时可第一次 exec 直接调用。

不提供 tool_search、BM25、额外的 schema/read/call API 或搜索后“解锁”。
接受没有内建相关性排名与同义词召回的代价，换取单一目录和较小工具表面。
Web 下游页面也只筛选当前目录、显示完整契约和连接错误，不执行检索探针。

## 启动完整连接，按需向模型展示

启用的下游在 MCP 对外就绪前完成连接、协议协商、凭据检查、全部工具目录页和输入契约验证。
任何启用服务失败都使本次启动失败并清理资源；故意不使用的服务应显式停用。
启动成本更高、单个故障可以阻止就绪，但不会把登录或缺失工具的问题留到 ChatGPT 工作途中。
启动验证不实际调用工具，不能用检查之名触发未知副作用。

启动期限覆盖协商和所有分页，不为每页重新计时；取消启动需要清理 SDK 及其自有子进程。
stdio 继承完整环境，stderr 用于本机诊断，stdout 留给协议；HTTP 使用配置凭据。
登录/授权由操作者在本机完成，不代理下游 Widget、sampling 或 elicitation，
也不在外层 ChatGPT 调用中再等待登录；通用下游 OAuth 登录与刷新器不在当前范围内。
这与 ChatGPT 访问 exec-mcp 时的入口 OAuth 是两条独立认证链。

每次 exec 的工具与 ALL_TOOLS 使用相同快照。目录更新只影响后续 exec，不能修改运行中的绑定。
断连后保留最后验证的契约以允许已知方法发起重连，但发送前重新核对当前契约；
工具已移除、契约变化或无法确认时拒绝发送。已发送调用失败不自动重试，因为副作用可能已生效。
名称规范化碰撞、重复工具和不存在的 enabled_tools 项明确报错，不静默覆盖或忽略。

服务目录与 ChatGPT 导入的元数据是不同层。只开新聊天不保证刷新旧连接；
升级后由操作者重启并刷新连接，不在每次响应中重发全套 schema。
回归应同时核对实际 tools/list、ALL_TOOLS、第一次嵌套调用以及运行中快照。

## 资源不是可调用工具的另一种索引

MCP resources/list、resources/templates/list、resources/read 是独立数据能力；
服务可以只提供资源，工具也可能返回不在资源目录中的 resource_link。ALL_TOOLS 无法替代它们。
保留 Codex 同名的三个 exec 内辅助方法，复用现有下游连接、认证、代理、超时与取消。
不增加顶层入口、通用 HTTP 下载器或任意本机文件读取捷径。

指定服务时取一页，省略服务时并行汇总。资源和模板保留原始元数据并附准确的配置服务名；
URI 和游标原样传递，不 trim、解码或映射为本机路径。已知 URI 可直接读取，
不要求先列目录，也不将已列 URI 当作白名单：模板展开和资源链接同样是有效来源。

聚合保留成功服务并报告 errors；单服务分页不完整、循环或过大时明确失败，不伪装成完整列表。
资源按需实时读取，不在启动时预读正文，不增加正文缓存、订阅、模板补全或资源管理 UI。
使用 SDK 的单页请求，避免自动汇总吞掉 nextCursor；读取绕过缓存以保持同一实时语义。
enabled_tools 只选择工具，服务级停用才排除该服务的资源。
资源结果先交给 JS 筛选，保留原有传输与并发保护，不按模型 token 限额提前裁剪。
本实例 export_file 的宿主资源交付是另一方向，见 [ADR-005](adr-005-file-transfer.md)。

## 英文契约，中文产品文档

本项目生成的 MCP instructions、工具/资源标题及说明、schema 描述和 ALL_TOOLS 包装使用英语，
便于沿用 Codex 同义原文；不宣称固定的跨模型 token 节省比例。
README、ADR、Web UI 和现有运行错误保持中文；用户补充、Skill 和第三方契约保持原文，不运行翻译层。

最高目标是第一次读取便能确定参数、默认值、返回类型、输出方式与副作用边界。
描述提供能力和环境事实，不复制 Agent 身份、个性、计划/汇报、Git 工作流或工具使用顺序。
不因一次调用构造错误累加“必须这样写”的教程；嵌套语言仅简要说明各层语法与文本保真边界。
Skill 的 explicit-only 是用户元数据策略，不是新增的编排偏好；压缩细节随实际目录返回，不提前写进工具说明。

工具说明与 README 不互为副本。完整语法和 schema 从代码生成，操作示例见
[Code Mode 示例](code-mode-examples.md)；用户配置见[配置指南](configuration.md)。

## Codex 参考与必要差异

以固定 rust-v0.155.1 和已核对快照
[6149914 的 Code Mode prompt](https://github.com/openai/codex/blob/6149914a0e59363b6777080b3e953b05d592dbac/codex-rs/code-mode-protocol/src/description.rs)、
[Shell 定义](https://github.com/openai/codex/blob/6149914a0e59363b6777080b3e953b05d592dbac/codex-rs/core/src/tools/handlers/shell_spec.rs)、
[资源定义](https://github.com/openai/codex/blob/6149914a0e59363b6777080b3e953b05d592dbac/codex-rs/core/src/tools/handlers/mcp_resource_spec.rs)
及同快照系统提示、图片和异步问题定义为参考。核对快照不等于自动升级运行组件。
Code Mode Only 下的目录路径不是“Codex 全面删除搜索”的证据；其他模型模式仍可保留搜索。

| 有意保留的差异 | 原因 |
| --- | --- |
| MCP 的 source/workdir/files 对象 | 没有 Codex 的隐式 turn cwd；宿主附件只能在 MCP 边界绑定，不能从 JS 文本猜测引用。 |
| 补丁字符串，描述内提供原版 Lark grammar | MCP inputSchema 没有 Codex freeform grammar 槽。实际仍由固定引擎解析，描述不冒充约束生成；不增加补丁教程。 |
| 完整 JSON Schema 和字符串句柄 | 保留真实校验及当前执行器身份，不为了外观一致改字段类型或丢约束。 |
| 外层预算和 110 秒 wait | 适配目标连接器；内层保留原值供 JS 处理，不复制逐工具 token 裁剪，见 ADR-003。 |
| Shell 单次覆盖、EOF/resize/terminate 和零等待 | 保留当前实际进程能力；配置默认值不是权限开关。 |
| 图片/文件原生 MCP 块、Skills 和 Web 问答 | ChatGPT 的文件、Skill 和用户消息交付不同于 Codex；明确输出方式，不假装有 notify 注入或共享文件环境。 |
| 资源的直接 URI 读取及聚合 errors | 支持模板/链接和可观察失败，不照搬“URI 只能来自资源列表”的限制性措辞。 |

同义处沿用上游，差异以实际环境为准；不为提示词一致性接入完整 App Server、审批流程或另一套执行器。

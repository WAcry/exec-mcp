# ADR-001 执行内核与产品边界

[English](001-exec-runtime.md) | 简体中文

当前生效，2026-09-22 更新。

## 选择原因

exec-mcp 供使用 ChatGPT 的开发者在自己的机器上部署。每个连接指向用户指定的一台远端机器，
工具中的“本机”指这台机器，与 ChatGPT 的其他容器相互独立。
编排 JS 没有直接文件和网络 API，Shell 及其他工具仍按机器的系统权限访问文件与网络。

接口参考 Codex，将组合调用和结果筛选交给 JavaScript。2026-09-22 的用户实测未观察到
固定的每轮工具调用次数上限，一轮可完成的工作受整体工作量约束。产品据此评估效率，
不假定固定次数，也不承诺宿主无限执行；宿主内部预算算法与阈值不属于本服务契约。

Agent 可以在一次 exec 中串行或并发调用多个工具，先整理结果，再把需要的部分交回模型。
合并往返和筛选结果可减少编排与重复上下文的 token 开销，独立操作并行可缩短等待，
让一轮对话完成更多实际工作。效果取决于任务和输出方式，仍需实测。

## 工具入口与执行顺序

顶层 MCP 只提供 exec、wait。本机操作与下游 MCP 均绑定为 exec 内的 tools.* 方法。
exec 描述包含本机完整契约，下游契约通过 ALL_TOOLS 按需展示，不保留隐藏的直接入口。
采用 Code Mode Only 是为了贴近目标 Codex 模型的交互方式，并统一处理输出。
PowerShell、嵌套模板和 Markdown 仍会增加字符串构造难度；描述简述多层语言的语法差异，
较长示例留在文档。字符串使用 JavaScript 原有语法，服务端不猜测或修复内容。

独立调用可以用 Promise.all 并发。存在数据依赖或副作用冲突时，按操作要求串行执行，
保留相应错误处理和重试条件。

本机执行方法包括 tools.exec_command、tools.write_stdin、tools.apply_patch 和 tools.view_image，
发现方式见 [ADR-002](002-tool-discovery.zh.md)。读取、搜索及 Git/worktree 操作使用系统工具，
由调用者安排执行，不另设项目或任务管理功能。

## 目录与补丁

exec.source 是 JavaScript，MCP 外层使用对象参数。exec.workdir 决定本次本机工具的默认目录，
省略时使用服务账户主目录，相对值也从主目录解析。本机工具中的相对路径基于本次目录。
命令可以单独指定目录，Shell 的 cd 只影响该进程；下游 MCP 的路径与参数保持原有语义。

tools.apply_patch 接收一个完整补丁字符串，经 stdin 进入固定引擎，避免命令行参数长度限制。
MCP 外层使用 source/workdir/files 对象，exec 内各方法保留自己的参数形状，不另建直接调用包装。

补丁沿用 Codex 的语法和引擎，工具描述提供完整语法。多文件补丁可能部分成功，
调用者需检查结果；当前不为 diff UI 额外生成快照或行统计。

## 组件与平台

TypeScript/Node 负责 MCP、配置、下游连接和平台适配。JavaScript 与补丁执行复用同一固定版本的
Codex 组件，MCP 使用官方 SDK。依赖范围不包含完整 Codex App Server 或模型循环，
服务也不读取机器上 Codex 的配置与数据库。组件升级通过显式依赖更新，并验证调用契约。
Codex 组件及协议的许可见 [Apache-2.0 原文](../../proto/LICENSE)，依赖自带的许可证与 NOTICE 保留。

Windows、Linux、macOS 都是产品目标，Windows 使用原生执行路径。
系统路径、Shell、PTY 和进程树由平台适配处理，安装位置也按系统选择。
实例默认 Shell 与单次覆盖见 [ADR-007](007-command-shell.zh.md)，执行器和默认说明共用解析结果。
各平台分别验证 host、补丁入口和进程清理；bash、POSIX 信号或 systemd 等能力仅用于适用的平台。
具体 OS/CPU 支持与版本 pin 以实现和对应发布的验证结果为准。

## 产品范围

已提供可选 Web 管理控制台，见 [ADR-009](009-web-console.zh.md)。控制台独立于 ChatGPT，
不提供内嵌 Widget 或下游登录交互。需要用户决定时，可以在原 ChatGPT 对话沟通，
或把问题异步提交到本会话 Web；回答与主动补充共用 User Note 通道，见 [ADR-010](010-session-notes.zh.md)。
问题立即提交返回，服务不同步等待用户，也没有答案轮询工具或答复数据库。

本机 Skill 只提供元数据发现，全文用现有 Shell 读取，见 [ADR-006](006-skill-catalog.zh.md)。
Skill 安装与执行管理、Workspace、子 Agent、持久任务及调度框架均不在当前范围内。
原生图片和音频可由输出助手显式发送；文件由 exec 编排，交付方式见 [ADR-005](005-file-transfer.zh.md)。

## 接受的代价

exec 描述包含本机完整契约，篇幅较长，但新 Agent 可以直接使用常用工具。
全部模型工具操作依赖原生 host，host 不可用时也无法执行命令或文件操作。
复用二进制减少了开发量，同时需要维护协议和版本兼容。旧 codex-mcp 的实现按功能选用，
取消、结果保真和连接机制仍需验证，旧项目的产品约束只在明确采纳后沿用。

## 参考源码

参考 Codex 快照 `8b78600dc85cc265d7e7e827f6aa903875405287`。
[补丁工具](https://github.com/openai/codex/blob/8b78600dc85cc265d7e7e827f6aa903875405287/codex-rs/core/src/tools/handlers/apply_patch_spec.rs)
采用 freeform，[Code Mode 契约转换](https://github.com/openai/codex/blob/8b78600dc85cc265d7e7e827f6aa903875405287/codex-rs/code-mode-protocol/src/description.rs)
将其映射为字符串参数。
[平台包装脚本](https://github.com/openai/codex/blob/8b78600dc85cc265d7e7e827f6aa903875405287/codex-cli/scripts/build_npm_package.py)
用于核对上游平台分发；exec-mcp 的跨平台支持仍需单独验证。运行版本由项目依赖显式固定。

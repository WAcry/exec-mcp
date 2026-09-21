# ADR-001：执行内核与产品边界

状态：生效。日期：2026-09-17。

## 为什么这样选

exec-mcp 面向使用 ChatGPT 的开发者，而不是只适用于某个人的一台 Linux 机器。
我们选择贴近 Codex 的调用习惯，同时把机械性的并发、筛选和组合留给代码。
这是面向目标模型的产品选择，不代表已经证明某种接口对所有模型都最优。

目标 ChatGPT 宿主每轮能够发出的外层 tool call 数量有限；具体上限可能随产品变化，
本决定不依赖某个固定数值。exec-mcp 因此把 `exec` 设计为组合入口：Agent 可以在一次外层
tool call 中串行或并发执行多个底层工具，并在 JavaScript 内先筛选、转换和聚合结果，
再只把需要的内容显式交回模型。这样能在有限的外层调用预算内完成更多实际工作，
并减少仅用于机械编排的模型往返。

## 决定

顶层 MCP 提供 `exec`、`wait` 及本机/发现工具：list_skills、import_file、export_file、
exec_command、write_stdin、apply_patch、view_image、tool_search、request_user_input_async。本机工具也保留在 exec 内；
下游工具继续通过 exec 绑定调用，不把整个下游目录注册成顶层工具。
直接调用不生成 JavaScript，不经过 V8；两种入口共用命令、补丁、文件和发现实现。
理由是 PowerShell 反引号、嵌套脚本模板和 Markdown 围栏反复撞上外层 JS 语法，
只追加转义提醒无法消除这层构造风险。单个命令/补丁本身也能批量工作，不能假定 exec 永远更省调用。
描述中只告知可用方式，不指定入口优先级，不改写用户正文或引入自创 raw literal 语法。

`exec` 仍是组合与结果处理入口。相互独立的调用可以用
`Promise.all` 并发；有数据依赖、顺序要求或副作用冲突的调用仍按语义串行，不能为了减少
外层调用次数而改变正确的执行顺序、错误处理或重试边界。

四个本机执行原语是 `tools.exec_command`、`tools.write_stdin`、
`tools.apply_patch`、`tools.view_image`。发现机制另见 [ADR-002](adr-002-tool-discovery.md)。
读取、搜索、Git 和 worktree 使用系统工具，不再为它们发明产品级生命周期。

`exec` 的 `source` 是 JavaScript，外层仍是 MCP 对象参数。
`exec.workdir` 决定本次执行中本机工具的默认目录：省略时为服务用户主目录，
相对值也以主目录解析；本机工具中的相对路径以本次目录解析。
exec 内 `tools.apply_patch` 继续接收单个完整补丁字符串；顶层 MCP 按对象 schema 接收 `{patch, workdir?}`。
顶层 cmd/patch 是原文字符串，只有 JSON 传输编码，不解释 JS 模板；补丁通过 stdin 进入相同的固定引擎。
顶层补丁的 workdir 及命令目录省略/相对时以服务用户主目录解析，不共享某次 exec 的隐式当前目录。
命令可以显式指定自己的目录；Shell 中的 `cd` 不会改变下一次工具调用的默认目录。
这些规则不改写下游 MCP 的路径、参数或配置。

保留 Codex patch 语法和执行引擎；工具契约必须包含足够的语法说明，不能只依赖模型记忆。
补丁可能部分成功，不承诺跨文件原子性。不再为 diff UI 额外生成快照和行统计。

采用 TypeScript/Node 承载 MCP、配置、下游连接和平台适配；
执行 JavaScript 和应用补丁复用同一明确固定版本的 Codex 组件。
使用官方 MCP SDK，不启动完整 Codex App Server 或模型循环，不读机器上 Codex 的配置与数据库。
升级版本是显式依赖更新，需要验证契约；不随系统 Codex 或某个源码 checkout 自动升级。

Windows、Linux、macOS 是正式产品目标，Windows 必须有原生执行路径，不以 WSL 冒充。
系统路径、Shell、PTY、子进程树与安装位置由平台适配处理；
实例配置提供 Shell 默认值，命令可单次覆盖且不影响后续调用；默认说明与执行共用同一解析结果，见 [ADR-007](adr-007-command-shell.md)。
不能把 `bash`、POSIX 信号、systemd 或某台机器的主目录写成共同前提。
发布必须验证各目标平台的 host、补丁入口和进程清理，不能只检查平台包“存在”。
具体 OS/CPU 支持矩阵与版本 pin 留在实现和发布事实中，不在 ADR 提前承诺。

可选独立 Web 管理控制台已交付，见 [ADR-009](adr-009-web-console.md)；不提供 ChatGPT 内嵌 Widget 或下游登录交互。
不实现同步等待用户、回答轮询工具、Skill 安装/执行管理，
也不增加 Workspace、子 Agent、持久任务或调度框架。
需要用户决定时可在原 ChatGPT 对话沟通，或异步提交到本会话 Web；不增加答复数据库或浏览器通知。
主动补充与异步问题的回答统一走现有 User Note 通道，见 [ADR-010](adr-010-session-notes.md)。
本机 Skill 仅提供元数据发现，全文用现有 Shell 读取，见 [ADR-006](adr-006-skill-catalog.md)；不改变执行内核。
原生图片/音频内容不属于 UI，仍可由显式输出助手发送。
文件既可直接导入/导出也可由 exec 编排，原生绑定和交付通道见 [ADR-005](adr-005-file-transfer.md)。

## 接受的代价

工具表面比两个顶层入口更大，但本机完整描述只放在各自工具，exec 不再镜像它们。
MCP 对象契约与 Code Mode 字符串补丁/附件索引有少量明确的参数适配，不能把它扩大成两套行为。
原生 host 仍是 exec 的依赖；其故障不应阻止直接命令、补丁或目录读取。
复用二进制减少重造成本，却仍有协议、包装方式和版本兼容成本；
旧 codex-mcp 已验证的取消、结果保真和连接机制可以选择性复用，旧产品约束不能整体继承。

## 事实依据

参考 Codex 快照 `8b78600dc85cc265d7e7e827f6aa903875405287`：
[补丁工具](https://github.com/openai/codex/blob/8b78600dc85cc265d7e7e827f6aa903875405287/codex-rs/core/src/tools/handlers/apply_patch_spec.rs)
是 freeform；[Code Mode 契约转换](https://github.com/openai/codex/blob/8b78600dc85cc265d7e7e827f6aa903875405287/codex-rs/code-mode-protocol/src/description.rs)
把 freeform 参数映射成字符串。
[平台包装脚本](https://github.com/openai/codex/blob/8b78600dc85cc265d7e7e827f6aa903875405287/codex-cli/scripts/build_npm_package.py)
可用于核对平台分发，但不构成 exec-mcp 已完成跨平台验证的证据。
这些是决策参考，不是对运行版本的隐式 pin。

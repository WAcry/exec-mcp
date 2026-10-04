# ADR-011 长期开发哲学

[English](011-development-philosophy.md) | 简体中文

当前生效，2026-10-04 采纳。

以下原则由用户明确采纳，用于功能取舍、实现和设计评审。它们补充 ADR-001 至 ADR-010，
原有决定继续生效，各主题的具体行为仍由对应 ADR 维护。本文记录长期判断，不是新功能规划。

## 项目宪法

> 做一个尽可能小而强的执行层，尽量顺着 Codex 后训练形成的模型习惯；相信用户和 Agent，只暴露真实、完整、必要的契约，不制造多余规则和系统，并用真实使用反馈决定哪些复杂度值得存在。

## 原则

1. **Keep it simple, but powerful。** 只有明显扩大 ChatGPT 实际工作能力、减少摩擦或提高可靠性的能力才值得加入。
   能用一个参数解决就不增加工具，能复用现有机制就不建设第二套系统。功能数量和架构完整性本身不是目标。
   请求轮询、持久任务框架、另一套 Agent runtime 或复杂权限体系，都需要足以承担其成本的具体收益。

2. **顺着 Codex 后训练形成的模型习惯。** 产品判断是：经过 Codex 风格工具使用后训练的模型，可以受益于熟悉的接口。
   工具形状、Code Mode、exec/wait、ALL_TOOLS、apply_patch、Skills、Prompt 和描述优先参考核对过的 Codex，并在真实使用中验证这一判断。
   复用固定版本的 host 和 patch engine，针对实际宿主或契约差异适配，而不直接接入完整 App Server。
   具体集成取舍由 [ADR-001](001-exec-runtime.zh.md) 和 [ADR-002](002-tool-discovery.zh.md) 维护。

3. **Code Mode First，工具表面尽可能小。** 顶层保持 exec/wait，本机操作和下游 MCP 方法都绑定在 exec 内。
   JavaScript 负责串行、并发、筛选、汇总和保存中间结果，减少往返与重复上下文。
   执行顺序仍须遵循数据依赖和副作用，见 [ADR-001](001-exec-runtime.zh.md)。

4. **ALL_TOOLS 属于当前 exec 环境。** 宿主分配的连接器名称不是关键。
   该连接的 exec.source 才拥有这台机器的 ALL_TOOLS 和 tools.*，包括下游 MCP 方法。
   外层宿主的 Code Mode 或连接器目录属于另一环境；描述须按 [ADR-002](002-tool-discovery.zh.md) 说清边界。

5. **相信最新模型选择工作方式的能力。** 描述环境、能力、参数和真实风险，而不规定每一步固定流程。
   需要时说明 JavaScript、Shell、PowerShell、Markdown 和正则的嵌套解析层，让模型自己选择字符串构造和转义方法。
   可恢复的小错误是这种自由可以接受的代价。描述要求由 [ADR-002](002-tool-discovery.zh.md) 维护。

6. **Tool Description 是核心产品接口。** 全新的 ChatGPT 会话第一次看到工具后，应能高置信度地正确调用，无需猜测。
   契约完整且真实，schema 与执行一致；内部历史和教程留在各自文档。
   英文模型契约便于沿用 Codex 同义原文，token 效率须结合实际模型与文本判断，见 [ADR-002](002-tool-discovery.zh.md)。

7. **避免无意义的负向 Prompt。** 某个 Agent 一次孤立、可恢复的错误，不足以成为永久禁止规则的理由。
   可预见的误用会造成严重后果时，才保留硬调用规则，例如破坏性删除使用已解析的绝对路径字面量，
   以及调用其他 Agent CLI 前须有明确授权。这些规则由 [ADR-004](004-connectivity-trust.zh.md) 维护。

8. **信任用户，也信任 Agent。** 个人实例继承运行账户权限和完整环境，包括凭据与代理。
   操作者选择可信、可恢复的环境，负责备份与隔离。系统账户权限、入口认证和外部授权继续构成边界，
   额外的路径沙箱、环境白名单或逐命令审批不在当前设计范围内。
   见 [ADR-004](004-connectivity-trust.zh.md) 和 [ADR-008](008-environment-and-proxy.zh.md)。

9. **ChatGPT 默认自己完成工作。** 即使 Codex、Claude Code 等 CLI 已安装并登录，也须用户明确要求才能调用，
   因为委派会消费另一套额度，并改变执行主体。Code Mode host 和 patch engine 只是本地执行组件，
   不属于委派给另一 Agent。区别由 [ADR-004](004-connectivity-trust.zh.md) 维护。

10. **异步人机沟通优于阻塞和轮询。** 提问与 Agent 消息提交后立即返回，操作者也可在对话的 Web 界面主动补充。
    回答与补充随正常 exec/wait 响应返回。沿用这一共同通道，而不增加答案轮询或等待真人数分钟的调用。
    沟通能力及宿主限制见 [ADR-010](010-session-notes.zh.md)。

11. **Web UI 是操作员控制台。** 围绕对话组织调用、子操作、问题、消息以及关联进程和文件。
    它负责观察、沟通和运行时管理，模型推理仍在 ChatGPT。
    职责边界与 conversation-first 界面由 [ADR-009](009-web-console.zh.md) 维护。

12. **真实状态比漂亮但虚假的状态更重要。** Script completed 只表示 JavaScript 完成，Shell 成功仍须看其结果。
    退出码为零不代表没有 stderr。补充已附入响应，不代表 ChatGPT 已读。
    Agent 消息的已读状态属于 Web 操作者，绝不转成模型指令。
    这些含义按 [ADR-003](003-results-lifecycle.zh.md) 和 [ADR-010](010-session-notes.zh.md) 分别维护。

13. **避免重复数据和重复上下文。** 只删除可以证明等价的 structuredContent/文本镜像，保留独立信息。
    由 JavaScript 选择给模型的输出，大型中间数据可以用 store/load 或显式文件保存。
    目的是把上下文留给有价值的推理，结果保真按 [ADR-003](003-results-lifecycle.zh.md) 执行。

14. **资源限制要宽松、简单。** 对内存、审计和终端日志设界限，防止服务长期运行时无限增长。
    优先采用宽松压力阈值和较长空闲保留期，而不追求精确的逐任务配额。用户生成的项目文件由操作者管理。
    精确阈值是实现默认值，不是永久宪法常量；查阅 [ADR-003](003-results-lifecycle.zh.md)、
    [ADR-009](009-web-console.zh.md)及[配置指南](../guides/configuration.zh.md#容量与临时状态)。

15. **失败时避免重放不确定的副作用。** 超时、断连或结果交付失败，不能证明操作从未发生。
    恢复后先观察实际状态，由 Agent 决定如何继续。只有可以确认请求未送达时才适合自动重发，
    具体按 [ADR-002](002-tool-discovery.zh.md) 执行；执行取消与恢复按 [ADR-003](003-results-lifecycle.zh.md) 执行。

16. **跨平台是正式产品要求。** Windows、Linux、macOS 都要通过真实执行和安装验证。
    进程、Shell、PTY 和安装改动须通过三平台 CI 与受支持的 Node 版本矩阵，当前为 20/22/24。
    各平台证据分别报告，不从 Linux 推断 Windows 行为。原生 Shell 默认规则见 [ADR-007](007-command-shell.zh.md)。

17. **文档记录代码看不出来的决定。** README 面向用户，ADR 保留理由、约束和接受的代价，AGENTS 提供开发规则与阅读入口。
    实现事实直接读代码、测试、schema 和锁文件，普通功能不另写重复的规划 Spec 或逐文件施工图。
    当前决定原地维护，Git 保存历史。文档分工由 [AGENTS](../../AGENTS.zh.md) 维护。

18. **公开文档双语，模型契约英语。** 同步维护 .md/.zh.md 配对文档，以及英语和简体中文 Web 界面文案。
    用户内容、原始日志与诊断、Skill 正文、标识符和第三方契约保留原文。
    语言边界由 [AGENTS](../../AGENTS.zh.md) 和 [ADR-002](002-tool-discovery.zh.md) 维护。

19. **Dogfood 优先，实测可以推翻假设。** 真实 ChatGPT 行为可以改变最初设计判断。
    工作量假设、content/structuredContent 消费方式、嵌套目录边界、发现需求和以对话为核心的界面，都应在真实使用中验证。
    在相关决定中记录已证明的行为及其限制，不把一次观察变成宿主普遍保证。
    复杂度凭实际收益获得位置，而不是凭初稿的权威。

20. **版本和任务范围都须有意决定。** 用户没有明确要求时保持当前版本。
    解决获授权的问题，不顺手扩大重构、新建体系、发布或部署。
    推送、发布、部署和重启现有服务仍分别遵循 [AGENTS](../../AGENTS.zh.md)
    与 [ADR-004](004-connectivity-trust.zh.md) 的授权边界。

判断新功能时，先说明具体收益、现有机制能提供它的最小方式，以及新增复杂度值得保留的证据。
选择改变时更新对应主题 ADR；更新开发哲学本身不授权实现延期功能。

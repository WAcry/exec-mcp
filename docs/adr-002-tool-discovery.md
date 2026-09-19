# ADR-002：工具发现与契约

状态：生效。日期：2026-09-17。

## 为什么不是二选一

`ALL_TOOLS.filter(...)` 适合已知关键词、名称和目录浏览，但字符串过滤不等于 BM25。
只保留过滤会把检索质量和排序算法都交给每一段临时代码；
只保留旧式 search/call 又多出不透明 `tool_id` 和第二套调用入口。
我们保留一个目录、一种实际调用方式，让筛选和检索各做适合的工作。

## 决定

**本实例启用的全部本机工具完整契约放进 `exec` 描述。**
另外在同一描述中给出简短的内部发现函数 `tools.tool_search` 契约。
它按 query 做本地 BM25 检索，返回命中的精确方法名和完整调用契约，不是顶层 MCP 工具。
名称参考 Codex 的 `tool_search`，不再提供 `mcp_tool_search` 别名。
不提供 `mcp_tool_call`；下游工具统一通过 `tools.mcp__...(...)` 或 `tools[name](args)` 调用。

`ALL_TOOLS` 保持 Codex 的普通数组形状 `{name, description}[]`，
表示本次 exec 已绑定的工具契约，不是对远端持续在线的保证。
本机工具、内部发现函数和启动时发现的所有启用下游工具都在其中；条目描述给出完整调用契约。
精确读取用 `find`，列出和筛选用普通 JavaScript，不额外添加 read/call 目录 API。

**不把本机工具从 ALL_TOOLS 删除。** 数组留在运行时不会自动占用模型上下文，
只有 Agent 输出条目时才进入上下文。保留完整目录能避免“ALL 不包含全部可调用方法”的例外。
为避免重复，`exec` 不自动打印目录；目录条目和预载契约由同一份定义生成。

### 搜索与目录使用相同的候选集合

tools.tool_search 搜索本次 ALL_TOOLS 中的全部条目：本机、文件、Skill、搜索函数自身和下游工具。一次 exec 内搜索只使用其绑定快照，不能因服务端目录刷新而返回尚未绑定的新名称。
结果的名称、完整 description 与 ALL_TOOLS 对应条目一致；精确可调用名优先于其他服务的同名原始名称。
Web 检索探针使用当前完整目录，与新 exec 相同；下游服务/工具列表页面仍只列下游。

不删除 BM25，不增加 scope 参数、查询别名或第二套 call API。只让 Agent 记住同一个目录，
比解释“ALL 包含但 search 不搜索”的例外简单；按需建立的是本地索引，不是按需加载/连接工具。
搜索仍是词项匹配，不是 embedding；结果数量受 limit 限制，不承诺任何同义表达都命中。

固定 Codex 的 tool_search 针对 deferred tools，目的是为下一次模型调用展示工具；其 Code Mode 同时保留 ALL_TOOLS。
我们有意不照搬这个发现范围：本项目启动已加载完整下游，只有 exec/wait 两个顶层入口，
统一搜索候选与已绑定工具更适合这一结构。保留 Codex 的名称、query/limit、BM25 和直接工具调用形式。

### 运行时目录与 ChatGPT 已导入元数据是不同层

代码生成的 exec 描述和原生绑定共用同一契约；ChatGPT 连接可以仍保留部署前的工具元数据。
只开新对话不代替连接的元数据刷新。排查时比较服务实际 tools/list、当前 ALL_TOOLS 和宿主显示的描述，
不把宿主旧描述推断成运行时工具由 ChatGPT 注入。升级/重启并刷新连接是操作者动作，不在每次结果里重发全套 schema。
新增本机工具时，测试须同时核对顶层完整契约、ALL_TOOLS、搜索及实际调用，不只核对静态工具名列表。

## 启动完整加载，按需向模型展示

`serve` 启动时并行连接所有启用的下游，完成协议协商、凭据检查、全部 tools/list 分页和输入契约校验，
然后才启动 MCP、下载入口和 Web UI 并报告就绪。任何启用服务的连接、鉴权、目录或 schema 失败都使本次启动失败，
关闭已启动的下游与本机资源；不以部分目录继续启动。故意不使用的服务由用户显式 enabled=false。
启动验证不会实际执行 tools/call：工具本身可能有写入、副作用或额外权限，不能以“全面检查”为理由擅自试调用。

这不等于把所有 schema 输出给 ChatGPT。完整目录留在服务和 V8 内，顶层描述只保留本机契约和精简的发现说明。
已知精确名称和参数的 Agent（例如有 Skill 指导）可以在第一次 exec 直接调用；tool_search 只是本地 BM25 查询，
不是加载、鉴权、连接或解锁工具的前置步骤。搜索和调用已绑定工具可在同一个脚本中完成。

单个下游的 startup_timeout_sec 覆盖连接、协议协商和所有目录页，而不是每一页重新计时；
默认 30 秒，启动不是 ChatGPT connector 调用，不继承 110 秒等待上限。超时可由用户在配置中放宽。
SIGINT/SIGTERM 可取消整个启动并清理已创建的客户端；不输出“已就绪”后才等待失败。

鉴权在操作者终端侧准备：stdio 继承完整环境与供应商已有登录状态，stderr 原样进入终端而 stdout 保持协议专用；
HTTP 使用配置中的 headers。缺失/过期凭据或需要用户输入时明确失败，由用户在本机登录、修正凭据后重启。
不在 ChatGPT 工具调用中打开 Widget、elicitation、sampling 或登录弹窗；当前不实现通用 OAuth 客户端登录/刷新器。
这与为 ChatGPT 接入本服务配置的 Auth0/OAuth 是相反方向的两条认证链，不能混为一谈。

一次 exec 的 tools 和 ALL_TOOLS 仍使用相同快照。目录变更通知自动刷新缓存，更新只影响之后创建的 exec，
不修改正在运行的 V8。断连保留最后验证的绑定以便已知方法仍能发起连接准备；实际发送前必须重新核对当前契约，
工具移除、变更或无法核对时拒绝发送，不因旧快照绕过撤销。查询只报告连接/目录错误，不要求先搜才能恢复。
已经发送的工具调用失败不自动重试，因为副作用可能已发生。启动成功也不能保证远端不会后来掉线、撤权或要求 step-up 登录。

工具名称稳定且无歧义，禁止规范化碰撞后静默覆盖。用户显式 enabled_tools 是目录选择，不是权限审批；
未配置时加载全部工具，配置了不存在的工具名则启动失败，避免拼写错误造成静默缺失。
[MCP tools/list](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#listing-tools) 返回分页契约，
没有可假定通用的逐工具 schema/read RPC。目录与 V8 快照仍遵守 [ADR-003](adr-003-results-lifecycle.md) 的传输边界。

## 中文与自包含

本项目编写或生成的工具标题、说明、参数解释和错误指引全部使用中文。
第三方原始描述、schema、机器字段及枚举作为来源数据保留；不靠运行时翻译模型重写外部契约。
中文发现说明与上游原文必须区分，不能把改变语义的“翻译”当成兼容层。

从一个工具条目应能确定参数形状、必填项、返回值、错误语义以及必要的副作用注意事项。
普通 MCP 工具接收对象，补丁接收字符串；不为了整齐把所有返回值包成同一种 envelope。
下游完整 schema 要保留，不能只用有损 TypeScript 摘要替代约束。
工具绑定与校验使用同一契约；Code Mode host 不替应用层完成输入校验。

通用运行规则只在 `exec` 说明中讲一次：默认目录、显式输出、等待与终止、发现方式和异常处理。
具体工具只补充自身规则；首次使用者不能被要求先读项目 README 或猜测同名工具参数。
检索规则沿用可解释的 BM25，支持标识符和中文词项；不用 embedding 服务，也不要求 Agent 自写排序。
实际工具说明从可执行定义生成，不在 ADR 维护另一份完整提示词或 schema。

## 工具说明写给第一次使用它的 Agent

优先描述当前能做什么、参数与默认值、结果怎样使用，以及会改变调用正确性的语义。
设计讨论中的“不要做某事”不是自动追加的提示词；旧项目的参数、未实现的功能、内部回收或压缩算法，
留在相应 ADR/README。只有自然调用容易踩到且 schema/返回值未说明的区别，才值得额外提醒。
例如隔离 JS 与实际机器的边界、未 await 的调用被丢弃、cell_id 与终端 session_id 的区别、
待输出媒体和自动交付的文件链接，均会直接影响调用；“补丁不要传旧对象”则由字符串契约已经消除歧义。

对照固定 Codex rust-v0.155.1 的 [Code Mode 契约](https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/code-mode-protocol/src/description.rs)、
[命令定义](https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/core/src/tools/handlers/shell_spec.rs)、
[补丁定义](https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/core/src/tools/handlers/apply_patch_spec.rs)、
[图片定义](https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/core/src/tools/handlers/view_image_spec.rs)、
[检索定义](https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/core/src/tools/handlers/tool_search_spec.rs) 和基础提示词，
保留共同的工具形状与关键语义，采用中文正向表达。可借鉴上游对工具编排、异步生命周期、媒体参数和 wait 增量结果的说明，
不整体复制其 system prompt、审批/沙箱工作流、未接入的 helper 或不同的预算默认值。
Codex 的隔离 V8 没有直接网络/文件 API，不意味着工具所在机器离线；本项目明确外部访问通过 tools.* 执行。

工具说明不重复具体 Skill 路径压缩与字符预算：常规调用只需要名称/用途/全文路径，
发生压缩时由那份返回目录给出路径前缀的还原方式和省略标记。显式调用策略仍在目录中保留。
完整 schema 继续作为参数/结果事实来源，不为省文字丢字段，也不以模型“足够聪明”为理由省略会改变正确用法的区别。

## 与 Codex 对齐到哪里

参考快照 `8b78600dc85cc265d7e7e827f6aa903875405287` 中，
[ALL_TOOLS](https://github.com/openai/codex/blob/8b78600dc85cc265d7e7e827f6aa903875405287/codex-rs/code-mode-runtime/src/runtime/globals.rs)
本身只有 name/description；[契约增强](https://github.com/openai/codex/blob/8b78600dc85cc265d7e7e827f6aa903875405287/codex-rs/code-mode-protocol/src/description.rs)
由集成层把调用声明加进 description，并非独立 host 自动补齐。
[tool_search](https://github.com/openai/codex/blob/8b78600dc85cc265d7e7e827f6aa903875405287/codex-rs/core/src/tools/handlers/tool_search_spec.rs)
采用 BM25，并使匹配工具在后续模型调用可见。
本项目复用目录、检索和直接调用形状，但有意改为启动时完成下游加载，免去冷启动发现的额外 exec 往返。
代价是服务启动更慢，启用的故障下游会阻止就绪；换来第一轮已知工具可调用且问题在用户终端尽早暴露。
不修改固定 host，不伪造动态 JavaScript 绑定，不维持第二套 call API。

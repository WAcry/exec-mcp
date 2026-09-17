# ADR-002：工具发现与契约

状态：生效。日期：2026-09-17。

## 为什么不是二选一

`ALL_TOOLS.filter(...)` 适合已知关键词、名称和目录浏览，但字符串过滤不等于 BM25。
只保留过滤会把检索质量和排序算法都交给每一段临时代码；
只保留旧式 search/call 又多出不透明 `tool_id` 和第二套调用入口。
我们保留一个目录、一种实际调用方式，让筛选和检索各做适合的工作。

## 决定

**本机四个执行工具的完整契约放进 `exec` 描述。**
另外在同一描述中给出简短的内部发现函数 `tools.tool_search` 契约。
它按 query 做本地 BM25 检索，返回命中的精确方法名和完整调用契约，不是顶层 MCP 工具。
名称参考 Codex 的 `tool_search`，不再提供 `mcp_tool_search` 别名。
不提供 `mcp_tool_call`；下游工具统一通过 `tools.mcp__...(...)` 或 `tools[name](args)` 调用。

`ALL_TOOLS` 保持 Codex 的普通数组形状 `{name, description}[]`，
表示本次 exec 已绑定的可调用工具，而不是一份声称所有远端都在线的清单。
本机工具、内部发现函数和已经发现的下游工具都在其中；条目描述要能给出完整调用契约。
精确读取用 `find`，列出和筛选用普通 JavaScript，不额外添加 read/call 目录 API。

**不把本机工具从 ALL_TOOLS 删除。** 数组留在运行时不会自动占用模型上下文，
只有 Agent 输出条目时才进入上下文。保留完整目录能避免“ALL 不包含全部可调用方法”的例外。
为避免重复，`exec` 不自动打印目录；目录条目和预载契约由同一份定义生成。

## 按需发现与快照

启动服务和 MCP `tools/list` 不连接所有下游，也不把下游全量 schema 塞入 `exec` 描述。
首次需要外部能力时，由 `tools.tool_search` 触发目录发现；随后复用连接和缓存，
目录变化才更新契约与索引。本机命令不能被无关下游的离线状态拖住。

一次 exec 的 `tools` 和 `ALL_TOOLS` 使用同一目录快照。
搜索可以更新服务端缓存，但不修改正在运行的 V8 绑定：**新发现的方法从下一次 exec 可用。**
搜索结果必须直说这一点；不要让 Agent 在同一脚本里搜索后调用一个尚未绑定的方法。
已在快照中的工具则可在同一脚本里筛选、选择和调用。

完整目录可在发现后用于普通代码过滤，不为了控制 prompt 大小再维护一套会话级“解锁工具”状态。
名称必须稳定、无歧义；禁止规范化碰撞后静默覆盖或把旧名称指向不同服务。
撤销或断连不会因为旧快照而继续获得权限；不能保证原契约时拒绝发送调用，重新发现。
发现失败应报告相关服务错误，不能伪装成“没有匹配工具”。

这里的“按需”有明确边界：[MCP tools/list](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#listing-tools)
通常一次返回该页工具及完整 schema，并没有可假定通用的逐工具 schema/read RPC。
我们推迟下游发现、缓存原始目录、按需向模型展示，而不声称从网络上永远只取命中的 schema。
目录缓存和 V8 目录仍有资源成本，须服从 [ADR-003](adr-003-results-lifecycle.md) 的真实传输边界。

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

## 与 Codex 对齐到哪里

参考快照 `8b78600dc85cc265d7e7e827f6aa903875405287` 中，
[ALL_TOOLS](https://github.com/openai/codex/blob/8b78600dc85cc265d7e7e827f6aa903875405287/codex-rs/code-mode-runtime/src/runtime/globals.rs)
本身只有 name/description；[契约增强](https://github.com/openai/codex/blob/8b78600dc85cc265d7e7e827f6aa903875405287/codex-rs/code-mode-protocol/src/description.rs)
由集成层把调用声明加进 description，并非独立 host 自动补齐。
[tool_search](https://github.com/openai/codex/blob/8b78600dc85cc265d7e7e827f6aa903875405287/codex-rs/core/src/tools/handlers/tool_search_spec.rs)
采用 BM25，并使匹配工具在后续模型调用可见。
本项目借用这些行为，但把发现放进 exec 内，不复制 Codex 的模型 API 特殊工具类型。

代价是冷启动发现多一次 exec 往返；换来不加载全部外部契约的起步体验，
并避免修改固定 host、伪造动态 JavaScript 绑定或维持第二套 call API。

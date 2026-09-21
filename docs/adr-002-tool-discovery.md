# ADR-002：工具发现与契约

状态：生效。更新：2026-09-21。

## 一个目录，一种下游调用方式

本项目启动时已经连接并验证完整下游目录，工具不是搜索后才获得执行资格。
采用 Codex Code Mode 的 ALL_TOOLS 与 tools[name](args)：模型可在 JS 中按名称、描述筛选，
只输出需要阅读的完整契约，再按该契约调用。已知名称与参数时无发现前置步骤。
移除顶层及嵌套 tool_search、其 BM25 索引与依赖；不保留别名、隐藏工具或第二套 search/call API。
普通字符串筛选不提供 BM25 相关性排名或同义词召回；接受这一代价，换取单一可见目录和更小的工具表面。

## 决定

**只有 exec/wait 暴露到顶层；本机工具的完整契约在 exec 描述中一次性展开。**
契约、schema、ALL_TOOLS 条目与 tools.* 参数校验共用可执行定义，避免手写镜像漂移。
下游工具统一通过 `tools.mcp__...(...)` 或 `tools[name](args)` 调用，不另外生成不透明 tool_id 交给模型。

`ALL_TOOLS` 保持 Codex 的普通数组形状 `{name, description}[]`，
表示本次 exec 已绑定的工具契约，不是对远端持续在线的保证。
本机工具和启动时发现的所有启用下游工具都在其中；条目描述给出完整调用契约。
精确读取用 `find`，列出和筛选用普通 JavaScript，不额外添加 read/call 目录 API。

**不把本机工具从 ALL_TOOLS 删除。** 数组留在运行时不会自动占用模型上下文，
只有 Agent 输出条目时才进入上下文。保留完整目录能避免“ALL 不包含全部可调用方法”的例外。
为避免重复，`exec` 不自动打印目录；完整条目留在 V8，仅在显式 text 返回时进入模型上下文。
目录条目和 exec 内本机章节由同一份定义生成；文件通过 exec.files 在 MCP 边界绑定。
exec/wait 不在可嵌套目录内，不引入递归执行或另一套等待语义。

Web 下游页面直接筛选已经取得的目录并展示完整契约，不调用模型工具、不保留 BM25 检索探针。
目录查询不连接、执行或解锁工具；仍可查看配置和实际连接/目录错误。

### 运行时目录与 ChatGPT 已导入元数据是不同层

代码生成的 exec 描述和原生绑定共用同一契约；ChatGPT 连接可以仍保留部署前的工具元数据。
只开新对话不代替连接的元数据刷新。排查时比较服务实际 tools/list、当前 ALL_TOOLS 和宿主显示的描述，
不把宿主旧描述推断成运行时工具由 ChatGPT 注入。升级/重启并刷新连接是操作者动作，不在每次结果里重发全套 schema。
新增本机工具时，测试须同时核对 exec 完整契约、ALL_TOOLS 和实际嵌套调用，不只核对静态工具名列表。

## 启动完整加载，按需向模型展示

`serve` 启动时并行连接所有启用的下游，完成协议协商、凭据检查、全部 tools/list 分页和输入契约校验，
然后才启动 MCP、下载入口和 Web UI 并报告就绪。任何启用服务的连接、鉴权、目录或 schema 失败都使本次启动失败，
关闭已启动的下游与本机资源；不以部分目录继续启动。故意不使用的服务由用户显式 enabled=false。
启动验证不会实际执行 tools/call：工具本身可能有写入、副作用或额外权限，不能以“全面检查”为理由擅自试调用。

这不等于把所有下游 schema 输出给 ChatGPT。完整目录留在服务和 V8 内，仅本机契约预先在 exec 展开。
已知精确名称和参数的 Agent（例如有 Skill 指导）可以在第一次 exec 直接调用；
按需展示不等于延迟加载、鉴权或连接。JS 筛选和调用使用本次 exec 的同一个快照。

单个下游的 startup_timeout_sec 覆盖连接、协议协商和所有目录页，而不是每一页重新计时；
默认 30 秒，启动不是 ChatGPT connector 调用，不继承 110 秒等待上限。超时可由用户在配置中放宽。
SIGINT/SIGTERM 可取消整个启动并清理已创建的客户端；不输出“已就绪”后才等待失败。

鉴权在操作者终端侧准备：stdio 继承完整环境与供应商已有登录状态，stderr 原样进入终端而 stdout 保持协议专用；
HTTP 使用配置中的 headers。缺失/过期凭据或需要用户输入时明确失败，由用户在本机登录、修正凭据后重启。
不在 ChatGPT 工具调用中打开 Widget、elicitation、sampling 或登录弹窗；当前不实现通用 OAuth 客户端登录/刷新器。
这与为 ChatGPT 接入本服务配置的 Auth0/OAuth 是相反方向的两条认证链，不能混为一谈。

一次 exec 的 tools 和 ALL_TOOLS 仍使用相同快照。目录变更通知自动刷新缓存，更新只影响之后创建的 exec，
不修改正在运行的 V8。断连保留最后验证的绑定以便已知方法仍能发起连接准备；实际发送前必须重新核对当前契约，
工具移除、变更或无法核对时拒绝发送，不因旧快照绕过撤销；已知工具的调用可以准备新连接，不要求先浏览目录才能恢复。
已经发送的工具调用失败不自动重试，因为副作用可能已发生。启动成功也不能保证远端不会后来掉线、撤权或要求 step-up 登录。

工具名称稳定且无歧义，禁止规范化碰撞后静默覆盖。用户显式 enabled_tools 是目录选择，不是权限审批；
未配置时加载全部工具，配置了不存在的工具名则启动失败，避免拼写错误造成静默缺失。
[MCP tools/list](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#listing-tools) 返回分页契约，
没有可假定通用的逐工具 schema/read RPC。目录与 V8 快照仍遵守 [ADR-003](adr-003-results-lifecycle.md) 的传输边界。

## MCP 资源是独立的协议能力

ALL_TOOLS 只描述 tools/call 可调用方法及本机辅助方法，不能替代 resources/list、resources/templates/list
和 resources/read；已接入的服务可能只提供文档或参数化资源，工具结果也可能提供不在资源列表里的 resource_link。
增加 Codex 同名的三个 exec 内辅助方法，而不是工具搜索、通用 HTTP 下载器或宿主 resources/read 代理。
本机契约照常在 exec 展开，顶层保持 exec/wait；共用已配置下游的 SDK Client、凭据、代理、超时与取消生命周期。

参考固定 rust-v0.155.1 及 `ebc05da3bdb76f25861e7cb418bd06d28cadc609` 的
[资源定义](https://github.com/openai/codex/blob/ebc05da3bdb76f25861e7cb418bd06d28cadc609/codex-rs/core/src/tools/handlers/mcp_resource_spec.rs)
和对应 handlers：列表可选 server/cursor，指定服务取单页，省略服务汇总全目录；读取必须指定 server/uri。
保留资源和模板的原始元数据，并给每项附准确的 server；游标和 URI 是下游标识，原样传送，不 trim、解码或映射成本机路径。
已知 URI（列表、模板展开或资源链接）可直接读取，不要求先列目录，不增加 URI 白名单或独立授权层。
不照搬上游“URI 必须来自资源列表”的限制性描述：参数化和未列出的链接也是有效来源。

聚合列表逐服务并行；单服务分页使用一个总期限，重复游标、页数不收敛或过大明确报错。
聚合保留成功服务及 errors，不把故障伪装成空目录或默默交付不完整的单服务列表。
无 resources 能力是合法状态：列出为空，读取则明确不支持，不发送无效 RPC。
沿用现有传输边界，并将三个方法按大型下游结果计入原有并发预算；不过早按模型 token 预算裁剪。
SDK 的自动汇总会让指定 server 的首页失去 nextCursor，因此单页使用官方 SDK 的 request，
聚合自行处理有界分页；读取使用 readResource 的 cacheMode=bypass。两者不保留资源正文缓存。

启动仍验证连接和工具目录，不预拉资源目录或正文；资源可能很大且动态，按需查询不等于延迟建立连接。
enabled_tools 只选择工具，不限制资源；服务级停用仍由配置过滤。故障后由下一次独立请求恢复连接，不重放当前请求。
读取返回 {server,uri,contents}，文本和 Base64 保留原值，由 Agent 显式输出；不自动下载、执行或渲染资源中的内容。
与本实例 export_file 的资源交付分开，不重新暴露本机资源读取工具；也不增加订阅、模板补全、资源 UI 或另一套缓存产品。
Web 用现有子调用审计显示参数和结果，外层 exec/wait 照常附带用户补充。

## 中文与自包含

本项目编写或生成的工具标题、说明、参数解释和错误指引全部使用中文。
第三方原始描述、schema、机器字段及枚举作为来源数据保留；不靠运行时翻译模型重写外部契约。
中文发现说明与上游原文必须区分，不能把改变语义的“翻译”当成兼容层。

从一个工具条目应能确定参数形状、必填项、返回值、错误语义以及必要的副作用注意事项。
顶层 MCP 输入都是对象；exec 内补丁接收字符串，其他工具接收对象。
宿主在 exec.files 绑定附件，import_file 用零基 index 选择；文件内容与下载凭据不进入 V8。
不为了整齐把所有返回值包成同一种 envelope。
exec 内本机结构化函数直接返回对象，图片函数保留 CallToolResult；不要求本机原始对象具有 structuredContent。
显式 text/image/audio 决定向模型展示的内容；用户补充仅附于外层 exec/wait，不改变嵌套原值，见 [ADR-010](adr-010-session-notes.md)。
下游完整 schema 要保留，不能只用有损 TypeScript 摘要替代约束。
工具绑定与校验使用同一契约；Code Mode host 不替应用层完成输入校验。

Code Mode 运行规则只在 exec 讲：JS 环境、显式输出、store/load、等待与发现。
本机章节分别提供完整参数、返回值和必要语义；首次调用不要求先读 README 或再从 ALL_TOOLS 发现本机契约。
筛选使用标准 JavaScript，不增加 embedding 服务、目录 DSL 或特殊宿主 helper。
实际工具说明从可执行定义生成，不在 ADR 维护另一份完整提示词或 schema。

## 工具说明写给第一次使用它的 Agent

优先描述当前能做什么、参数与默认值、结果怎样使用，以及会改变调用正确性的语义。
设计讨论中的“不要做某事”不是自动追加的提示词；旧项目的参数、未实现的功能、内部回收或压缩算法，
留在相应 ADR/README。只有自然调用容易踩到且 schema/返回值未说明的区别，才值得额外提醒。
例如隔离 JS 与实际机器的边界、未 await 的调用被丢弃、cell_id 与终端 session_id 的区别、
待输出媒体和自动交付的文件链接，均会直接影响调用；旧入口的参数形状不写成当前提示中的历史禁令。
嵌套字符串只简要提醒多层语法、参数边界和文本保真风险，不在工具描述中指定模板字面量、String.raw、
占位符或转义算法；调用方根据目标语言选择构造方式。文档中的经过测试示例是用法演示，不是必须遵循的写法。

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

核对 `rust-v0.155.1` 及 2026-09-21 的 main 快照 `f747d23d4bc8a167207fb1c411e221022391fdbb`：
[Code Mode 说明](https://github.com/openai/codex/blob/f747d23d4bc8a167207fb1c411e221022391fdbb/codex-rs/code-mode-protocol/src/description.rs)
明确要求通过 ALL_TOOLS 的 name/description 筛选未在提示中展开、但已在 tools 绑定的工具。
该数组本身只有 name/description；集成层负责把调用声明与 schema 加入描述，并非独立 host 自动补齐。
[工具组装](https://github.com/openai/codex/blob/f747d23d4bc8a167207fb1c411e221022391fdbb/codex-rs/core/src/tools/spec_plan.rs)
仍保留 tool_search，取决于模型 supports_search_tool、供应商 namespace 能力及是否有可搜索的 deferred 工具；
其用途是为后续模型调用暴露匹配工具，不能把某次使用中未出现搜索推断成 Codex 全面删除了搜索。
[模型元数据](https://github.com/openai/codex/blob/f747d23d4bc8a167207fb1c411e221022391fdbb/codex-rs/models-manager/models.json)
中 GPT-6 Astra 和 GPT-5.6 系列指定 code_mode_only；组装器在该模式隐藏普通顶层工具，
且 ToolSearch 类型不绑定为嵌套方法。因此此路径使用 ALL_TOOLS 并非仅靠提示偏好。
本项目只采用适合自身的 Code Mode 目录路径，不照搬 deferred-tool 展示机制，也不推断某个账户的模型能力标记。
进一步核对 2026-09-21 的 `ebc05da3bdb76f25861e7cb418bd06d28cadc609` 后，统一采用 Code Mode Only。
以其 Code Mode 描述、shell/patch 定义和基础提示词作为语义参考；保留中文、MCP source 对象参数、
宿主文件绑定、110 秒外层 wait、用户补充和有界输出这些 ChatGPT 适配。
本服务不实现上游模型循环、权限审批、notify 注入或暂停审批计时，不把未接入的能力写入描述。
内层输出默认不复制上游的每工具 token 裁剪，因为脚本仍需筛选原始值；由外层统一约束模型输出。
不改变已有 close_stdin、PTY resize、terminate、零等待能力，它们服务进程交互与清理，而不是另一套编排入口。
固定的 host/patch 版本不因此升级。启动时完成下游加载免去冷启动发现的额外 exec 往返。
代价是服务启动更慢，启用的故障下游会阻止就绪；换来第一轮已知工具可调用且问题在用户终端尽早暴露。
不修改固定 host，不伪造动态 JavaScript 绑定，不维持第二套 call API。

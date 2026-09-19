# ADR-010：Web 异步问答与对话答复事件

状态：生效。日期：2026-09-19。

## 保存问题，不暂停 Agent

参考固定 Codex rust-v0.155.1 的
[request_user_input_async](https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/core/src/tools/handlers/request_user_input_async.rs)：
保留 questions/title/options（字符串数组）的简单形状，提交后立即返回。
在本项目中它是 exec 内的工具，不是第三个顶层工具；await 等待本机保存成功，不等待人作答。
不实现同步 request_user_input、Terminal 问答、MCP elicitation、ChatGPT Widget 或第二套 Agent。

工具增加 request_key 以便同一对话的相同提交可去重；同键改题报冲突。
服务为不可变问题和选项分配稳定的位置 ID，不依赖显示文本匹配答案，也不要求 Agent 再维护一套 ID。
首选项仅标记推荐，不预先选中；用户可逐题选择并附加 notes，或使用界面提供的自定义回答。
notes 原样保存，是决定的一部分。关闭页面不算回答，不自动提交推荐项或超时默认选择。

## 对话关联与人机沟通，不是权限审批

问题与答复绑定 ChatGPT 提供的 `_meta["openai/session"]` 的摘要，沿用原生 session 的逻辑对话关联，
但数据独立于 MCP 连接、原生 host session、exec cell、终端、工作目录和临时审计。
缺失对话标识时拒绝创建/查询/确认，不降级成实例全局问题箱；Web 是单操作者管理界面，可查看各对话摘要。

Web 必须已成功监听才接受新问题，不能仅凭配置 enabled=true 宣称可回答。Web 关闭不删除已有问答。
操作者通过既有 Web 同源、认证和请求标记边界作答；这不是“只有真人才能批准”的安全证明，
因为受信任 Agent 本就拥有本机执行权限。它不扩大或缩小命令权限，也不为普通命令增加审批门槛。

提问后可继续无关工作；依赖答案的操作，应先让答复回到模型，再由模型决定新操作。
不通过一个布尔“已回答”就在旧脚本里执行预先写死的方案。已运行脚本不会被答复自动改写，副作用不会撤回。

## 搭载正常响应，至少一次投递

每次 exec/wait 即将返回时读取本对话的最新未确认事件；普通成功、运行中、错误和零文本预算都可携带。
事件使用独立模型可见 TextContent，清楚区分 question_from_agent 与 answer_from_user；
不放到隐藏的 _meta，不重复放 structuredContent，也不要求脚本手动 text 答案。
响应离开服务不代表模型收到，因此只记“尝试投递”；事件保留到下一次调用明确提交 ack_user_input。
确认只作用于当前对话的具体 event_id，可重复；跨对话或无效确认在执行脚本前拒绝，整组确认事务化。

问题状态和投递状态分开。修改答案使用 expected_revision，冲突保留旧答案与浏览器草稿，要求操作者重新确认。
每个版本产生新事件；旧版本的确认不会吞掉新版本。新事件明确 supersedes_event_id，
未送达的旧版本不再重复广播；历史版本仍保留在数据库。并发响应可能携带相同事件，模型按 ID 去重。

完整事件按 FIFO 装入独立预算，再缩小普通脚本输出，使最终文本仍不超过 36,000 UTF-8 字节。
单条完整答复有显式大小检查，放不下的事件留在队列，不截掉半句用户限制。读取异常也不能把已执行操作
改成可自动重跑的失败；保留答复并在之后的响应重试。ack 表示模型收到，不表示已理解或执行完成。

第一版仅搭载自然返回的 exec/wait，不因答案到达就取消正在进行的 wait；最长可等到其等待窗口结束。
这样避免遗弃在途观察者吞掉输出。不宣称即时 steer、推送新轮次或中断已有脚本。
ChatGPT 不再调用本服务时，Web 显示等待原对话继续，并提供包含问题、选择、notes 和事件 ID 的可复制提示。

## 持久化边界

SQLite 保存问题与答复版本，同一事务提交答案和待投递事件后才通知 Web。
采用 WAL 和 FULL 同步；使用兼容 Node 20/22/24 的 better-sqlite3 12 分支，不使用 Node 22 专属 node:sqlite。
默认位置是配置文件旁的 `.exec-mcp/<配置文件名>.questions.sqlite3`，目录/文件采用本机私有权限；
原始 ChatGPT 对话 ID 不写入数据库。CLI 持有数据库连接，运行时重启复用它；进程重启重新打开。
本机用户问答会落盘，这是有意区别于临时审计、终端日志和原生 store/load 的数据。

待答问题与最新未确认答案不自动过期；所有问题均已作答且最新答案确认超过 30 天的请求可清理。
清理整组旧历史，不为问答恢复 JavaScript、终端或自动续跑任务。SQLite 保存失败明确报错；不先显示提交成功。
数据库故障不会以空数据库静默替代，文件移动或删除由操作者负责，服务不创建额外备份/恢复产品。

## Web 提醒与系统通知

控制台始终显示待答数量和问题，SSE 仅广播 ID/变化，断线后通过刷新恢复。
系统通知使用浏览器原生 Notifications API；用户点击授权后启用，通知不显示题目或 notes。
权限被拒绝或非安全上下文时保留页面提醒；不把通知失败当成问题提交失败。
没有 Web Push 服务或后台推送订阅，关闭页面后不承诺系统通知；HTTP 局域网地址通常只提供页面提醒。
选项和 notes 保持独立，答复状态区分保存、尝试投递和已确认；没有自动选中或提交动作。

参考：[OpenAI 对话元数据及可见结果](https://developers.openai.com/plugins/reference)、
[浏览器通知权限与限制](https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API/Using_the_Notifications_API)。

## 原生数据库的安装边界

依赖版本同时核对 engines 和预编译资产。[better-sqlite3 12.10](https://github.com/WiseLibs/better-sqlite3/releases/tag/v12.10.0) 起取消 Node 20 预编译，
[12.9.1](https://github.com/WiseLibs/better-sqlite3/releases/tag/v12.9.1) 提示 Electron 预编译问题并推荐回到 12.9.0；固定仍提供目标平台 Node 20/22/24 构建的稳定版本，
避免让普通 Windows 安装依赖 C++ 编译器。Node 26 不在当前依赖支持范围，安装元数据同步收窄。
升级时验证三平台独立安装，而不只看 Linux 编译或 engines 声明通过。

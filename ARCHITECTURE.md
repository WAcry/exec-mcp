# 架构边界

本文说明长期职责划分。用户入口见 README，配置步骤见 docs/configuration.md 和 docs/connections.md。

## 谁负责什么

```text
ChatGPT 理解需求并推理，决定调用和保留哪些结果
    │
接入与认证 让请求安全到达本地 MCP 入口
    │
顶层 exec / wait
    └── Code Mode host 执行 JS 编排、tools 和显式输出
            ├── 本机操作 命令、补丁、文件、Skills、图片与异步提问
            └── 下游 MCP 启动时验证工具目录，运行时调用工具及按需读取资源
```

ChatGPT 负责模型推理，exec-mcp 负责执行工具。每个连接指向一台具体远端机器，
文中的“本机”指服务所在机器，与 ChatGPT 的其他容器相互独立。
编排 JavaScript 的 V8 环境没有直接文件和网络 API；工具仍能访问这台机器的文件系统与网络。
执行内核使用统一的接入接口，用户自行管理项目和 Git 工作流。
工作目录仅用于解析路径，执行句柄仅在当前运行期间有效。

Web 控制台观察和管理同一运行时的有界临时状态，模型推理、入口认证和执行仍由各自组件负责。
用户补充和异步提问保存在独立实例内存中，按对话哈希分组。Web 作答进入同一个补充队列，
随顶层工具响应返回，exec 内的工具原值保持不变。清空审计或回收原生 session 都保留消息，
生命周期及输出取舍见 [ADR-010](docs/adr-010-session-notes.md)。
Web 默认只监听回环地址，局域网认证和审计处理见 [ADR-009](docs/adr-009-web-console.md)。

Skill 发现只返回远端文档的元数据，Agent 按需读取正文或运行配套脚本。
一次返回完整目录、解析软链接和显式调用策略的取舍见 [ADR-006](docs/adr-006-skill-catalog.md)。
同一对话复用原生 session，通过 host 的 store/load 共享数据；每次 exec 的 V8 isolate 和工具快照仍独立。
内存紧张时回收整个原生 session，终端未读日志保留有界首尾。
对话关联键与原生 session 代次分开，旧实例的清理只能影响旧代次，同一对话可继续创建新实例。

JavaScript 和补丁执行复用固定版本的 Codex Code Mode host 与 patch engine。
完整 App Server 和模型客户端不在依赖范围内，Codex 的配置与会话数据库也独立保存。
平台适配负责系统路径、Shell 和进程树，各平台分别验证。
子进程完整继承操作者的环境；本服务的出站 HTTP 使用兼容 Node 20 的环境代理，
用户程序是否采用代理由自身网络栈决定，见 [ADR-008](docs/adr-008-environment-and-proxy.md)。
默认 Shell 在启动时确定，执行器与工具描述共用该值；单次覆盖只影响新命令，见 [ADR-007](docs/adr-007-command-shell.md)。
执行内核的整体取舍见 [ADR-001](docs/adr-001-exec-runtime.md)。

文件操作由 exec 编排，宿主在 exec.files 绑定输入，机器端按索引流式导入。
显式导出后，结果适配层附上原生资源链接，由独立通道传输文件快照。
文件字节直接走传输通道，省去 V8 和模型搬运 Base64 的过程，也无需修改固定 host，见 [ADR-005](docs/adr-005-file-transfer.md)。

## 目录、取消与认证

完整工具目录保存在运行时，模型只看到显式输出的条目。工具绑定、查询与展示共用一个契约来源，
下游全量 schema 按需读取，见 [ADR-002](docs/adr-002-tool-discovery.md)。

取消等待只停止本次观察，已经发生的操作仍然有效。Agent 决定展示多少结果，
服务检查传输和资源限制，并报告执行状态及无法确定的副作用，见 [ADR-003](docs/adr-003-results-lifecycle.md)。

隧道负责连接，认证负责判断谁能调用。OpenAI 私有 Tunnel 与 Cloudflare/Tailscale 公网接入
分别采用相应认证规则，见 [ADR-004](docs/adr-004-connectivity-trust.md)。

目录结构、函数关系及具体阈值直接查代码与测试，本文件只维护职责和取舍。

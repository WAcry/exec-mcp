# 架构边界

这是已经确定的职责划分，不是已实现模块清单。产品可用性以 README 为准。

## 谁负责什么

```text
ChatGPT：理解需求、推理、决定调用和保留哪些结果
    │
接入与认证：让请求安全地到达本地 MCP 入口
    │
顶层：exec / wait
    └── Code Mode host：JS 编排、tools、显式输出
            ├── 本机操作：命令、补丁、文件、Skills、图片与异步提问
            └── 下游 MCP：启动时验证完整目录，运行时调用
```

ChatGPT 是主 Agent；服务不是另一个模型推理循环。
执行内核不知道请求经过哪一种 Tunnel，也不拥有用户的项目或 Git 工作流。
项目路径不是 Workspace 身份，执行句柄不是持久任务身份。

Web 控制台只观察和管理同一运行时的有界临时状态，不是执行内核、认证提供方或第二个 Agent。
用户补充和异步提问以独立实例内存按对话哈希保存；Web 作答生成同队列补充，由所有顶层工具的外层返回统一附带；不进入 V8 工具原值，
也不随审计清空或原生 session 回收消失。生命周期及输出取舍见 [ADR-010](docs/adr-010-session-notes.md)。
默认只监听回环地址；局域网开放、浏览器认证、审计裁剪和静态资源边界见
[ADR-009](docs/adr-009-web-console.md)。

Skill 发现只把远端文档的元数据交给 Agent，不自动装载正文或执行脚本。
一次完整目录、软链接路径、显式调用策略和可调压缩预算见 [ADR-006](docs/adr-006-skill-catalog.md)。
同一对话复用原生 session 并通过 host 的 store/load 显式共享内存数据；每次 exec 的 V8 isolate 和工具快照仍独立。
不在外层另建 store 缓存或逐 key 配额；对原生 host 做宽松压力回收，终端未读日志保留有界首尾。
对话元数据关联键和原生 session 代次分离，回收旧实例不能永久损坏该对话或清理新实例。

复用 Codex 的 Code Mode host 和 patch engine，不引入完整 App Server、模型客户端，
也不共享机器上 Codex 的配置或会话数据库。
平台适配负责系统路径、可执行文件、Shell 和进程树；不能把 Linux 的实现假设泄漏成产品约束。
子进程完整继承受信任操作者的环境；本服务的出站 HTTP 统一采用兼容 Node 20 的环境代理，不接管任意用户进程的网络栈，见 [ADR-008](docs/adr-008-environment-and-proxy.md)。
默认 Shell 在实例启动时确定并用于执行器和精简工具描述；单次覆盖不改变实例默认值或已有进程，见 [ADR-007](docs/adr-007-command-shell.md)。
这些取舍见 [ADR-001](docs/adr-001-exec-runtime.md)。

文件通过 exec 编排，但字节流不经过 V8：宿主在 exec.files 绑定输入，机器端按索引流式导入；
显式导出由结果适配层追加原生资源链接，独立资源/下载通道交付快照。
这避免模型搬运 Base64，也不要求改动固定 host；见 [ADR-005](docs/adr-005-file-transfer.md)。

## 两个必须分开的边界

**目录存在于运行时，不等于进入模型上下文。** 工具绑定、本地查询和按需展示共用一个契约来源，
但不把下游全量 schema 放进启动提示。具体选择见 [ADR-002](docs/adr-002-tool-discovery.md)。

**取消等待，不等于撤回操作。** Agent 决定是否给本次输出设置预算；服务保护真实资源与协议边界，
并诚实表达已经发生或无法确定的副作用。具体选择见 [ADR-003](docs/adr-003-results-lifecycle.md)。

隧道解决可达性，认证决定谁可以执行；不能由执行工具猜测来访者的权限。
第一版的私有 OpenAI Tunnel 与未来公网接入不能共用无条件信任规则，见
[ADR-004](docs/adr-004-connectivity-trust.md)。

实现出现后，目录结构、函数关系、具体阈值和协议字段应直接读代码与测试，
不继续扩写这份文档来镜像实现。

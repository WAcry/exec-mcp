# ADR-004：接入与信任边界

状态：生效。日期：2026-09-17。

## 产品化不等于多租户平台

产品面向 Windows、Linux、macOS 的用户独立安装，首版每个实例属于一个受信任的操作者。
不把个人专用 Linux 服务的部署脚本原样当跨平台产品，
也不因“正式产品化”自动引入团队权限系统、中央控制面或多机器调度。

本机命令使用运行服务的系统账户权限，默认不提升权限。
`workdir` 和 V8 的无文件系统环境都不是 Shell 沙箱；
不用路径 allowlist 或命令字符串黑名单制造一种并不存在的整机隔离保证。
真正需要不可信代码隔离时，应单独选择操作系统或容器边界，而不是隐瞒当前权限模型。

## 可达性与认证分开

首版只交付 OpenAI Secure MCP Tunnel 连接，服务默认监听本机回环地址。
[官方 Tunnel 路径](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
由私网客户端主动连接，并利用 OpenAI 组织/工作区的访问范围。
只有明确配置为这一私有、单操作者路径，才允许本地 MCP 跳不另设应用认证；
本机其他进程仍属于被信任的环境。回环地址自身不证明请求来自 OpenAI。

其他 Tunnel 的延后接入计划见 [Backlog](BACKLOG.md)；实施时不能继承无认证例外。
[Tailscale Funnel](https://tailscale.com/docs/features/tailscale-funnel) 可以对公网开放，
不等同于只供 tailnet 内访问的 Serve；
[Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/) 的可达性也不能替代调用方授权。
公网模式必须验证应用认证或明确受信任的认证代理边界，不能因为最后一跳来自 localhost 就放行。

接入方式只影响部署与 HTTP 入口，工具内核不分支判断 Tunnel 品牌。
认证、允许的 Host/Origin、代理信任和公开地址在入口集中处理。
预留的是这个职责边界，不预建三个空 adapter、OAuth 账号系统或多租户模型。
协议路径必须保留取消与响应语义；不能通过写进 schema 就宣称实现了某种宿主能力。

## 安装与发布的边界

配置、密钥、日志和运行数据使用平台合适的用户级位置，与旧 codex-mcp 完全独立。
不硬编码开发者主目录、公司 Devspace、Shell profile 或单一操作系统的服务管理器。
安装和卸载只管理自己的文件、进程与服务；不得抢占端口、接管现有 Tunnel 或停止其他工具。
不能把当前开发环境的“已可访问”当成陌生用户的安装验证。

密钥不进入 Git、命令行参数、工具输出或示例；使用受系统权限保护的文件或凭据存储。
说明何种账户可以调用，就要按该边界检验权限；外部 MCP 的权限不能被当成已经得到用户授权。
首版只承诺普通工具代理，不承诺透明代理下游的 UI、sampling、elicitation 或文件绑定。
本服务自身的文件绑定与可选下载入口见 [ADR-005](adr-005-file-transfer.md)；
下载入口只提供显式导出的文件，不得把它与拥有机器执行权限的 MCP 入口一起公开。

公开 README 只写已经可用的安装和连接步骤，未交付的平台、架构、Tunnel 都明确标为目标。
当前无产品 UI 不影响原生内容返回；未来 Web UI 的计划见 [Backlog](BACKLOG.md)，
不意味着认证必须自行实现一套账号或登录系统。

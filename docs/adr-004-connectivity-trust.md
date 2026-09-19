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
子进程完整继承服务环境，不按秘密名称或白黑名单过滤；出站代理与边界见 [ADR-008](adr-008-environment-and-proxy.md)。

## 可达性与认证分开

支持 OpenAI Secure MCP Tunnel、Cloudflare Named Tunnel 和 Tailscale Funnel；服务始终监听本机回环地址。
[官方 Tunnel 路径](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
由私网客户端主动连接，并利用 OpenAI 组织/工作区的访问范围。
只有明确配置为这一私有、单操作者路径，才允许本地 MCP 跳不另设应用认证；
本机其他进程仍属于被信任的环境。回环地址自身不证明请求来自 OpenAI。

Cloudflare/Tailscale 使用显式 public 模式，必须配置稳定的 HTTPS origin 和应用认证，不能继承无认证例外。
[Tailscale Funnel](https://tailscale.com/docs/features/tailscale-funnel) 可以对公网开放，
不等同于只供 tailnet 内访问的 Serve；
[Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/) 的可达性也不能替代调用方授权。
公网模式必须验证应用认证或明确受信任的认证代理边界，不能因为最后一跳来自 localhost 就放行。

接入方式只影响部署与 HTTP 入口，工具内核不分支判断 Tunnel 品牌。
认证、允许的 Host/Origin、代理信任和公开地址在入口集中处理。
ChatGPT 公网接入使用外部 OAuth/OIDC 授权服务器；本服务验证 JWT 的签名、issuer、MCP resource audience、
expiry、scope 和唯一操作者 subject，并提供 protected resource metadata。不自建 OAuth 账号/登录/签发系统。
支持自定义 Authorization 的非 ChatGPT 客户端另可使用环境中的高熵 Bearer token，不使用 URL 秘密或身份头冒充认证。
供应商只解决可达性；Host/Origin 检查和认证覆盖每次 MCP 请求，不因为来自回环、会话 ID 或代理头而跳过。
既有私有路径不变，业务工具描述不因 Tunnel 品牌分叉；只按认证模式更新标准 securitySchemes 元数据。

新增 tunnel CLI 只在操作者显式运行时启动一个前台供应商客户端。先验证本机认证入口，再检查 provider 前置条件；
不创建账户/DNS、不安装系统服务、不修改 tailnet 策略或覆盖既有 Serve/Funnel 端口，也不自动重启失败连接。
Cloudflare 使用 Named Tunnel token 文件，不支持缺少 SSE 的 Quick Tunnel；Tailscale 不使用 --bg/reset，
并在启动前核对本节点 DNS 名称及既有端口配置。保留人工确认与供应商终端输出，不自动回答授权提示。
token 文件与父进程环境属于操作者管理范围；stdout 中只主动打印连接地址和状态，不主动打印凭据。
具体安装与身份提供方要求见 [连接方式](connections.md)。
协议路径必须保留取消与响应语义；不能通过写进 schema 就宣称实现了某种宿主能力。

## 安装与发布的边界

配置、密钥、日志和运行数据使用平台合适的用户级位置，与旧 codex-mcp 完全独立。
不硬编码开发者主目录、公司 Devspace、Shell profile 或单一操作系统的服务管理器。
安装和卸载只管理自己的文件、进程与服务；不得抢占端口、接管现有 Tunnel 或停止其他工具。
不能把当前开发环境的“已可访问”当成陌生用户的安装验证。

服务自身不把密钥自动写进 Git、日志、工具说明或示例；使用受系统权限保护的文件或凭据存储。
这不是禁止受信任的用户命令访问环境，也不承诺自动遮盖用户明确输出的环境变量。
说明何种账户可以调用，就要按该边界检验权限；外部 MCP 的权限不能被当成已经得到用户授权。
首版只承诺普通工具代理，不承诺透明代理下游的 UI、sampling、elicitation 或文件绑定。
本服务自身的文件绑定与可选下载入口见 [ADR-005](adr-005-file-transfer.md)；
下载入口只提供显式导出的文件，不得把它与拥有机器执行权限的 MCP 入口一起公开。

公开 README 只写已经可用的安装和连接步骤，未交付的平台、架构、Tunnel 都明确标为目标。
当前无产品 UI 不影响原生内容返回；未来 Web UI 的计划见 [Backlog](BACKLOG.md)，
不意味着认证必须自行实现一套账号或登录系统。

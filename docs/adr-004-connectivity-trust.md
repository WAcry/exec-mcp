# ADR-004：接入与信任边界

状态：生效。更新：2026-09-22。

## 产品化不等于多租户平台

产品面向 Windows、Linux、macOS 的用户独立安装，每个实例属于一个受信任的操作者。
不把个人专用 Linux 服务的部署脚本原样当跨平台产品，
也不因“正式产品化”自动引入团队权限系统、中央控制面或多机器调度。

把操作者及其 ChatGPT/Agent 视为具备能力、能理解任务并已获授权的执行者；不为防止它误操作而加入
逐命令审批、工具调用确认、路径/命令白黑名单或环境秘密隔离。该信任是产品取舍，不是模型永不犯错的保证。
备份、版本控制、虚拟机/容器、可恢复部署及操作系统的权限选择由操作者负责，不是 exec-mcp 的职责。

本机命令完整继承运行服务的系统账户权限：管理员/root 启动时，Agent 同样拥有该账户权限；
普通账户启动时不自动提权，也不额外降权。外部服务和操作系统自身的权限不由 exec-mcp 绕过。
这些是本服务的执行策略；ChatGPT 客户端或供应商自己的确认/授权机制不由本服务取消。
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
支持自定义 Authorization 的非 ChatGPT 客户端另可使用高熵 Bearer token，不使用 URL 秘密或身份头冒充认证。
供应商只解决可达性；Host/Origin 检查和认证覆盖每次 MCP 请求，不因为来自回环、会话 ID 或代理头而跳过。
既有私有路径不变，业务工具描述不因 Tunnel 品牌分叉；只按认证模式更新标准 securitySchemes 元数据。

新增 tunnel CLI 只在操作者显式运行时启动一个前台供应商客户端。先验证本机认证入口，再检查 provider 前置条件；
不创建账户/DNS、不安装系统服务、不修改 tailnet 策略或覆盖既有 Serve/Funnel 端口，也不自动重启失败连接。
Cloudflare 使用 Named Tunnel 环境凭据或显式 token 文件，不支持缺少 SSE 的 Quick Tunnel；Tailscale 不使用 --bg/reset，
并在启动前核对本节点 DNS 名称及既有端口配置。保留人工确认与供应商终端输出，不自动回答授权提示。
token 文件与父进程环境属于操作者管理范围；stdout 中只主动打印连接地址和状态，不主动打印凭据。
具体安装与身份提供方要求见 [连接方式](connections.md)。
协议路径必须保留取消与响应语义；不能通过写进 schema 就宣称实现了某种宿主能力。

## 身份提供方与凭据来源

Auth0 是推荐的现成身份提供方和配置示例，不增加 Auth0 专属认证分支或 SDK。
理由是让操作者能照一个明确服务完成连接，而不是自己推导占位配置；其他满足既有 OAuth/JWT 契约的提供方仍兼容。
本服务不存 Auth0 client secret、不替用户更改租户设置；具体 API、resource、回调和 scope 配置放在操作指南中。

静态 Bearer 同时支持 token_file/token_env，显式配置互斥；推荐文件用于个人长期部署，保留环境变量兼容现有集成。
都省略时沿用 EXEC_MCP_ACCESS_TOKEN 的旧默认。显式来源失败不回退，也不同时接受另一来源中的 token。
文件启动时读取并保留摘要，不按请求反复读盘，不做热更新；允许末尾换行/BOM 和软链接挂载，轮换需重启。

Cloudflare 显式 token_file 优先；未指定时复用供应商环境，顺序是 TUNNEL_TOKEN、TUNNEL_TOKEN_FILE。
cloudflared 原生 token 比 token-file 优先；之前直接拒绝冲突会迫使用户删除全局变量，没有必要。
文件模式由本服务解密，只在 cloudflared 子进程中以选定值覆盖 TUNNEL_TOKEN；父进程环境及其他变量不变。
原生客户端不读取我们的加密文件，不使用明文临时文件，不把 token 放进参数或可打印计划。
纯环境模式仍直接继承；显式文件失败不改用另一个 Tunnel。
这是供应商 CLI 选项适配，不推翻 [ADR-008](adr-008-environment-and-proxy.md) 的完整环境继承决定。

## 轻量 token 文件保护

目标只是避免普通明文扫描直接匹配 token，不是抵抗了解本程序、能读取其代码或进程环境的攻击者。
使用 Node 内建 AES-256-GCM、随机 nonce 和版本前缀，密钥由代码中公开稳定的常量派生；
这是可逆的静态保护，不是秘密保险库，不增加主密码、系统钥匙串、密钥服务或平台专属依赖。
前缀与解码密钥属于兼容格式，升级不能随意变更后让旧文件不可读。

只处理显式选择的单 token 文件：auth.token_file、Cloudflare token_file/TUNNEL_TOKEN_FILE，
以及 with-token 启动器的指定文件。普通环境变量、配置中的 headers/env、供应商 profile/证书及 Tailscale 状态都不扫描或改写。
首次实际读取到明文时，在同目录写入仅含密文的临时文件，完成后原子替换目标；不生成明文备份或临时解密文件。
识别已有前缀则只在内存解密；未知版本或校验失败报错，不当作新的明文重新加密。
用户更新凭据仍是把新明文粘贴覆盖原文件，再重启对应服务/客户端；无 watcher、无逐请求解密。

迁移只跟随软链接到真实文件，不替换链接本身；检测到普通并发编辑则失败，不用旧值覆盖新值。
明文文件及目录必须可写；已经加密的文件可只读使用。迁移失败不以明文继续启动，也不回退其他凭据。
POSIX 新文件权限为 0600；Windows 使用用户私人目录及其 ACL，不声称 chmod 能隔离同账户进程。
不承诺擦除历史磁盘块、编辑器备份或已有快照；密文仍须留在私人目录，不能据此公开或提交 Git。

OpenAI tunnel-client 独立管理自己的 profile，不能把未知私有配置文件直接改成我们的格式。
增加小型 CLI with-token：把指定文件自动保护/解密后，仅通过指定的子进程环境变量启动原生客户端，
沿用完整环境继承、参数数组和前台生命周期，不增加 MCP 工具或新的 Tunnel 配置分支。
这让 CONTROL_PLANE_API_KEY 可以来自受保护文件，又不要求修改、重写或解密落盘供应商 profile。
外部程序仍可以自行读取环境或输出凭据，本功能不是进程权限边界。

## 决策与操作文档的分工

本 ADR 记录选择现有 IdP、凭据来源共存及冲突优先级等长期取舍。
[connections.md](connections.md) 面向使用者，放 Auth0 设置、配置示例和启动步骤，不是第二份 ADR。
不将教程整篇改名为 ADR，也不让操作指南独自定义与这里相反的架构决策。

## 安装与发布的边界

配置、密钥、日志和运行数据使用平台合适的用户级位置，与旧 codex-mcp 完全独立。
不硬编码开发者主目录、公司 Devspace、Shell profile 或单一操作系统的服务管理器。
安装和卸载只管理自己的文件、进程与服务；不得抢占端口、接管现有 Tunnel 或停止其他工具。
不能把当前开发环境的“已可访问”当成陌生用户的安装验证。

服务自身不把密钥自动写进 Git、日志、工具说明或示例；使用受系统权限保护的文件或凭据存储。
这不是禁止受信任的用户命令访问环境，也不承诺自动遮盖用户明确输出的环境变量。
说明何种账户可以调用，就要按该边界检验权限；外部 MCP 的权限不能被当成已经得到用户授权。
代理下游工具和资源，但不承诺透明代理其 UI、sampling、elicitation 或文件绑定。
本服务自身的文件绑定与可选下载入口见 [ADR-005](adr-005-file-transfer.md)；
下载入口只提供显式导出的文件，不得把它与拥有机器执行权限的 MCP 入口一起公开。

公开 README 只写已经可用的安装和连接步骤，未交付的平台、架构、Tunnel 都明确标为目标。
已交付的独立本机 Web 控制台见 [ADR-009](adr-009-web-console.md)；它不是 ChatGPT 内嵌 Widget，
也不代替下游登录。下游启动加载与失败退出见 [ADR-002](adr-002-tool-discovery.md)。

## 1.0.0 基线不等于分发或部署

1.0.0 确立当前功能的首个正式产品基线，不继续以原型名义描述已经交付的能力。
版本成熟度与发布渠道分开：现阶段通过源码构建使用，公共 npm 分发仍待确定许可、发布权限与流程。
不因改版本号移除 private/UNLICENSED、擅自选择许可证、创建 Release 或发布安装包；
这些都需要对应授权与真实分发验证，部署和重启现有实例同样独立。

保留既有配置、凭据格式和运行契约；若以后改变兼容性，应记录必要的迁移步骤，而非静默丢掉用户设置。
验证版本贯通包清单、锁文件、CLI、MCP 与 Web；跨平台结果以对应提交的 CI 为准，不写永久成功承诺。

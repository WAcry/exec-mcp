# ADR-004 接入与信任边界

当前生效，2026-09-22 更新。

## 个人实例与执行权限

产品面向 Windows、Linux、macOS 的用户独立安装，每个实例属于一位受信任的操作者。
部署按平台处理，当前不提供团队权限系统、中央控制面或多机器调度。

服务信任操作者及其 ChatGPT/Agent 能理解任务并在授权内工作，因此不设逐命令审批或工具调用确认，
也不按路径、命令或环境变量名称建立白黑名单。模型仍可能犯错，操作者负责运行账户和恢复方案，
按需要准备备份、版本控制、虚拟机或容器。

任务默认由 ChatGPT 自行完成；只有用户明确要求，才可调用远端机器上的其他 Agent CLI，如 Codex 或 Claude Code。
即使这些程序已安装并登录，使用其额度仍需授权。该要求写入工具描述，不加命令拦截或审批流程。
固定 Code Mode host 和 patch engine 只执行本地代码，使用它们不会委派任务给另一个 Agent。

破坏性删除须使用明确、完整、已解析的绝对路径字面量，并先核验最终目标和删除范围。
路径不得含 Shell 变量、命令替换、通配符、动态拼接或其他插值，以免展开后删除范围改变。
这是操作者明确要求的调用规范，写入 exec 描述；执行器不拦截命令或自动改写路径。

命令完整继承服务账户权限。管理员/root 启动时，Agent 也有该账户权限；
普通账户启动时保持原权限，不自动提权或降权。操作系统、外部服务及 ChatGPT 自身的授权要求继续生效。
workdir 只决定路径解析位置，V8 的 API 限制只作用于编排 JS，Shell 仍可按账户权限访问机器。
需要隔离不可信代码时，由操作者配置操作系统或容器。
子进程完整继承服务环境，出站代理的范围见 [ADR-008](adr-008-environment-and-proxy.md)。

## 可达性与认证

支持 OpenAI Secure MCP Tunnel、Cloudflare Named Tunnel 和 Tailscale Funnel，MCP 始终监听回环地址。
[OpenAI 官方 Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
由私网客户端主动连接，访问范围由 OpenAI 组织或工作区管理。
只有显式选择该私有单操作者模式，才允许本地 MCP 跳省略应用认证；该模式也信任本机其他进程。
来自回环地址只能说明最后一跳的位置，判断私有接入仍依赖部署配置。

Cloudflare/Tailscale 使用显式 public 模式，配置稳定 HTTPS origin 和应用认证。
[Tailscale Funnel](https://tailscale.com/docs/features/tailscale-funnel) 可向公网开放，Serve 则用于 tailnet 内访问；
[Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/) 同样只负责连接。
公网请求须通过应用认证或明确受信任的认证代理验证，来自 localhost 也不能跳过。

HTTP 入口统一检查认证、Host/Origin 和代理信任，工具内核共用同一执行逻辑。
ChatGPT 公网接入使用外部 OAuth/OIDC 授权服务器；exec-mcp 验证 JWT 的签名、issuer、
MCP resource audience、expiry、scope 与唯一操作者 subject，并提供 protected resource metadata。
账号、登录和令牌签发交给身份提供方，本服务不另建。
支持自定义 Authorization 的其他客户端可使用高熵 Bearer token，URL 秘密或身份头不能代替认证。
认证及 Host/Origin 检查覆盖每次 MCP 请求，会话 ID 和代理头均不提供豁免。
工具描述与 Tunnel 品牌无关，仅标准 securitySchemes 元数据随认证模式更新。

tunnel CLI 在操作者显式运行时启动前台供应商客户端。启动前检查本机认证入口和供应商前置条件。
账户、DNS、系统服务和 tailnet 策略由用户配置，已有 Serve/Funnel 端口也保持不变；失败连接不自动重启。
Cloudflare 使用 Named Tunnel 的环境凭据或显式 token 文件，缺少 SSE 的 Quick Tunnel 不受支持。
Tailscale 启动前核对节点 DNS 和既有端口，保持前台运行，不调用 --bg/reset。
供应商终端输出保留，授权提示由用户回答。

token 文件和父进程环境由操作者管理，服务只主动打印连接地址及状态，不打印凭据。
安装和身份提供方要求见 [连接方式](connections.md)。取消与响应须按实际协议实现，
某项宿主能力要经过验证后才能在契约中声明。

## 身份提供方与凭据来源

文档推荐 Auth0 并提供具体配置步骤，方便操作者直接接通。实现只依赖通用 OAuth/JWT 契约，
同样兼容其他满足条件的提供方，无需增加 Auth0 专属分支或 SDK。
exec-mcp 不存 Auth0 client secret，租户设置由用户修改；API、resource、回调和 scope 的用法放在操作指南中。

静态 Bearer 可选 token_file 或 token_env，显式配置时二选一。长期个人部署推荐文件，
环境变量保留给已有集成；两项省略时从 EXEC_MCP_ACCESS_TOKEN 读取。
选定来源失败就报错，不回退或同时接受另一来源的 token。文件在启动时读取并保留摘要，
支持末尾换行、BOM 和软链接挂载，轮换后需重启。

Cloudflare 优先使用显式 token_file，省略时依次使用 TUNNEL_TOKEN、TUNNEL_TOKEN_FILE。
cloudflared 原生的 token 优先级高于 token-file，因此文件模式只在该子进程中覆盖 TUNNEL_TOKEN，
让用户可以保留其他用途的全局变量。父进程环境及其余变量不变。
文件由本服务在内存中解密，原生客户端只接收环境值，token 不进入命令参数或打印计划。
纯环境模式直接继承；显式文件失败时停止，避免误连其他 Tunnel。
该适配沿用 [ADR-008](adr-008-environment-and-proxy.md) 的完整环境继承规则。

## 轻量 token 文件保护

token 文件采用可逆保护，目的是减少普通明文扫描直接匹配凭据的机会。
实现使用 Node 内建 AES-256-GCM、随机 nonce 和版本前缀，密钥由代码中的公开常量派生。
了解程序或能读其运行环境的进程仍可取得明文。当前不引入主密码、系统钥匙串或独立密钥服务。
Web 登录密钥也使用同一保护，长期 Cookie 和轮换规则见 [ADR-009](adr-009-web-console.md)。
前缀与解码密钥属于兼容格式，升级时须继续支持旧文件。

只处理明确选定的单 token 文件，包括 auth.token_file、Cloudflare token_file/TUNNEL_TOKEN_FILE、
with-token 指定文件及本服务生成的 Web 凭据。其他环境变量、headers/env 配置、供应商 profile/证书和 Tailscale 状态保持原样。
首次读取明文时，在同目录写入密文临时文件，再原子替换目标。整个过程不生成明文备份或解密临时文件。
已有前缀的内容只在内存解密，未知版本或校验失败时报错并保留文件。
轮换时用新明文覆盖原文件，再重启对应服务或客户端；不设 watcher 或逐请求解密。

迁移跟随软链接到真实文件，并保留链接；发现并发编辑时停止，避免覆盖新值。
明文文件与目录须可写，密文文件可只读使用。迁移失败会阻止本次启动，不继续使用明文或其他凭据。
POSIX 新文件权限为 0600，Windows 使用私人目录及 ACL；同账户程序仍可能访问这些文件。
历史磁盘块、编辑器备份和快照不在清理范围内，密文也应保存在私人目录，不得公开或提交 Git。

OpenAI tunnel-client 自行管理 profile。with-token 读取并保护指定文件后，通过子进程环境变量
启动原生客户端，完整保留其余环境和参数数组，维持前台进程管理方式。
CONTROL_PLANE_API_KEY 可由此取得，供应商 profile 保持原样，MCP 也无需新增工具或配置分支。
外部程序仍能读取自己的环境或主动输出凭据。

## 文档与安装

本 ADR 记录身份提供方、凭据来源和冲突优先级的取舍。
[connections.md](connections.md) 供用户查阅 Auth0 设置与启动步骤，并与这里的决定保持一致。

配置、密钥和运行数据存放于平台对应的用户目录，与旧 codex-mcp 分开。
安装步骤不得依赖开发者主目录、公司 Devspace 或特定 Shell profile。安装和卸载只管理自己的文件与进程，
保留其他程序的端口、Tunnel 和服务。新用户安装应在独立环境验证。

服务自身不把凭据写进 Git、日志或工具说明；用户明确输出的环境变量和命令结果仍原样保留。
调用账户按入口规则认证，访问外部 MCP 还需获得对应授权。下游工具与资源可代理，
UI、sampling、elicitation 及文件绑定暂不提供透明代理。
本服务的文件绑定及独立下载入口见 [ADR-005](adr-005-file-transfer.md)，下载入口只能公开显式导出的文件，
不得连同无认证的执行入口一起公开。

README 写已可用的安装和连接步骤，未交付能力注明状态。
独立 Web 控制台见 [ADR-009](adr-009-web-console.md)，下游登录仍在供应商客户端完成。
下游启动检查和失败处理见 [ADR-002](adr-002-tool-discovery.md)。

## 版本与发布

1.0.0 是首个正式版本，目前通过源码构建使用。公共 npm 分发仍待确定许可、权限和发布流程。
版本号仅在用户明确要求时更新。调整 private/UNLICENSED、选择许可证、创建 Release 或发布安装包
均需另获授权并验证，部署和重启现有实例也分别授权。

已有配置、凭据格式和运行契约保持兼容；后续变更影响兼容性时，应提供迁移步骤。
升版后检查包清单、锁文件、CLI、MCP 与 Web 的版本一致，跨平台结果按对应提交报告。

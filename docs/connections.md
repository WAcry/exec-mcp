# 连接方式

所有方式都使用同一套 exec/wait、终端、文件资源和 Skills。`serve` 只启动本机 MCP；
`tunnel` 另开一个前台供应商客户端，不安装系统服务、不替你登录或接管已有 Tunnel。
下面用 `exec-mcp` 表示 CLI；按 README 从源码安装时，在仓库目录将它替换为 `node dist/src/cli.js`。
公共 npm 包仍是后续计划，不需要为使用这些连接方式先进行全局安装。

| 方式 | 适用场景 | 认证边界 |
| --- | --- | --- |
| OpenAI Secure MCP Tunnel | 已有 OpenAI Tunnel 权限 | 保留原有私有路径，不要求额外应用认证 |
| Cloudflare Named Tunnel | 有 Cloudflare 账户和固定域名 | exec-mcp 验证每个 MCP 请求，Cloudflare 只负责传输 |
| Tailscale Funnel | 已有 Tailscale 节点，希望使用 `.ts.net` 地址 | exec-mcp 验证每个 MCP 请求；Funnel 不是私有 tailnet Serve |

## 公网模式先配置认证

**Cloudflare Tunnel 和 Funnel 都可能被互联网上的任何人访问。** 不能转发原来的无认证
`openai-tunnel` 配置，不能把 URL 难猜、最后一跳是 localhost 或供应商身份头当作用户认证。

### ChatGPT：使用 OAuth

使用支持 OAuth authorization-code + PKCE S256、资源参数和 JWT access token 的授权服务器。
exec-mcp 只做资源服务器，不另建账号系统、登录页或 OAuth token 签发器；
登录、授权码、刷新 token 和 OAuth client 的管理交给已有身份提供方。

```toml
[server]
access = "public"
host = "127.0.0.1"
port = 8891
public_url = "https://exec.example.com"

[auth]
type = "oauth"
issuer = "https://identity.example.com/"
jwks_url = "https://identity.example.com/.well-known/jwks.json"
subject = "YOUR_STABLE_USER_SUBJECT"
scopes = ["exec"]
```

`public_url` 只填写 HTTPS origin，不附 `/mcp`。在身份提供方创建代表此服务的 API，
它的 resource/audience 必须是 **`https://exec.example.com/mcp`**，并授予所需 scope。
`issuer` 必须与 token 中的 `iss` 完全一致；`subject` 是你自己的稳定 `sub`，不是随意填写的邮箱。
这里只授权这个用户，不能仅因同一身份提供方签发了 token 就允许其他账户执行机器命令。

在 ChatGPT 中选择 OAuth，并按身份提供方支持的方式使用预注册 OAuth client、DCR 或 CIMD。
将 ChatGPT 配置界面给出的**完整回调 URI**加入身份提供方允许列表；不要猜测或放宽成任意回调。
身份提供方必须发布正确的 OAuth/OIDC 发现信息，并将收到的 `resource` 参数绑定到 access token 的 audience。
参考 [OpenAI OAuth 接入说明](https://developers.openai.com/plugins/build/auth)。

例如使用 Auth0 时，需创建对应 API/scope，确保自己的 access token 包含正确 `scope`，
并启用 [Resource Parameter Compatibility Profile](https://support.auth0.com/center/s/article/mcp-audience-error-with-auth0)。
默认租户设置并不一定满足这些条件，不能只复制 issuer 就假定已完成集成。
本服务接受 RS256/ES256/EdDSA JWT，不接受把 opaque token、ID token 或任意网站会话 cookie 当作 access token。

服务在 `/.well-known/oauth-protected-resource/mcp`（兼容根路径版本）提供资源发现；
未认证的 `/mcp` 返回标准 Bearer challenge。每次请求验证签名、issuer、audience、过期时间、scope 和指定用户，
包括工具目录、调用、wait、资源读取和旧版 MCP session 请求；旧 `session_id` 不能代替认证。
JWT 的有效期和吊销策略由身份提供方管理；已经被接受并开始执行的命令不会因 token 到期自动回滚或终止。

### 支持自定义请求头的客户端：可选静态 Bearer

不需要 OAuth 的自用 API 客户端可以改用：

```toml
[auth]
type = "bearer"
token_env = "EXEC_MCP_ACCESS_TOKEN"
```

在启动服务的环境里提供高熵随机 token（至少 32 字符），客户端用 `Authorization: Bearer ...` 发送。
可用 Node 的 `crypto.randomBytes(32).toString('base64url')` 生成后存入自己的安全环境配置。
不要把 token 放在 URL、Git 或共享日志中。静态 token 在启动时读取，轮换后需要重启服务。
**不假定 ChatGPT 的连接界面支持任意 Authorization 请求头**；连接 ChatGPT 时使用上面的 OAuth 方式。

## Cloudflare Named Tunnel

先按 [Cloudflare 官方步骤](https://developers.cloudflare.com/tunnel/get-started/) 安装 `cloudflared`，
创建一个专用于 exec-mcp 的 remotely-managed Named Tunnel，并配置固定公开域名。
将**整个域名**的 HTTP 服务指向 `http://127.0.0.1:8891`，保留路径和 Authorization 头，
使 `/mcp` 及 `/.well-known/...` 都能到达；不要为这些路径配置缓存、交互式挑战或额外浏览器登录墙。
Tunnel token 只保存在本地受权限保护的文件中（该文件的持有者能运行 Tunnel）。

在同一份 config.toml 中加入：

```toml
[tunnel]
provider = "cloudflare"
token_file = "./cloudflare-token.txt"
# executable = "/absolute/path/to/cloudflared"
```

需要支持 `tunnel run --token-file` 的官方客户端版本。相对文件路径以 config.toml 所在目录为基准；
`executable` 省略时从服务 PATH 查找。不要同时设置 `TUNNEL_TOKEN`，它在供应商客户端中会覆盖 token_file；
遇到这一冲突，exec-mcp 会报错而不是删改你的环境。

在两个终端使用同一份配置：

```sh
exec-mcp serve --config /path/to/config.toml
exec-mcp tunnel --config /path/to/config.toml
```

连接 ChatGPT 时填写 `https://exec.example.com/mcp`。
这条路径使用 Named Tunnel；**不支持随机域名 Quick Tunnel**，因为它没有稳定身份且不支持 SSE，
不适合作为本服务的正式 MCP 路径。参考 [Quick Tunnel 限制](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)。

## Tailscale Funnel

先安装并登录官方 Tailscale 客户端，启用 MagicDNS、HTTPS 和所需 Funnel 节点权限。
Funnel 需要能够运行 Tailscale CLI 的安装方式；各系统安装要求见
[官方 Funnel 文档](https://tailscale.com/docs/features/tailscale-funnel)。

将前面的公网 origin 改为本节点的 DNS 名称，例如：

```toml
[server]
access = "public"
host = "127.0.0.1"
port = 8891
public_url = "https://my-machine.my-tailnet.ts.net"

# 保留匹配这个新 resource/audience 的 [auth] 配置。
[tunnel]
provider = "tailscale"
# executable = "/absolute/path/to/tailscale"
```

public_url 的端口只能是 443（省略时默认）、8443 或 10000；例如 443 已有服务时，可选
`https://my-machine.my-tailnet.ts.net:8443`，身份提供方 audience 也要改成该 origin 加 `/mcp`。
仍在两个终端分别运行 `serve` 和 `tunnel`。

启动前会检查节点登录状态、DNS 名称和目标端口已有的 Serve/Funnel 配置。
已有服务时拒绝覆盖，不执行 `reset`、`down` 或自动登录；首次开启 Funnel 的确认由你在供应商客户端完成。
默认使用前台 Funnel，不加 `--bg`，Ctrl+C 结束本次客户端；不会故意创建跨重启持续公开的配置。
外部同时修改节点配置仍可能产生竞争，应避免多个管理员同时操作同一端口。
详细行为见 [tailscale funnel CLI](https://tailscale.com/docs/reference/tailscale-cli/funnel)。

## 运行与验证边界

`tunnel` 先检查本机 `/mcp` 确实拒绝匿名请求，OAuth 模式还核对资源身份，再启动供应商客户端。
这不是完整的公网验收；证书、DNS、账户权限、防火墙、CDN 超时和身份提供方仍须实际验证。
客户端启动信息不等于已经成功建立公网连接；供应商输出直接保留在你运行命令的终端中。
Ctrl+C 只清理本次启动的进程，不重启 MCP 或停止其他工具；客户端异常退出后不自动重放/重启。

HTTP proxy 环境完整继承给供应商客户端，但其 QUIC、控制连接等是否走代理由客户端本身决定。
OAuth JWKS 下载使用 exec-mcp 已有的环境代理并保持 TLS 校验。客户端需原样保留外部 Host 或改写为实际本机监听地址；
不信任 X-Forwarded-*、Cloudflare Access 或 Tailscale 身份头来绕过认证。

文件 `delivery="resource"` 通过同一受保护 MCP 读取即可；`delivery="url"` 仍使用独立下载入口和限时 token，
本次不会将文件端口自动加入 Tunnel 路由。`public_url` 也不会自动成为 `files.download.base_url`。
服务端与反向代理测试不能替代真实 ChatGPT OAuth 回调或供应商账户接通；没有完成的那一层不要宣称已验证。

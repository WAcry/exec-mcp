# 连接方式

本文供操作者配置与连接；身份提供方选择、凭据来源和优先级的生效决定见 [ADR-004](adr-004-connectivity-trust.md)。

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

### ChatGPT：推荐 Auth0，兼容其他 OAuth 提供方

推荐使用 **Auth0** 承担登录和 OAuth 授权；exec-mcp 只验证访问令牌，不自建账号、登录页或签发器。
Auth0 是文档中的推荐方案，不是代码绑定；其他满足相同 OAuth/JWT 契约的提供方仍可使用。
下面的 Auth0 租户 `your-tenant.us.auth0.com` 和 MCP 域名 `exec.example.com` 都必须替换为你的实际地址。
Auth0 域名是签发方，不是 MCP 域名。

```toml
[server]
access = "public"
host = "127.0.0.1"
port = 8891
public_url = "https://exec.example.com"

[auth]
type = "oauth"
issuer = "https://your-tenant.us.auth0.com/"
jwks_url = "https://your-tenant.us.auth0.com/.well-known/jwks.json"
subject = "auth0|YOUR_USER_ID"
scopes = ["exec"]
```

#### 在 Auth0 中准备

1. 创建或选择租户。在 **Applications → APIs** 创建此 MCP 对应的 API：名称可为 `Exec MCP`，
   **Identifier 必须是 `https://exec.example.com/mcp`**，Signing Algorithm 使用 **RS256**，
   添加 `exec` permission/scope。这是 API audience，不是 Application Client ID、Management API 或 Auth0 `/userinfo` 地址。
   Tailscale 使用本节点公开地址加 `/mcp`，指定端口时也必须一致。参见 [Auth0 API 配置](https://auth0.com/docs/quickstart/backend/rails)。
2. 按 [Auth0 MCP 授权指南](https://auth0.com/ai/docs/mcp/get-started/authorization-for-your-mcp-server)，
   在 **Settings → Advanced** 启用 **Resource Parameter Compatibility Profile** 和 **Include Issuer in Authorization Responses**。
   前者让 MCP 的 `resource` 参数绑定 API audience，后者用于授权回调签发方核对；只填 issuer 不足以完成配置。
3. 配置 ChatGPT 的 OAuth 客户端接入：优先使用租户支持的 CIMD，也可按其能力采用 DCR 或预注册 client。
   以 ChatGPT 管理界面实际给出的 client metadata 和完整 callback URI 为准，不硬编码旧回调，也不开放任意 callback。
   使用第三方客户端时，按 Auth0 指南启用合适的 domain-level connection、用户授权和 API access policy；
   需要长期连接时配置刷新令牌。不要用 Machine-to-Machine/client-credentials 流程代替用户登录。
   参见 [OpenAI OAuth 接入与客户端要求](https://developers.openai.com/plugins/build/auth)。
4. 在 Auth0 用户详情取自己的 User ID，填写为 `subject`。数据库用户通常是 `auth0|...`，
   社交登录可能是 `google-oauth2|...`，必须以实际用户的 `sub` 为准，不能填邮箱。
   授予该用户和客户端访问 `exec` 的权限；启用 RBAC 时还需配置对应角色/权限。
   本服务检查 access token 的 **`scope` 包含 `exec`**，不会把只有 `permissions` 的 token 当成满足 scope。
   参见 [Auth0 API scopes](https://auth0.com/docs/get-started/apis/scopes/api-scopes)。
5. 启动服务和 Tunnel，在 ChatGPT 中使用公开 `/mcp` 地址连接并登录自己的账户。
   `issuer` 必须与发现文档和 token 的 `iss` 完全一致，包括末尾 `/`；
   使用 Auth0 自定义域名时，依据该域名的 OIDC discovery 核对 `issuer` 和 `jwks_uri`，不要混用租户域名。
   Auth0 按实际签发域名设置 issuer，见 [Access Tokens](https://auth0.com/docs/secure/tokens/access-tokens/get-access-tokens)。

配置和服务端测试不等于真实 Auth0 租户与 ChatGPT 回调已验收。
常见 audience 错误参见 [Auth0 MCP 排查说明](https://support.auth0.com/center/s/article/mcp-audience-error-with-auth0)。
本服务接受 RS256/ES256/EdDSA JWT **access token**，不接受 opaque token、ID token 或浏览器 cookie 代替它。

`public_url` 只填写 HTTPS origin，不带 `/mcp`；MCP resource/audience 则带 `/mcp`。
这里只授权 `subject` 指定的用户，不是该 Auth0 租户的所有账户。
服务在 `/.well-known/oauth-protected-resource/mcp`（兼容根路径版本）提供资源发现；
未认证的 `/mcp` 返回标准 Bearer challenge。每次请求验证签名、issuer、audience、过期时间、scope 和指定用户，
包括工具目录、调用、wait、资源读取和旧版 MCP session 请求；旧 `session_id` 不能代替认证。
本服务本地校验 JWT，不实时查询提供方吊销状态；已开始执行的命令不会因 token 到期自动回滚或终止。

### 支持自定义请求头的客户端：可选静态 Bearer

推荐把高熵随机 token 放在单独的受权限保护文件中：

```toml
[auth]
type = "bearer"
token_file = "./secrets/access-token.txt"
```

已有环境变量部署可以继续使用，**与 token_file 二选一**：

```toml
[auth]
type = "bearer"
token_env = "EXEC_MCP_ACCESS_TOKEN"
```

两项都写会报配置错误，不猜优先级；都省略时保留旧行为，从 `EXEC_MCP_ACCESS_TOKEN` 读取。
显式选择文件后，不会因文件缺失、不可读或无效而回退到环境变量。
文件只放 token 原文（不是 JSON、TOML，也不带 `Bearer `），允许 UTF-8 BOM 和末尾换行。
路径支持 `~/` 和软链接，相对配置文件目录解析；启动时读取一次，更新后重启才生效，不做 watcher。

使用至少 32 字符的高熵随机 token；可用 Node 的 `crypto.randomBytes(32).toString('base64url')` 生成，
保存到不纳入 Git 的私人凭据目录，客户端通过 `Authorization: Bearer ...` 发送。
不要把 token 放进 URL 或共享日志。同一实例不会同时接受文件和环境中的两个 token。
**ChatGPT 使用上面的 OAuth/Auth0 方案**，不要假定其连接界面支持客户自带的静态请求头。

## Cloudflare Named Tunnel

先按 [Cloudflare 官方步骤](https://developers.cloudflare.com/tunnel/setup/) 安装 `cloudflared`，
创建一个专用于 exec-mcp 的 remotely-managed Named Tunnel，并配置固定公开域名。
将**整个域名**的 HTTP 服务指向 `http://127.0.0.1:8891`，保留路径和 Authorization 头，
使 `/mcp` 及 `/.well-known/...` 都能到达；不要为这些路径配置缓存、交互式挑战或额外浏览器登录墙。
以下凭据用于连接 Cloudflare，**不是前面的 MCP Bearer access token**，不要混用。

### 已有 TUNNEL_TOKEN：直接复用

在启动 `exec-mcp tunnel` 的环境中已有 `TUNNEL_TOKEN` 时，只需要：

```toml
[tunnel]
provider = "cloudflare"
# executable = "/absolute/path/to/cloudflared"
```

不需要把 token 再复制到文件，也不会把它放进命令行参数。
未配置 token_file 时沿用供应商环境优先级：先 `TUNNEL_TOKEN`，再 `TUNNEL_TOKEN_FILE`。
两者都没有会报错，不尝试其他账户凭据。环境文件路径沿用进程当前目录语义；要以配置文件为基准，使用下面的显式配置。

### 使用独立 token 文件：不用删除环境中的 TUNNEL_TOKEN

```toml
[tunnel]
provider = "cloudflare"
token_file = "./secrets/cloudflare-token.txt"
# executable = "/absolute/path/to/cloudflared"
```

**显式 token_file 始终优先**，即使环境中另有 TUNNEL_TOKEN 或 TUNNEL_TOKEN_FILE。
父进程和 cloudflared 子进程都继续继承原环境；启动参数使用空 `--token=` 配合 `--token-file`，
覆盖的只是本次 cloudflared 的选项选择，不是删除或改写环境变量。
文件缺失或无效时不回退到另一个 Tunnel，token 内容不进入进程参数。

相对文件路径基于 config.toml，支持 `~/`；`executable` 省略时从 PATH 查找。
文件模式需要支持 `--token-file` 的 cloudflared（2025.4.0+），见 [官方运行参数](https://developers.cloudflare.com/tunnel/reference/run-parameters/)。

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

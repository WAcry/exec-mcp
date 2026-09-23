# 连接方式

[English](connections.md) | 简体中文

本页提供连接步骤，身份提供方和凭据优先级的选择原因见 [ADR-004](../adr/004-connectivity-trust.zh.md)。

所有方式都使用同一套 exec/wait、终端、文件资源和 Skills。`serve` 启动本机 MCP 及配置启用的 Web/下载入口；
`tunnel` 单独启动前台供应商客户端，登录与系统服务安装由你处理，已有 Tunnel 保持不变。
下面用 `exec-mcp` 表示 CLI；按 README 从源码安装时，在仓库目录将它替换为 `node dist/src/cli.js`。
公共 npm 包尚未发布，使用这些连接方式无需先全局安装。

| 方式 | 适用场景 | 认证边界 |
| --- | --- | --- |
| OpenAI Secure MCP Tunnel | 已有 OpenAI Tunnel 权限 | 保留原有私有路径，不要求额外应用认证 |
| Cloudflare Named Tunnel | 有 Cloudflare 账户和固定域名 | exec-mcp 验证每个 MCP 请求，Cloudflare 只负责传输 |
| Tailscale Funnel | 已有 Tailscale 节点，希望使用 `.ts.net` 地址 | Funnel 向公网开放，exec-mcp 验证每个 MCP 请求。 |

## OpenAI Secure MCP Tunnel

按 [OpenAI 官方指南](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
安装 tunnel-client、创建属于自己的 Tunnel，并取得 Runtime API key。
该 Tunnel 需关联目标 ChatGPT 工作区；Tunnel 权限与 ChatGPT 开发者模式权限分别准备。

保持 exec-mcp 的默认私有配置和 serve 运行，在另一个终端创建独立 profile。

```sh
tunnel-client init --profile exec-mcp --tunnel-id YOUR_TUNNEL_ID --mcp-server-url http://127.0.0.1:8891/mcp
```

按官方说明为该终端设置 CONTROL_PLANE_API_KEY，或使用下方的[token 文件启动器](#token-文件的轻量保护)。
不要把真实 key 写入命令参数或仓库；已有同名 profile 时选择新名称，不覆盖其他配置。

```sh
tunnel-client doctor --profile exec-mcp
tunnel-client run --profile exec-mcp
```

在 ChatGPT 的开发者连接中选择 Tunnel 及对应实例；连接和调用期间两个进程都需运行。
MCP 端口改变时同步修改自己的 profile。私有 Tunnel 不提供通用浏览器文件下载地址。

## 刷新与排障

升级工具契约后，重启 exec-mcp 并在 ChatGPT 连接设置中刷新工具元数据，再开新对话验证。
新聊天可能仍使用缓存的连接描述，需先确认元数据已刷新。
具体入口以 [OpenAI 连接与刷新指南](https://developers.openai.com/plugins/deploy/connect-chatgpt#refresh-metadata) 为准。

连接失败时先检查 serve 和 Tunnel 的终端日志、MCP 的 /readyz、供应商 doctor、登录状态及配置端口。
OpenAI Tunnel 不可见时核对工作区关联与使用权限；公网方式还需核对 DNS、证书和 OAuth 配置。
完整用户设置见[配置指南](configuration.zh.md)。

## 公网模式先配置认证

**Cloudflare Tunnel 和 Funnel 都可能被互联网上的任何人访问。** 公网入口必须配置应用认证，
不得转发无认证的 `openai-tunnel` 配置。即使 URL 未公开或请求最后一跳来自 localhost，仍须验证用户身份。
供应商身份头也不能跳过这项认证。

### ChatGPT 的 OAuth 配置

推荐使用 **Auth0** 处理登录和 OAuth 授权，exec-mcp 验证访问令牌。
实现采用通用 OAuth/JWT 契约，也可使用其他满足条件的提供方。
下面的 Auth0 租户 `your-tenant.us.auth0.com` 和 MCP 域名 `exec.example.com` 都必须替换为你的实际地址。
Auth0 域名用于签发令牌，MCP 域名用于访问 exec-mcp。

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

1. 创建或选择租户。在 **Applications → APIs** 创建此 MCP 对应的 API，名称可为 `Exec MCP`，
   **Identifier 必须是 `https://exec.example.com/mcp`**，Signing Algorithm 使用 **RS256**，
   添加 `exec` permission/scope。Identifier 对应 API audience，Application Client ID、Management API 和 Auth0 `/userinfo` 使用各自的值，不能混填。
   Tailscale 使用本节点公开地址加 `/mcp`，指定端口时也必须一致。参见 [Auth0 API 配置](https://auth0.com/docs/quickstart/backend/rails)。
2. 按 [Auth0 MCP 授权指南](https://auth0.com/ai/docs/mcp/get-started/authorization-for-your-mcp-server)，
   在 **Settings → Advanced** 启用 **Resource Parameter Compatibility Profile** 和 **Include Issuer in Authorization Responses**。
   前者让 MCP 的 `resource` 参数绑定 API audience，后者用于授权回调签发方核对；只填 issuer 不足以完成配置。
3. 配置 ChatGPT 的 OAuth 客户端，优先使用租户支持的 CIMD，也可采用 DCR 或预注册 client。
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

配置后还需在自己的 Auth0 租户和 ChatGPT 连接中验证回调。
常见 audience 错误参见 [Auth0 MCP 排查说明](https://support.auth0.com/center/s/article/mcp-audience-error-with-auth0)。
本服务接受 RS256/ES256/EdDSA JWT **access token**，不接受 opaque token、ID token 或浏览器 cookie 代替它。

`public_url` 只填写 HTTPS origin，不带 `/mcp`；MCP resource/audience 则带 `/mcp`。
本服务只授权 `subject` 指定的用户，其他租户账户无法通过该入口。
服务在 `/.well-known/oauth-protected-resource/mcp`（兼容根路径版本）提供资源发现；
未认证的 `/mcp` 返回标准 Bearer challenge。每次请求验证签名、issuer、audience、过期时间、scope 和指定用户，
包括工具目录、调用、wait、资源读取和旧版 MCP session 请求；旧 `session_id` 不能代替认证。
本服务本地校验 JWT，不实时查询提供方吊销状态；已开始执行的命令不会因 token 到期自动回滚或终止。

### 静态 Bearer

支持自定义请求头的客户端可使用静态 Bearer。建议把高熵随机 token 放在受权限保护的独立文件中。

```toml
[auth]
type = "bearer"
token_file = "./secrets/access-token.txt"
```

已有环境变量部署可继续使用，**与 token_file 二选一**。

```toml
[auth]
type = "bearer"
token_env = "EXEC_MCP_ACCESS_TOKEN"
```

两项都写会报配置错误，不猜优先级；都省略时保留旧行为，从 `EXEC_MCP_ACCESS_TOKEN` 读取。
显式选择文件后，不会因文件缺失、不可读或无效而回退到环境变量。
初次将 token 本身存为纯文本，去掉 `Bearer ` 前缀，允许 UTF-8 BOM 和末尾换行。
首次启动自动转换为带 `exec-mcp:token:v1:` 前缀的轻量加密内容；以后启动自动解密，客户端仍使用原 token。
路径支持 `~/` 和软链接，相对配置文件目录解析；启动时读取一次，更新后重启才生效，不做 watcher。

使用至少 32 字符的高熵随机 token；可用 Node 的 `crypto.randomBytes(32).toString('base64url')` 生成，
保存到不纳入 Git 的私人凭据目录，客户端通过 `Authorization: Bearer ...` 发送。
不要把 token 放进 URL 或共享日志。同一实例不会同时接受文件和环境中的两个 token。
**ChatGPT 使用上面的 OAuth/Auth0 方案**，不要假定其连接界面支持客户自带的静态请求头。

## token 文件的轻量保护

文件加密用于减少普通明文扫描发现凭据的机会。密钥固定在代码中，了解实现的程序仍可解密，
同账户程序或定向攻击也可能取得明文。
选中的明文文件首次使用时会被替换为密文，无需额外命令或密码；换 key 时直接用新明文覆盖同一文件，再重启。
文件和所在目录需可写，迁移失败会报错。格式损坏时保留原文件，使用兼容版本或重新粘贴 key。
已有密文可只读挂载。Linux/macOS 新密文权限为 0600；Windows 使用本账户的私人目录及其 ACL。
保护只处理选定文件，已有备份和快照继续保留，其他文件及环境继承不变。运行时内存仍会持有解密后的值。

使用独立 OpenAI `tunnel-client` 时，先按[上面的步骤](#openai-secure-mcp-tunnel)创建 profile，
把 Runtime API key 保存到自己的文件，再运行以下命令。

```sh
exec-mcp with-token CONTROL_PLANE_API_KEY ./secrets/openai-token.txt -- tunnel-client doctor --profile exec-mcp
exec-mcp with-token CONTROL_PLANE_API_KEY ./secrets/openai-token.txt -- tunnel-client run --profile exec-mcp
```

`with-token` 只给这次启动的程序注入指定环境变量，真实 key 不进入命令参数或本程序日志；其余环境与参数原样继承。
文件相对当前终端目录解析，支持 `~/`；Windows 路径带空格时正常加引号。支持原生可执行文件，不通过 CMD 或额外 Shell 包装。
登录和授权仍由官方客户端完成，已有 profile 和 Tunnel 保持不变，Ctrl+C 只停止本次子进程。
这个入口也可用于其他支持环境变量凭据的客户端。OpenAI 官方环境变量方式见 [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)。

仅让 exec-mcp 管理这些文件；旧版 exec-mcp 或直接读取原文的第三方程序不识别新格式。
共享给其他程序的原文件不要同时作为自动加密目标；可以给它们也使用 with-token，或继续沿用环境凭据。

## Cloudflare Named Tunnel

先按 [Cloudflare 官方步骤](https://developers.cloudflare.com/tunnel/setup/) 安装 `cloudflared`，
创建一个专用于 exec-mcp 的 remotely-managed Named Tunnel，并配置固定公开域名。
将**整个域名**的 HTTP 服务指向 `http://127.0.0.1:8891`，保留路径和 Authorization 头，
使 `/mcp` 及 `/.well-known/...` 都能到达；不要为这些路径配置缓存、交互式挑战或额外浏览器登录墙。
Cloudflare 连接凭据与前面的 MCP Bearer access token 分别配置，前者用于连接 Tunnel，后者用于认证 MCP 请求。

### 复用已有 TUNNEL_TOKEN

启动 `exec-mcp tunnel` 的环境中已有 `TUNNEL_TOKEN` 时，只需指定供应商。

```toml
[tunnel]
provider = "cloudflare"
# executable = "/absolute/path/to/cloudflared"
```

不需要把 token 再复制到文件，也不会把它放进命令行参数。
未配置 token_file 时，先读取 `TUNNEL_TOKEN`，没有时再读取 `TUNNEL_TOKEN_FILE`。
两者都没有会报错，不尝试其他账户凭据。环境文件路径沿用进程当前目录语义；要以配置文件为基准，使用下面的显式配置。

### 使用独立 token 文件

```toml
[tunnel]
provider = "cloudflare"
token_file = "./secrets/cloudflare-token.txt"
# executable = "/absolute/path/to/cloudflared"
```

**显式 token_file 始终优先**，即使环境中另有 TUNNEL_TOKEN 或 TUNNEL_TOKEN_FILE。
文件首次读取自动加密，之后在内存解密；只为本次 cloudflared 子进程设置解密后的 `TUNNEL_TOKEN`。
父进程的原变量及子进程的其他变量（包括代理）不变，不要求删除已有凭据，也不创建明文临时文件。
文件缺失或无效时不回退到另一个 Tunnel，token 内容不进入进程参数。

相对文件路径基于 config.toml，支持 `~/`；`executable` 省略时从 PATH 查找。
使用官方客户端的 `TUNNEL_TOKEN` 环境入口，见 [官方运行参数](https://developers.cloudflare.com/tunnel/reference/run-parameters/)。
加密后的文件供 `exec-mcp tunnel` 读取，不能再直接交给 cloudflared 的 `--token-file`。

在两个终端用同一份配置分别运行服务和 Tunnel。

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

将前面的公网 origin 改为本节点的 DNS 名称。下面给出配置示例。

```toml
[server]
access = "public"
host = "127.0.0.1"
port = 8891
public_url = "https://my-machine.my-tailnet.ts.net"

# Keep the [auth] settings aligned with this new resource/audience.
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
公网连接还需验证证书、DNS 和账户权限，并检查防火墙、CDN 超时及身份提供方配置。
供应商输出保留在运行命令的终端中，连接是否可用应从实际公网请求确认。
Ctrl+C 只清理本次启动的进程，不重启 MCP 或停止其他工具；客户端异常退出后不自动重放/重启。

HTTP proxy 环境完整继承给供应商客户端，但其 QUIC、控制连接等是否走代理由客户端本身决定。
OAuth JWKS 下载使用 exec-mcp 已有的环境代理并保持 TLS 校验。客户端需原样保留外部 Host 或改写为实际本机监听地址；
不信任 X-Forwarded-*、Cloudflare Access 或 Tailscale 身份头来绕过认证。

文件 `delivery="resource"` 通过同一受保护 MCP 读取即可；`delivery="url"` 仍使用独立下载入口和限时 token，
本次不会将文件端口自动加入 Tunnel 路由。`public_url` 也不会自动成为 `files.download.base_url`。
ChatGPT OAuth 回调和供应商账户接通需分别实测，验收时按实际覆盖的范围记录结果。

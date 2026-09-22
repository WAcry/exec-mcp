# exec-mcp

让 ChatGPT 在你自己的机器上完成开发工作：阅读和修改代码、运行测试与命令，
以及调用你配置的其他 MCP 服务。继续使用 ChatGPT，不需要迁移项目或打开另一套聊天界面。

助手可以在一次调用里组合独立操作、并发执行并整理结果，减少机械性的往返。
面向模型的工具说明使用英语；文档和 Web 控制台保持中文。支持 ChatGPT 文件导入和产物交付，并提供可关闭的本机 Web 管理控制台。
仅暴露 exec/wait 两个工具：命令、补丁、文件、Skills、图片和异步提问均在 exec 中通过 tools.* 调用；
完整本机用法随 exec 描述提供，下游 MCP 契约通过 ALL_TOOLS 按需查看。
控制台用于观察和管理当前实例，不是另一套聊天界面，也不增加模型或子 Agent。

> **当前是可从源码运行的首版，尚未发布 npm 包或正式安装器。**
> CI 包含 Linux、Windows、macOS 的 Node 20/22/24 真实执行与独立打包安装验证（含管道和 PTY）。
> 平台状态以对应运行结果为准，不等于已经覆盖所有操作系统版本或 CPU 架构。
> OpenAI Tunnel 的真实 ChatGPT 连接仍需使用者的 Tunnel 权限与密钥完成验证。

已计划但尚未交付的方向见 [Backlog](docs/BACKLOG.md)，不代表当前已可用功能。

## 从源码启动

支持 Node.js 20.19+，以及 22.19 以上、低于 26 的版本和 npm；新部署优先使用 Node 22 或 24。
Node 20 已结束上游维护，这里保留兼容支持，不代表重新获得安全维护。
Windows 使用 PowerShell 或 pwsh，不要求 WSL，也不支持仅有 cmd.exe 的命令环境。
安装依赖需要联网，首次安装也会获取固定版本的本机执行组件。

取得源码后，在仓库目录运行：

```sh
npm ci
npm run check
node dist/src/cli.js init
node dist/src/cli.js doctor
node dist/src/cli.js serve
```

`init` 创建用户配置并打印路径，已有文件不会覆盖。`doctor` 检查配置并实际运行一次
执行环境探针，不连接下游服务。`serve` 前台运行，按 Ctrl+C 停止。
现阶段不自动安装系统服务，也不会改动其他 MCP 服务或 Tunnel。

默认端点为 `http://127.0.0.1:8891/mcp`；本机就绪检查是同一地址的 `/readyz`。
端口被占用时修改自己的配置，不要停止或接管其他程序。

### Web UI 控制台

`exec-mcp serve` 默认同时启动 Web 控制台：

```text
http://127.0.0.1:8893/
```

默认只监听本机回环地址。8891 留给 MCP，8892 可供独立文件下载入口使用；端口冲突会明确失败，
不会自动寻找并占用其他端口。可以配置或关闭：

```toml
[web]
enabled = true
host = "127.0.0.1"
port = 8893
```

控制台提供 Light/Dark 模式、全部工具调用摘要与详情、子调用耗时、原生 session 和内存状态、
终端滚动缓冲、Skills、下游 MCP 检索诊断，以及导出产物查看与撤销。对话使用与原生 session 相同的
不可逆摘要归组，不在浏览器中展示原始 `_meta["openai/session"]`。
每个工具都有输入参数与返回详情；命令/补丁原文和其余参数分别显示，在途调用的详情自动更新。
控制台可切换已有 MCP、已发现 Skill、默认 login 与 Web 开关；保存后点击“重启执行服务”生效。
重启会清空临时 store/cell、终端和导出链接，不备份或恢复执行；失败可在同一管理页修正并重试。

调用审计只保存在当前进程内，重启即清空；默认全局保留最近 10,000 条调用，单项体积也有宽松上限，
过大的源码、参数、结果或子调用会保留首尾并标注裁剪。这只影响控制台副本，不改变 MCP 的实际返回或副作用。配置页面隐藏凭据值、
HTTP header/env 值和命令参数；但命令及工具结果本身仍可能包含敏感内容，因此该控制台属于高权限界面。
前端静态资源随包构建，不在运行时加载第三方字体、脚本或遥测。

### 给工作中的对话发送补充

在“会话组”点击“发送补充”，或进入该组的调用流后发送。默认显示会话哈希，可手动设置本机备注名；
备注不会改变收件人。只有携带 ChatGPT 对话标识的组可以发送，普通无标识调用仍可使用。

补充随该对话下一次 exec/wait 响应附带，不需要 Agent 查询，也不打断正在运行的命令。
当前执行结果使用 content 文本，补充以「用户额外补充：」附入同一通道，不另外复制一份结构化结果。
消息 ID 和时间仍可在 Web 查看，不再写入模型收到的补充正文。
正文最多 30,000 UTF-8 字节；普通结果仍限 36,000 字节，附带补充后合计最多 37,000 字节。
消息按序、完整使用剩余额度，放不下就继续排队，不缩小正常输出。长消息可能一直等待，待发时可撤回或复制到原对话。

“已附入工具响应”不是已读或已执行。消息和备注临时保留 72 小时，清空审计、回收原生内存或重启执行服务不删除它们；
整个程序退出后丢失。草稿仅在当前页面内保留。ChatGPT 已结束工作时，可复制消息到下一轮对话。

### 工作途中回答 Agent 的问题

Agent 可在 exec 中调用 `tools.request_user_input_async` 提交问题，立即继续其他工作；你在 Web 的“会话组”看到对应会话的待答数量和问题预览。
点击“回答问题”打开同一会话的沟通侧栏：在“问题”中逐题选择，或选“以上都不是”填写自己的回答；
每个选项都可附加限制或说明。推荐项不会自动选中或提交。“补充消息”仍可随时主动发送文字。

```js
text(await tools.request_user_input_async({
  questions: [{
    title: "这个新模块使用哪种存储？",
    options: ["SQLite：本机持久化", "仅内存：重启清空"]
  }]
}));
```

该 await 只等待问题提交。
提交后返回 `accepted` 和请求 ID，不等待人回答；没有查询回答、代用户发送补充或修改备注名的 MCP 工具。
回答由服务组合题目、实际选项和补充原文，走上述 `user_notes` 通道随正常调用送达。未投递时可撤回并重答；
已经附入响应则保留历史，可再发修正说明。跨页面竞争提交不会静默覆盖答案，草稿仍保留。
提问需要 Web 已运行并且 ChatGPT 提供对话标识。问题和回答与补充共享临时保留机制，重启执行服务保留、程序退出不恢复。

**系统提醒：**点击控制台右上角铃铛的“启用通知”并允许浏览器权限。新问题到达时会触发系统通知，
点击可直接打开所属会话的问题；同一次提交的多题只提醒一次。铃铛中也可暂停或测试通知。
通知仅显示短会话标识和题数，不展示题目或答案。请保持页面打开并连接；刷新或重连不补发旧提醒，待答问题仍在会话组中。
桌面通知需要浏览器支持及安全上下文（本机 localhost/127.0.0.1 或 HTTPS）；普通 HTTP 局域网地址和部分移动浏览器仅显示页面提示。
浏览器权限或系统勿扰设置可能屏蔽提醒，关闭网页后没有后台推送；这些都不影响保存问题和作答。

设置 `enabled = false` 时不会继续在后台采集上述审计副本；Web 启动失败也会停止采集。

确需局域网访问时显式设置 `host = "0.0.0.0"`（或 IPv6 的 `"::"`）。启动日志会打印带
`#token=…` fragment 的本次访问链接；fragment 不随 HTTP 请求或 Referrer 发送，前端只用它换取
HttpOnly cookie，并立即从地址栏移除。默认不会把 Web UI 交给 Cloudflare/Tailscale 的 MCP Tunnel。
本机重新生成密钥后，旧 cookie 和已经建立的事件流都会立即失效。
当前局域网 UI 使用 HTTP，只适合受信任网络；不要直接公开到互联网或在不可信 Wi-Fi 上使用。
完整边界见 [ADR-009](docs/adr-009-web-console.md)。

## 配置

默认配置位置：

| 系统 | 位置 |
| --- | --- |
| Linux | `$XDG_CONFIG_HOME/exec-mcp/config.toml`；未设置时为 `~/.config/exec-mcp/config.toml` |
| macOS | `~/Library/Application Support/exec-mcp/config.toml` |
| Windows | `%APPDATA%\exec-mcp\config.toml` |

所有命令都支持 `--config 文件路径`；也可设置 `EXEC_MCP_CONFIG`。
主目录由运行服务的系统账户决定，不读取其他 Codex/MCP 产品的配置。

```toml
[server]
# 明确选择可信的 OpenAI 私有 Tunnel 路径；不是公网认证开关。
access = "openai-tunnel"
host = "127.0.0.1"
port = 8891

# 可选：Web 管理控制台。默认就是下面的回环配置。
# [web]
# enabled = true
# host = "127.0.0.1"
# port = 8893

# 可选：本机 stdio MCP。
# [mcp_servers.local]
# command = "node"
# args = ["/absolute/path/to/server.js"]
# enabled_tools = ["lookup"]

# 可选：HTTP MCP。只填写你已授权的服务与凭据。
# [mcp_servers.remote]
# url = "https://example.com/mcp"
# headers = { Authorization = "Bearer REPLACE_ME" }
```

`serve` 会先并行连接所有启用的下游 MCP，验证凭据、读取全部工具页并校验输入契约，再开放端口、报告就绪。
任何启用的服务连接失败、需要登录、目录失败或契约无效，本次启动都会失败退出并清理已启动的客户端，
不会带着部分工具列表继续运行。不使用的服务可设置 `enabled = false`；未设置 `enabled_tools` 时加载全部工具。
已有 Skill 或上下文给出工具名称和参数时，助手第一次 exec 即可直接调用。
`ALL_TOOLS` 是已绑定本机及下游工具的目录，助手在 exec 内按名称或描述筛选、读取完整契约，使用 `tools[name](args)` 调用。
exec 描述一次性提供全部本机工具的完整说明；下游契约按需输出，不预先填满上下文。
Web 的下游工具列表可以按名称或描述筛选并展开契约；它只浏览当前目录，不试执行工具。
下游的文档、数据库结构等 MCP 资源也可以按需读取：exec 内提供 `list_mcp_resources`、
`list_mcp_resource_templates` 和 `read_mcp_resource`，无需增加配置。资源与可调用工具是不同目录；
只提供资源、没有 tools 的服务也可接入。资源列表带原配置服务名，读取按 `server`＋`uri` 路由，
不会把下游的 `file://` URI 当成本机路径。示例见[资源读取](docs/code-mode-examples.md#mcp-资源)。
stdio 可额外设置 `cwd`、`env`；HTTP 可设置 `headers`。
两者均可设置 `enabled`、`enabled_tools`、`startup_timeout_sec` 和 `tool_timeout_sec`。
`enabled_tools` 仅筛选工具，不筛选资源；停用整个服务仍使用 `enabled = false`。
资源列表指定 `server` 时返回一页，以 `nextCursor` 续取；省略时汇总全部启用服务，失败记录在 `errors`。
资源按调用实时读取，不缓存正文、不在启动时加载所有资源；沿用 `tool_timeout_sec` 作为单服务请求的总期限。
`startup_timeout_sec` 默认 30 秒，覆盖该服务的协议协商与全部目录分页；可按需要设置 120、300 等更长时间，
不受 ChatGPT 的单次 wait 时间约束。多个下游并行加载；启动期间可按 Ctrl+C 取消并清理。
配置修改后重启 exec-mcp。配置可能含凭据，不要提交、分享或复制到对话中。

### 在终端准备下游鉴权

启动日志会显示每个下游的连接状态和工具数量；stdio 服务的 stderr 会显示在当前终端。
stdio MCP 使用已登录的供应商客户端或完整继承的环境及 `env` 设置；HTTP MCP 使用配置中的 `headers`。
遇到 401/403、登录提示或超时时，先在本机按供应商步骤登录/刷新凭据，修正配置后重新运行 `serve`。
当前不代办通用下游 OAuth 浏览器登录或 token 自动刷新；不把登录任务留到 ChatGPT 调用中的 Widget 或 elicitation。
本服务对 ChatGPT 的 Auth0/OAuth 入口认证不会自动授权另一台下游 MCP，两边凭据分别配置。

启动验证不执行有副作用的工具操作，只完成连接与完整目录检查；某个工具额外的权限要求、令牌后续过期或远端掉线，
仍可能在实际调用时报错。此时不会自动重放已发送的命令，应先检查结果，并在本机修复连接/鉴权。

## 环境变量与网络代理

命令、PTY 和下游 MCP 子进程完整继承启动 exec-mcp 时的环境，包括 API key、代理和自定义变量，
不做环境变量白名单或黑名单过滤。下游 `[mcp_servers.<name>.env]` 的显式值只覆盖同名变量。
服务不会自动把全部环境打印出来，但通过命令读取这些值是允许的；只给可信客户端和下游服务使用。

本服务的 HTTP MCP 请求与 ChatGPT 附件下载会自动使用 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY`，
也支持对应的小写名称（小写优先）。Node 20/22/24 行为一致，无需额外启用 `NODE_USE_ENV_PROXY`。
HTTPS_PROXY 缺失时继承 HTTP_PROXY；支持 HTTP/HTTPS 代理地址，代理认证可包含在用户自己的代理 URL 中。
NO_PROXY 支持主机名、域名后缀、端口及 `*`，例如 `localhost,127.0.0.1,[::1],.internal.example`。
代理连接失败不会偷偷直连；需要私有证书时使用 `NODE_EXTRA_CA_CERTS`，不要关闭 TLS 校验。
代理变量应在启动服务前设置，修改后重启；没有新增一套代理配置或管理工具。

子进程会拿到全部代理变量，但它是否采用这些变量取决于程序本身；这不是强制代理任意网络流量的 VPN。
特别是 Node 20 的普通用户脚本需要其网络库支持代理，本服务不会给它注入 NODE_OPTIONS 或修改它的代码。
单独启动的 OpenAI tunnel-client 同样需要在所需代理环境中启动，并遵循它自己的协议与代理支持；
exec-mcp 不接管或重启它。HTTP_PROXY 也不会把入站的文件下载响应改成另一条出站连接。

默认 `login=false` 保持不变：继承已有环境不需要加载 profile；加载 profile 可能覆盖 PATH/代理或引入启动副作用。
需要时通过下面的配置或单次参数启用。只有内部父子进程之间的 Code Mode 回环 IPC 固定直连，不经外部 HTTP 代理。

## 命令 Shell

命令工具默认使用实例配置的 Shell，不需要 Agent 每次选择；也支持用可选的 `shell`、`login` 覆盖单次调用。Windows 默认优先 PowerShell 7（`pwsh.exe`），
没有时使用 Windows PowerShell；macOS/Linux 优先 `$SHELL`，无法使用时 macOS 依次尝试 `/bin/zsh`、`/bin/sh`，Linux 使用 `/bin/sh`。
exec-mcp 不自动安装 Shell。可以在配置中覆盖：

```toml
[execution]
shell = 'C:\Program Files\PowerShell\7\pwsh.exe'
login = false
```

`shell` 也可填服务 PATH 中的可执行文件名，如 `pwsh` 或 `bash`；macOS 可填 `/bin/zsh`。
相对路径以配置文件目录为基准，支持 `~/`。只填可执行文件，不附命令参数；不支持 CMD 或批处理入口。
默认 `login=false`：PowerShell 不加载 profile，其他 Shell 使用非 login 模式，仍遵循其自身启动文件规则。
`login=true` 对 PowerShell 表示加载 profile，对其他 Shell 表示 login 模式；分配 PTY 不会自动加载交互配置。

配置在启动时解析；显式配置无效会报错，不换 Shell 重跑命令。修改后重启服务并刷新客户端工具目录。
逐调用的 `shell` 与 `login` 各自独立覆盖，未指定的字段继承实例默认值；
`execution.login=false` 是默认模式，不禁止本次显式使用 `login=true`。
单次 Shell 的相对路径以最终命令工作目录为基准，配置路径仍相对配置文件；裸名称均从服务 PATH 查找。
覆盖仅影响这次新建进程，不改变后续命令、并发命令或已有 `session_id`；无效覆盖会报错，不换 Shell 重跑。

## Skills

助手可一次发现机器上已有的 Skill 名称、用途和全文路径，匹配任务后再读取完整 `SKILL.md`，
不会提前把所有正文、脚本和参考资料放进上下文。它不是 Skill 安装器，也不替代项目指令。
默认发现 `~/.agents/skills/` 和 `~/.codex/skills/`；指定项目路径时，还会发现从当前目录到最近
Git 根目录的 `.agents/skills/`，支持 Git worktree。没有 Git 根时只检查指定目录自身。
支持目录和文件软链接；返回真实路径，多个链接指向同一文件只列一次，同名不同文件都保留。

目录默认目标为 **40,000 个 Unicode 字符，约 10,000 tokens**，可在自己的配置里调整：

```toml
[skills]
max_chars = 40000
```

这是字符预算，不是精确模型 Token 数。目录较大时先无损缩短公共路径，再公平保留用途描述的前缀。
名称、可还原的全文路径和调用策略不截短；如果仅这些信息就超过目标，会明确说明并保留完整目录，
不以分页或搜索隐藏部分 Skill。修改配置后重启自己的 exec-mcp；Skill 文件修改本身不需要重启，重新发现即可。

可以在 **exec-mcp 自己的 config.toml** 中使用 Codex 风格的 `[[skills.config]]` 启用或禁用 Skill：

```toml
[[skills.config]]
name = "release"
enabled = false

[[skills.config]]
path = '~/projects/my-project/.agents/skills/release/SKILL.md'
enabled = true
```

未配置的 Skill 默认启用。每项必须填写 `enabled`，并在 `name` 与 `path` 中二选一：
`name` 精确匹配 frontmatter 中的名称，作用于所有同名 Skill；`path` 精确指定一个 `SKILL.md`，
支持绝对路径、`~/` 和相对配置文件目录的路径，也支持软链接。匹配同一真实文件时，**后写的规则优先**。
上例先禁用所有名为 `release` 的 Skill，再为指定文件恢复启用。

禁用项不会出现在返回目录中，也不占用描述预算；不会增加启停工具或向 Agent 展示启停配置。
启用只影响原有发现范围内的 Skill，不额外扫描配置路径，也不覆盖下面的“仅显式调用”策略。
修改配置后重启服务；禁用不删除文件、不阻止已有 Shell 直接读取文件，也不读取或修改 Codex 自己的配置。

不希望助手按任务自行启用某个流程时，在该 Skill 的 `agents/openai.yaml` 中设置：

```yaml
policy:
  allow_implicit_invocation: false
```

这类 Skill 只列名称和路径，标注“仅用户明确要求使用”，不展示触发描述；策略读取或解析失败也采用这一保守方式并警告。
这是对助手的调用指引，不是限制 Shell 文件访问的安全沙箱。不读取 Codex 的其他配置、插件或启停列表。
开始使用或切换项目时可直接要求助手先发现 Skills；实际是否遵循指引仍取决于模型。

## 连接 ChatGPT

支持 **OpenAI Secure MCP Tunnel、Cloudflare Named Tunnel、Tailscale Funnel**；后两者必须启用应用认证。
推荐使用 Auth0 连接 ChatGPT；Auth0 设置、凭据来源和前台启动步骤见 [连接方式](docs/connections.md)，选择依据见 [ADR-004](docs/adr-004-connectivity-trust.md)。下面保留原有 OpenAI 私有接入流程。
按照 [OpenAI 官方说明](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
安装 `tunnel-client`，创建属于自己的 Tunnel，并取得相应的 Runtime API key。

保持 exec-mcp 运行，在另一个终端为它创建独立 profile：

```sh
tunnel-client init --profile exec-mcp --tunnel-id YOUR_TUNNEL_ID --mcp-server-url http://127.0.0.1:8891/mcp --health-listen-addr 127.0.0.1:0
```

按官方说明为该终端设置 `CONTROL_PLANE_API_KEY`，不要把实际密钥写进命令参数或仓库。
希望使用本机 key 文件时，可以用 `exec-mcp with-token CONTROL_PLANE_API_KEY ./secrets/openai-token.txt -- tunnel-client run --profile exec-mcp`，
首次读取自动轻量加密，以后直接使用原路径；无需把明文加入命令历史。源码安装时将 `exec-mcp` 替换为 `node dist/src/cli.js`。
Bearer／Cloudflare 的 token_file 同样自动处理；保护范围及凭据轮换见 [token 文件的轻量保护](docs/connections.md#token-文件的轻量保护)。
然后运行：

```sh
tunnel-client doctor --profile exec-mcp
tunnel-client run --profile exec-mcp
```

在 ChatGPT 的开发者 App/连接设置中选择该 Tunnel。连接与调用期间，两个进程都需要保持运行。
已有同名 profile 时不要用 `--force` 覆盖其他配置；选一个新的 profile 名称。
修改了 MCP 端口时，也需要同步修改自己的 Tunnel profile。

连接后可直接告诉 ChatGPT：“检查我的项目并运行测试”，附上明确的项目路径。
首次使用建议先执行只读检查，确认访问的是预期机器与目录。

升级或修改工具契约后，重启服务，并在 ChatGPT 的连接设置中 **Refresh（刷新）工具元数据**，再开新对话测试。
新窗口可能仍使用旧连接元数据；若运行时 ALL_TOOLS 已有新工具，外层说明却仍列出已删除工具，
应对照服务实际的 `tools/list` 检查连接是否已刷新，不是让 Agent 反复搜索。
参见 [OpenAI 元数据刷新步骤](https://developers.openai.com/plugins/deploy/connect-chatgpt#refresh-metadata)。

不要将 `access="openai-tunnel"` 的无认证入口转发到公网；切换其他 Tunnel 时使用文档中的 public + auth 配置。
隧道可达不代表调用者已经获得授权。公网模式使用外部 OAuth 授权服务器连接 ChatGPT，不要求新增 UI 或更改执行内核。

## 文件传输

文件由宿主绑定到 `exec.files`；脚本用 `tools.import_file({index,destination})` 选择零基索引并保存。
`tools.apply_patch(patch)` 接收完整补丁字符串；本机相对路径以 `exec.workdir` 为基准，省略时为服务用户主目录。
Shell 命令和补丁作为 JavaScript 字符串传递，现成字符串直接使用；多行和嵌套示例见 [Code Mode 示例](docs/code-mode-examples.md)。

`tools.write_stdin` 按 Codex 的窗口收集输出：非空输入默认 250 毫秒，仅读取默认 5 秒；
有效窗口分别为 250–30000、5000–300000 毫秒，另保留显式 `0` 立即读取。
进程结束提前返回，日志不会结束窗口；超时不终止进程，仍用原 session_id 续取。
内层等待可以长于外层；exec 先返回 cell_id 后，用每次最多 110 秒的 wait 续取，不把长等待变成连接器超时。

在 ChatGPT 中附上文件并告诉助手保存位置，助手可将它导入机器后继续处理。
未使用的附件不会自动下载，默认不会覆盖已有文件；下载链接只由服务端使用。
也可让助手把机器上的报告或其他文件导出：默认通过私有 MCP 资源交付，不生成公网链接。
资源模式至多 32 MiB；宿主需要支持原生资源读取，实际附件展示取决于宿主，**不承诺 sandbox 挂载**。
文件绑定和资源传输已通过服务端与 MCP SDK 测试；真实 ChatGPT 绑定/展示需连接新版本验证。

需要浏览器可下载的 HTTPS 链接时，先准备自己的 HTTPS 入口，再增加可选配置：

```toml
[files]
ttl_seconds = 3600
# 导入和 URL 导出的单文件上限，默认 512 MiB。
max_file_bytes = 536870912
# 临时导出快照总配额（包含管理开销），默认 4 GiB。
max_export_bytes = 4294967296

[files.download]
# 替换为真实可访问的 HTTPS 基址，不要填写示例地址。
base_url = "https://downloads.example.com/files"
port = 8892
```

将这个 HTTPS 入口代理到独立的 `http://127.0.0.1:8892`，**保留完整路径**。
该端口只支持显式导出文件的下载，不提供 MCP、目录浏览或上传；不要代理到执行命令的 8891 端口。
exec-mcp 不会自动安装、启动或重新配置公网 Tunnel；OpenAI Secure MCP Tunnel 本身不提供浏览器下载地址。

配置后让助手明确选择 URL 交付。链接默认 1 小时过期，持有者均可下载或转发；
可在 Web 控制台的产物页面提前撤销导出，或等待自动过期；已经开始或完成的下载不能收回。下载支持 HEAD 和单段 Range，不是一次性链接。
文件是独立快照，不受源文件后续改动影响；机器和下载入口需要保持在线，重启后链接失效。
未启用下载入口时 URL 请求会明确失败，不会把私有资源偷偷公开。
正常关闭或到期会清理导出快照；异常退出可能在系统私有临时目录留下待清理文件，但不会恢复旧链接。

## 权限与限制

store/load 使用原生 Code Mode 内存存储，不另设 key 数、对话数或每个 cell 的小配额。
默认观察 Code Mode host 的约 **4 GiB** 内存压力；先 FIFO 清理空闲 session，正常空闲保留 **72 小时**。
若没有空闲状态且内存仍高，可回收最久未使用的活动 session；其 store 与 cell 可能丢失。
这是宽松回收阈值，不是整个进程树的硬上限；不管理浏览器、编译器或用户创建文件的占用。

```toml
[memory]
code_mode_high_water_mib = 4096
idle_retention_hours = 72
terminal_buffer_mib = 16
```

**ChatGPT 的对话标识不需要改变。** 同一对话的旧原生 session 被回收后，下次 exec 自动绑定全新的原生 session，
从空 store 开始；旧实例正在关闭时也不会永久挡住该对话。旧 cell_id 不能在新 session 中续等。
被回收或中断的命令不会自动重跑，已经发生的副作用不回滚。极端关闭故障可能重启共享 host，影响其中其他 cell，
但之后同一对话仍可继续执行。需要长期保存的数据应明确写文件。

终端未读输出默认每个进程保留 **16 MiB**：约 1 MiB 最早未读头部，加上滚动最新尾部；每次最多读取 4 MiB，剩余用原 session_id 续取。
超量会省略中间日志，在 output 中注明，并返回 `truncated: true` 和 `omitted_bytes`；
后续读取不会补回被丢弃的部分，也不重复已读头部。不会自动落盘，A 刷日志也不阻塞 B 的输出。
需要完整 JSON/数据或完整日志时，应显式重定向到文件。已退出且长时间未读取的终端记录会按同一空闲保留期释放，
不会因这条规则终止仍在运行的用户进程。

已有配置显式写出的文件大小和有效期不会被默认值变更覆盖。

这是对真实机器的访问，不是 Shell 沙箱。助手拥有运行服务的系统账户所拥有的文件和命令权限；
工作目录与执行引擎的隔离环境都不会限制 Shell 的系统权限。管理员/root 启动时，助手也拥有相应权限。
实例信任操作者及其 Agent 的能力和授权，不添加逐命令审批或工具调用确认，也不替普通账户自动提权。
备份、沙箱/虚拟机、恢复方案和运行账户由使用者选择并维护。此信任不意味着对公网陌生请求免鉴权；
现有入口认证、同源边界、参数校验和资源回收仍保留。

代码、日志和结果可能被交给 ChatGPT 或所调用的外部服务；自托管不等于数据绝不离开机器。
一般工具大结果不自动转成下载文件；终端日志采用上述有界首尾缓冲。顶层工具最终文本合计最多 36,000 UTF-8 字节，
超量保留首尾；这不是精确 token 限额。嵌套结果仍交给 Code Mode，优先在 JS 中筛选或先 store 再分段 load。
助手可显式指定更小的模型输出预算或明确写文件。示例见 [Code Mode 与 PowerShell](docs/code-mode-examples.md)。
支持同一 ChatGPT 对话内暂存和复用中间数据，减少重复查询；这不是持久存储，空闲/压力回收或服务重启后会丢失。
需要宿主提供对话标识；没有标识时普通执行仍可用，但暂存操作会明确报错。
已有图片可随工具结果回传并附带说明；这不等于内建 AI 图片生成服务。
取消不能回滚已发生的操作；运行中的任务和进程不承诺在服务重启后恢复。
下游的 UI、sampling、elicitation 和原生附件等宿主交互不在首版代理范围内。

## 本地验证与开发

```sh
npm run check
npm run test:package
```

第二个命令会在临时目录打包并安装一个独立副本，验证 CLI、MCP 和真实补丁操作；
不会发布软件包或安装全局服务。CI 定义了 Linux、Windows、macOS 的 Node 20/22/24 检查矩阵，
平台状态以实际运行结果为准。

开发者先读 [架构边界](ARCHITECTURE.md)，编码 Agent 从 [AGENTS.md](AGENTS.md) 开始。
第三方组件的来源与许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)；
本项目自身尚未选定公开发布许可。

# 配置与运行

[English](configuration.md) | 简体中文

本页供安装和维护 exec-mcp 时查阅，配置片段按需加入同一份 config.toml。
首次启动见 [README](../../README.zh.md)，Tunnel、Auth0 和 token 文件见[连接指南](connections.zh.md)。

## 配置文件

`init` 创建配置并打印位置，已有文件保持不变。默认路径如下。

| 系统 | 位置 |
| --- | --- |
| Linux | `$XDG_CONFIG_HOME/exec-mcp/config.toml`，未设置时为 `~/.config/exec-mcp/config.toml` |
| macOS | `~/Library/Application Support/exec-mcp/config.toml` |
| Windows | `%APPDATA%\exec-mcp\config.toml` |

`init / doctor / serve / tunnel` 可用 `--config 路径`，也可设置 `EXEC_MCP_CONFIG`。
主目录指运行服务的系统账户；exec-mcp 不读取其他 Codex/MCP 产品的配置。
配置可能包含凭据，请保存在自己的私人目录。

默认配置使用私有入口。

```toml
[server]
access = "openai-tunnel"
host = "127.0.0.1"
port = 8891
```

这份无额外应用认证的配置仅用于可信 OpenAI 私有 Tunnel。公网接入使用[连接指南中的 public 配置](connections.zh.md#公网模式先配置认证)。
`serve` 使用指定端口，发生冲突时报告错误并保留其他进程。`/readyz` 可检查本机 MCP 就绪状态。
配置修改通常需要重启执行服务；工具描述改变后还需刷新 ChatGPT 的连接元数据。

## 下游 MCP

本机 stdio 服务和 HTTP 服务可以同时配置。

```toml
[mcp_servers.local]
command = "node"
args = ["/absolute/path/to/mcp-server.js"]
# cwd = "/absolute/path/to/project"
# env = { CUSTOM_SETTING = "value" }

[mcp_servers.remote]
url = "https://example.com/mcp"
headers = { Authorization = "Bearer REPLACE_ME" }
```

每个服务选择 `command` 或 `url` 之一；stdio 可设置 `args / cwd / env`，HTTP 可设置 `headers`。
stdio 的相对 `cwd` 基于配置文件目录；可执行文件名从服务环境的 PATH 查找。

以下选项写在对应服务段中，两种连接方式都支持。

| 选项 | 用途 |
| --- | --- |
| `enabled` | 默认 true；false 不启动该服务。 |
| `enabled_tools` | 省略加载全部工具；数组只选择指定工具，空数组不绑定工具。不筛选该服务的资源。 |
| `startup_timeout_sec` | 默认 30 秒，覆盖连接、协商与全部工具目录页；慢启动可调整为 120 或 300。 |
| `tool_timeout_sec` | 默认 120 秒，约束下游工具及资源请求，与外层 wait 分别计时。 |

**全部启用服务就绪后才开放 MCP 入口。** 地址、鉴权、工具目录或契约失败都会使本次启动失败；
不使用的服务可在配置中关闭。启动检查不实际调用工具，也不预读所有资源正文。

需要登录时先在本机完成供应商登录，并配置环境或 headers，再启动 exec-mcp。
stdio 的诊断保留在终端；当前不代办通用下游 OAuth 登录/刷新，也不在 ChatGPT 中弹出登录表单。
ChatGPT 的入口 Auth0 认证和访问下游的凭据分别配置。

资源专用服务也能接入。工具目录按需通过 ALL_TOOLS 查看；资源的列举、模板和读取示例见
[Code Mode 示例](code-mode-examples.zh.md#mcp-资源)。连接后来失效时，可在本机修复；已发送的操作不会自动重放。

## 命令 Shell

Windows 默认优先 PowerShell 7（pwsh），其次 Windows PowerShell；不要求 WSL，也不自动安装 Shell。
macOS/Linux 优先可用的 `$SHELL`；否则 macOS 尝试 `/bin/zsh`、`/bin/sh`，Linux 使用 `/bin/sh`。

```toml
[execution]
shell = 'C:\Program Files\PowerShell\7\pwsh.exe'
login = false
```

可改为 `pwsh`、`bash` 或 `/bin/zsh` 等可执行文件名/路径。配置中的相对路径基于配置文件目录，支持 `~/`；
只填写可执行文件，不附带命令参数。CMD 和批处理文件不作为 Shell 入口。

默认 `login=false`，PowerShell 不加载 profile，其他 Shell 使用非 login 模式，仍遵循自身的启动文件规则。
`login=true` 对 PowerShell 表示加载 profile，对其他 Shell 表示 login 模式；分配 PTY 本身不改变这项设置。
继承已有环境不需要加载 profile；只有工作流程需要时才调整。

Agent 可用 `shell / login` 参数独立覆盖单次命令，不修改实例默认值或已有终端。
单次 Shell 相对路径基于命令工作目录；无效配置/覆盖会报错，不换一个 Shell 重跑。
工具描述会显示实例的默认 Shell；修改配置后重启并刷新 ChatGPT 连接元数据。

## 环境与代理

Shell、PTY 和下游子进程完整继承服务的环境，包括凭据与代理变量；下游的显式 `env` 只覆盖同名变量。
本服务不会主动打印整个环境，但不会禁止受信任命令读取或输出它。

本服务的 HTTP MCP、资源请求、附件下载和 JWT 公钥获取尊重 `HTTP_PROXY / HTTPS_PROXY / NO_PROXY`，
也支持小写名称，小写优先。HTTPS_PROXY 缺失时继承 HTTP_PROXY；支持 HTTP/HTTPS 代理，代理失败不偷偷直连。
NO_PROXY 支持主机、域名后缀、端口和 `*`，例如 `localhost,127.0.0.1,[::1],.internal.example`。
Node 20/22/24 不需要额外设置 `NODE_USE_ENV_PROXY`；私有 CA 使用 `NODE_EXTRA_CA_CERTS`。

代理变量在启动前设置，修改后重启。子进程和 Tunnel 客户端会取得这些变量，
是否采用由各自网络栈决定。需要统一路由浏览器、用户脚本或 UDP 等流量时，应另行设置系统网络。
内部执行组件的回环通信不经过外部 HTTP 代理。

## Skills

默认发现服务账户的 `~/.agents/skills/` 与 `~/.codex/skills/`。指定项目后，
从该目录向上到最近 Git 根发现 `.agents/skills/`，支持 worktree；没有 Git 根时只检查指定目录。
支持目录/文件软链接，按真实文件去重；同名不同文件保留。只先返回元数据，正文由助手按需读取。

```toml
[skills]
max_chars = 40000

[[skills.config]]
name = "release"
enabled = false

[[skills.config]]
path = '~/projects/my-project/.agents/skills/release/SKILL.md'
enabled = true
```

未配置的 Skill 默认启用。每条规则必须有 `enabled`，并在 `name / path` 中二选一；
name 精确匹配所有同名项，path 指定一个 SKILL.md，支持相对配置文件目录的路径、`~/` 和软链接。
最后匹配的规则生效，上例先禁用全部同名项，再启用指定文件。启用不会扩大原有发现范围。

某个流程仅允许用户点名使用时，在其 `agents/openai.yaml` 中设置以下策略。

```yaml
policy:
  allow_implicit_invocation: false
```

此时目录只列名称和路径，标记“仅用户明确要求使用”，不展示触发描述。
配置禁用管理目录可见性，显式调用策略指导模型选择；Shell 仍按系统权限读取文件。
Skill 文件修改后重新发现即可；修改 exec-mcp 配置需重启。不会读取或修改 Codex 自己的启停配置。

`max_chars` 按 Unicode 字符计量，目录同时适应模型响应的字节预算，实际 token 数取决于模型。
大目录先缩短路径表达和描述前缀，保留名称、路径与调用策略。极端情况下最低目录仍可能超预算，
不保证一条模型响应能显示任意多的 Skills；实际返回会说明压缩或裁剪。

## Web 控制台

界面支持英语和简体中文，首次打开按浏览器的语言偏好顺序匹配，均不匹配时使用英语。
浏览器通常沿用操作系统的语言设置，服务所在机器的语言不会影响界面。
在“设置”中展开“界面偏好”，可选择自动、English 或简体中文；登录页使用语言图标切换。
选择立即生效，无需修改 config.toml 或重启。
手动选择保存在当前网站的 localStorage，同源标签页同步；浏览器禁止存储时仍可在本页切换。
日期与数字按界面语言显示，时区仍使用浏览器的本地时区。用户文本和原始诊断保持原文。

Web 默认采用以下设置。

```toml
[web]
enabled = true
host = "127.0.0.1"
port = 8893
```

`enabled=false` 关闭界面及调用审计采集；Web 启动失败也停止采集，但 MCP 仍可使用。
Web 的配置开关只改已有 MCP、已发现 Skill、login 和 Web enabled，保存后重启执行服务生效。
重启失败保留管理页供修正重试；临时执行、终端、导出链接和旧审计不会恢复。

需要局域网访问时，显式将 host 改为 `0.0.0.0` 或 `::`，用机器的实际 IP/主机名访问。
首次使用启动日志中的访问密钥或带 `#token=…` 的链接登录，浏览器随后移除地址栏中的密钥。
登录 Cookie 为 HttpOnly，关闭浏览器、刷新页面及普通服务重启后仍有效；访问控制台时自动续期，
连续 30 天未访问才失效。它仅适用于保存该 Cookie 的浏览器和主机；隐私模式或主动清除网站数据会丢失登录。
退出登录清除本浏览器的 Cookie；本机“换新密钥”使全部旧登录、旧链接与事件流失效。

Web 凭据保存在配置文件旁的 `.exec-mcp/<配置文件名>.web-token`，沿用 token 文件的轻量加密，
config.toml 保持不变。浏览器只保存签名 Cookie。首次生成或换新时目录须可写；
已有凭据损坏会报错，保留这份私有文件才能在重启后继续登录。删除后启动会生成新密钥，旧登录随之失效。
当前局域网 UI 使用 HTTP，仅适合可信网络；MCP Tunnel 不会自动发布它，也不应直接暴露到公网。

系统通知需浏览器权限及安全上下文，本机回环地址或受保护 HTTPS 可用；普通 HTTP 局域网地址可能无法通知。
网页关闭、断线或系统勿扰时不承诺提醒，问题仍可在下次打开页面时查看。

调用审计是临时观察数据，默认保留最近 10,000 条调用；单项也有上限，大内容标注裁剪。
计数只包含当前保留记录，已清理的历史不再计入。裁剪只影响审计副本，实际调用保持原样。
配置页隐藏凭据值，命令和结果本身仍可能含敏感信息，控制台应按高权限页面管理。

## 文件交付

导入只处理本次 ChatGPT 绑定且被助手选中的附件，默认不覆盖目标。导出创建独立快照，
源文件后来修改不影响已导出内容；私有资源交付至多 32 MiB，是否展示/挂载由宿主决定。

需要通过浏览器下载较大文件时，准备独立 HTTPS 入口并添加以下配置。

```toml
[files]
ttl_seconds = 3600
max_file_bytes = 536870912
max_export_bytes = 4294967296

[files.download]
base_url = "https://downloads.example.com/files"
port = 8892
```

替换为真实 HTTPS 地址，将整个请求路径代理到 `http://127.0.0.1:8892`；
此入口只提供显式导出文件的下载，不应代理到 MCP 的 8891 端口。它需要单独设置，
`public_url` 只用于 MCP，OpenAI 私有 Tunnel 也不提供通用浏览器下载，文件地址须单独配置。

配置后让助手选择 URL 交付。默认单文件上限 512 MiB，导出快照总配额 4 GiB（包含管理开销），
默认有效期 1 小时。持有者均可下载或转发链接；机器和下载入口必须保持在线。
可在 Web 提前撤销后续访问，已经开始或完成的下载不能收回；重启后链接失效。
正常关闭/到期会清理快照，异常退出可能留下系统临时文件；旧链接不会因此恢复。

## 容量与临时状态

```toml
[memory]
code_mode_high_water_mib = 4096
idle_retention_hours = 72
terminal_buffer_mib = 16
```

高水位只用于触发 Code Mode 执行组件的内存回收，机器总内存和用户子进程树由用户管理。
采样及回收存在延迟，组件的瞬时内存仍可能越过阈值。
压力下先回收最早空闲的会话，仍不足时可能回收最久未使用的活动会话。
同一 ChatGPT 对话随后能创建干净执行状态，不要求新开聊天；旧 cell 无法续等，也不自动重跑命令。
重要数据请保存文件；本服务不限制用户生成文件的磁盘占用。

终端每进程默认保留 16 MiB 未读首尾，每次最多收取 4 MiB；中间被丢弃的日志会标注且不能补回。
不会因一个终端刷日志暂停其他终端，也不自动把全部日志落盘。需要完整日志时由命令明确写文件。

普通模型响应最多 36,000 UTF-8 字节，超限保留首尾；有用户补充时合计最多 37,000 字节。
这些是本服务的保守字节预算，ChatGPT 的实际 token 限制可能变化。补充正文上限 30,000 字节，问题答复连同题目和选择计费；
队首放不下就继续等待，不为它再次裁剪普通结果。消息和问题保留 72 小时、使用有界内存，容量不足时拒绝新提交。

会话沟通单独保存，清空审计或在 Web 重启执行服务时，补充、问题和备注继续保留；整个进程退出后丢失。
没有宿主对话标识时普通执行仍可用，但跨调用 store/load 和会话沟通不可用。

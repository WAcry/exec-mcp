# exec-mcp

让 ChatGPT 在你自己的机器上完成开发工作：阅读和修改代码、运行测试与命令，
以及调用你配置的其他 MCP 服务。继续使用 ChatGPT，不需要迁移项目或打开另一套聊天界面。

助手可以在一次调用里组合独立操作、并发执行并整理结果，减少机械性的往返。
工具说明使用中文；没有控制面板、内建 Skills 管理或问题表单，暂不支持 ChatGPT 附件导入。

> **当前是可从源码运行的首版，尚未发布 npm 包或正式安装器。**
> Linux x64 已验证真实执行与独立打包安装。Windows/macOS 的原生路径和 CI 已加入，
> 但尚未在对应系统完成验证，不能当作已发布的平台支持承诺。
> OpenAI Tunnel 的真实 ChatGPT 连接仍需使用者的 Tunnel 权限与密钥完成验证。

## 从源码启动

需要 Node.js 22.19 以上、低于 27 的版本和 npm；优先使用 Node 22 或 24。
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

下游服务在助手首次需要外部能力时才连接；离线下游不会阻止本机编码。
stdio 可额外设置 `cwd`、`env`；HTTP 可设置 `headers`。
两者均可设置 `enabled`、`enabled_tools`、`startup_timeout_sec` 和 `tool_timeout_sec`。
配置修改后重启 exec-mcp。配置可能含凭据，不要提交、分享或复制到对话中。

## 连接 ChatGPT

首版只使用 **OpenAI Secure MCP Tunnel**，不支持无认证的公网访问。
按照 [OpenAI 官方说明](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
安装 `tunnel-client`，创建属于自己的 Tunnel，并取得相应的 Runtime API key。

保持 exec-mcp 运行，在另一个终端为它创建独立 profile：

```sh
tunnel-client init --profile exec-mcp --tunnel-id YOUR_TUNNEL_ID --mcp-server-url http://127.0.0.1:8891/mcp --health-listen-addr 127.0.0.1:0
```

按官方说明为该终端设置 `CONTROL_PLANE_API_KEY`，不要把实际密钥写进命令参数或仓库。
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

Cloudflare Tunnel 与 Tailscale Funnel 仍是后续计划。
不要将当前无认证入口转发到公网；隧道可达不代表调用者已经获得授权。

## 权限与限制

这是对真实机器的访问，不是 Shell 沙箱。助手拥有运行服务的系统账户所拥有的文件和命令权限；
工作目录与执行引擎的隔离环境都不会限制 Shell 的系统权限。只使用可信客户端和下游 MCP，
以合适的普通账户运行，保留版本控制和备份。

代码、日志和结果可能被交给 ChatGPT 或所调用的外部服务；自托管不等于数据绝不离开机器。
大结果不会自动截断或转成下载文件，由助手选择过滤、分批读取或明确写文件。
取消不能回滚已发生的操作；运行中的任务和进程不承诺在服务重启后恢复。
下游的 UI、sampling、elicitation 和原生附件等宿主交互不在首版代理范围内。

## 本地验证与开发

```sh
npm run check
npm run test:package
```

第二个命令会在临时目录打包并安装一个独立副本，验证 CLI、MCP 和真实补丁操作；
不会发布软件包或安装全局服务。CI 定义了 Linux、Windows、macOS 的 Node 22/24 检查矩阵，
平台状态以实际运行结果为准。

开发者先读 [架构边界](ARCHITECTURE.md)，编码 Agent 从 [AGENTS.md](AGENTS.md) 开始。
第三方组件的来源与许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)；
本项目自身尚未选定公开发布许可。

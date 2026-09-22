# exec-mcp

让 ChatGPT 在你指定的机器上阅读和修改代码、运行命令与测试、使用已有 Skills，
并调用你配置的其他 MCP 服务。工作仍在 ChatGPT 中进行，本机 Web 控制台用于查看进度、回答问题和中途补充信息。

**1.0.0 是首个正式版本。** 当前通过源码安装；公共 npm 包、正式安装器和自动更新尚未发布。
面向模型的工具说明使用英语，产品文档与 Web 界面使用中文。

这是对真实机器的访问，不是命令沙箱：助手使用启动服务的系统账户权限，完整继承环境变量，
包括管理员权限和已有凭据。请只连接可信的 ChatGPT 账户和下游服务；运行账户、备份与恢复环境由你管理。

## 可以做什么

- 在项目中开发、调试和运行长任务；工具可以组合执行，并在返回前筛选较大的结果。
- 导入 ChatGPT 附件、交付机器上的文件，使用本机 Skills 和下游 MCP 的工具及资源。
- 在 Web 中查看命令、补丁、终端与调用详情，按会话发送补充、回答带选项的问题，并启用浏览器系统提醒。

每个连接对应一台指定机器，不与 ChatGPT 的其他容器共享文件、进程或网络环境。
JavaScript 编排环境不直接提供文件和网络 API，但通过工具访问的机器仍有自己的文件系统与网络。

## 安装与启动

支持 Linux、Windows、macOS，CI 覆盖 Node.js 20、22、24 的真实执行和独立安装。
需要 Git、npm 和 Node.js：20.x 最低 20.19，22.x 最低 22.19；新环境建议使用 22 或 24。
[Node 20 已结束上游维护](https://nodejs.org/en/about/previous-releases)，保留兼容不等于安全维护。
Windows 需要 PowerShell 7 或 Windows PowerShell，不要求 WSL；安装依赖时需要联网。

在准备交给 ChatGPT 使用的机器上运行：

```sh
git clone https://github.com/WAcry/exec-mcp.git
cd exec-mcp
npm ci
npm run build
node dist/src/cli.js init
node dist/src/cli.js doctor
node dist/src/cli.js serve
```

`init` 创建配置并打印位置，已有文件不会覆盖；`doctor` 检查配置及本机执行组件。
`serve` 在前台运行，按 Ctrl+C 停止；它不会安装系统服务或接管其他程序。

默认地址：MCP 为 `http://127.0.0.1:8891/mcp`，Web 为 `http://127.0.0.1:8893/`。
这两个地址只供所在机器访问；ChatGPT 通过下面的 Tunnel 连接。端口冲突时修改自己的配置。

## 连接 ChatGPT

| 连接方式 | 需要准备 |
| --- | --- |
| **OpenAI Secure MCP Tunnel** | OpenAI Tunnel 权限、Runtime API key 和官方 tunnel-client；使用默认私有模式。 |
| **Cloudflare Named Tunnel** | 固定域名、cloudflared，以及 exec-mcp 的公网认证配置。 |
| **Tailscale Funnel** | 已登录的 Tailscale 节点和 Funnel 权限，以及 exec-mcp 的公网认证配置。 |

按[连接指南](docs/connections.md)选择一种方式完成配置；公网接入提供 Auth0 示例。
**不要将默认的无认证私有 MCP 端口直接转发到公网。** Web 管理界面也不会随 MCP Tunnel 自动公开。

连接后，给 ChatGPT 明确的项目路径，例如：“检查 C:/git/my-project，运行测试并修复失败。”
需要第三方 MCP 时，先在[配置中添加已有服务](docs/configuration.md#下游-mcp)。
所有启用服务都连接并验证成功后，exec-mcp 才报告就绪；需要登录的服务应先在本机完成登录。

## Web 控制台

打开启动日志中的 Web 地址，可以查看调用详情、命令与补丁原文、活动终端、内存状态、
Skills、下游工具目录，以及导出的文件。会话默认显示哈希，可手动加备注帮助辨认。
局域网首次登录后，浏览器会自动保持登录并续期；连续 30 天未访问才过期，普通服务重启不要求重新输入密钥。
退出登录、清除浏览器 Cookie 或手动换新密钥后需要重新登录。

**工作途中补充信息：**在会话组中点击“发送补充”。文字随该对话的下一次正常工具响应到达，
不会打断正在执行的命令。待发消息可撤回；ChatGPT 已结束本轮时，也可复制到原对话继续沟通。

**回答问题：**会话卡片显示待答数量与问题预览。选择任一选项都能填写额外说明，
也可以选“以上都不是”给出自己的回答；推荐项不会自动选中或提交。回答和主动补充使用同一通道。

**系统提醒：**点击右上角铃铛，启用通知并允许浏览器权限。新问题会触发提醒，点击定位对应会话；
需要保持页面打开并连接。浏览器不支持、权限被拒绝或系统勿扰时，仍可在页面查看和作答。

控制台可开关已有 MCP 和 Skill、调整已有设置并“重启执行服务”。保存配置与重启生效分开，
不提供任意命令输入框或通用配置编辑器。局域网访问和关闭 Web 的设置见[配置指南](docs/configuration.md#web-控制台)。

## 文件、Skills 与长期运行

在 ChatGPT 中附上文件并说明保存位置，或让助手把机器上的报告交付回来。
导入默认不覆盖已有文件；导出默认使用私有资源，至多 32 MiB。
更大文件可配置独立 HTTPS 下载入口，导入和 URL 导出默认单文件上限为 512 MiB。
文件链接会过期，持有公开链接的人都可下载；实际附件展示由 ChatGPT 决定，不承诺挂载到 sandbox。
详见[文件交付配置](docs/configuration.md#文件交付)。

Skills 支持用户目录与项目目录、软链接，以及启用/禁用和仅显式调用策略；
它们是现有工作流程文档，不需要额外的模型或 Skill 执行平台。详见[Skills 配置](docs/configuration.md#skills)。

运行中的状态是临时的：

| 操作 | 影响 |
| --- | --- |
| 清空调用审计 | 删除观察记录，不撤销执行；保留会话补充和问题。 |
| Web“重启执行服务” | 重建工具连接，清空临时执行、终端、store 与导出链接；保留补充、问题和备注。 |
| 停止整个 exec-mcp 程序 | 内存中的执行、消息、问题、备注和审计不恢复；不会回滚已经写入的文件或外部操作。 |

默认对执行组件采用约 4 GiB 的宽松内存压力回收，正常空闲保留 72 小时。
终端缓冲与模型输出都有上限；很大的结果会标注裁剪，重要数据应保存成文件。
补充和回答按序使用响应剩余空间，长消息可能继续排队；“已附入响应”不等于模型已读或已执行。
具体可调选项与边界见[配置指南](docs/configuration.md#容量与临时状态)。

## 升级与排障

升级前结束或保存正在进行的工作，停止自己启动的服务，在干净的源码目录中运行：

```sh
git pull --ff-only
npm ci
npm run build
node dist/src/cli.js --version
node dist/src/cli.js doctor
node dist/src/cli.js serve
```

已有配置不被覆盖。工具契约更新后，在 ChatGPT 的连接设置中刷新工具元数据；
只开一个新聊天窗口不一定更新旧描述，步骤见[连接指南](docs/connections.md#刷新与排障)。

服务启动失败时检查终端日志、配置和下游登录状态；MCP 正常而 Web 失败时，检查 Web 端口。
默认 Shell、环境代理和 token 文件轮换分别见[配置指南](docs/configuration.md)与[连接指南](docs/connections.md)。
自托管不等于数据不会离开机器：命令、代码与结果可能交给 ChatGPT 或你调用的外部服务。

## 开发与后续计划

```sh
npm run check
npm run test:package
```

检查包括测试、类型检查与构建；独立安装验证只在临时目录打包安装，不发布 npm 包。
开发者阅读[架构边界](ARCHITECTURE.md)，编码 Agent 从 [AGENTS.md](AGENTS.md) 开始，
具体调用示例见 [Code Mode 示例](docs/code-mode-examples.md)。

未交付计划见 [Backlog](docs/BACKLOG.md)，第三方归属见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
1.0.0 不改变本项目尚未授予公开开源许可的状态；公共 npm 分发需另行确定许可与发布流程。

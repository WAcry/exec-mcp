# 更新日志

[English](CHANGELOG.md) | 简体中文

## 1.0.0

exec-mcp 首个正式版本，连接 ChatGPT 与用户自行管理的机器。

Code Mode 提供 exec 和 wait，内置命令、补丁、文件传输、Skill 发现及下游 MCP 工具和资源。
工具参数、配置和下游调用的错误会指出字段和允许的取值，运行时与 CLI 消息使用英语。被信号终止的命令报告退出码 128+N。
终端会话及其未读输出有可配置的上限；没有 wait 观察的 cell 超过空闲保留期后停止。
HTTP 下游服务可以从环境变量读取凭据（bearer_token_env_var、env_http_headers）。确定没有发出的请求会重连一次，关闭 stdio 服务时也会停止它启动的子进程。
Web 控制台支持英语和简体中文，可查看调用审计、发送会话补充、回答问题、查看 ChatGPT 发来的消息并接收浏览器通知。ChatGPT 可以在首次调用时为对话命名。
会话补充、问题、消息和标题在进程重启后保留；在控制台重启执行服务时，调用审计也会保留。
支持显示服务器图标的 MCP 客户端会显示 Exec MCP 标志。
支持 OpenAI Secure MCP Tunnel、Cloudflare Named Tunnel 和 Tailscale Funnel。CI 覆盖 Linux、Windows、macOS 与 Node.js 20、22、24。

exec-mcp 采用 Apache-2.0 许可证。当前通过源码安装，公共 npm 分发仍在计划中；此记录不表示已发布 npm 包或 GitHub Release。

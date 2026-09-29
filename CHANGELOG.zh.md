# 更新日志

[English](CHANGELOG.md) | 简体中文

## 1.0.0

exec-mcp 首个正式版本，连接 ChatGPT 与用户自行管理的机器。

Code Mode 提供 exec 和 wait，内置命令、补丁、文件传输、Skill 发现及下游 MCP 工具和资源。
Web 控制台支持英语和简体中文，可查看调用审计、发送会话补充、回答问题、查看 ChatGPT 发来的消息并接收浏览器通知。ChatGPT 可以在首次调用时为对话命名。
支持显示服务器图标的 MCP 客户端会显示 Exec MCP 标志。
支持 OpenAI Secure MCP Tunnel、Cloudflare Named Tunnel 和 Tailscale Funnel。CI 覆盖 Linux、Windows、macOS 与 Node.js 20、22、24。

当前通过源码安装，公共 npm 分发仍在计划中；此记录不表示已发布 npm 包或 GitHub Release。

# Changelog

English | [简体中文](CHANGELOG.zh.md)

## 1.0.0

First stable release of exec-mcp for connecting ChatGPT to a user-operated machine.

Code Mode provides exec and wait, with nested shell commands, patches, file transfer, Skill discovery, and downstream MCP tools and resources.
Errors for tool input, configuration, and downstream calls name the field and the expected values, and runtime and CLI messages are in English. Commands stopped by a signal report exit code 128+N.
Terminal sessions and their unread output have configurable limits, and cells that no wait observes stop after the idle retention period.
HTTP downstream services can read credentials from environment variables (bearer_token_env_var, env_http_headers). A request that was never sent reconnects once, and closing a stdio service also stops its child processes.
The Web console supports English and Simplified Chinese, call auditing, and conversation notes, questions, and messages from ChatGPT with browser notifications. ChatGPT can name each conversation on its first call.
Conversation notes, questions, messages, and titles survive a process restart, and restarting execution from the console also keeps call history.
MCP clients that display server icons show the Exec MCP mark.
OpenAI Secure MCP Tunnel, Cloudflare Named Tunnel, and Tailscale Funnel are supported. CI covers Linux, Windows, and macOS on Node.js 20, 22, and 24.

exec-mcp is licensed under Apache-2.0. Installation uses the source tree. Public npm distribution remains planned; this entry does not announce an npm package or GitHub Release.

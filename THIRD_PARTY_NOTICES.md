# 第三方组件

Codex Code Mode host 和 patch engine 来自固定版本的 `@openai/codex`，
遵循该软件包附带的 Apache-2.0 许可证及 NOTICE；不随本项目重新授权。
`proto/codex.code_mode.v1.proto` 对应其 gRPC 协议，来源及许可证见
[OpenAI Codex](https://github.com/openai/codex)。

Code Mode 的 gRPC 适配与部分测试基于同一作者此前的 codex-mcp 实现重构。
其他依赖的许可证保留于各自软件包中。本项目尚未决定公开发布许可。

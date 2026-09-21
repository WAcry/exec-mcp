# 第三方组件

Codex Code Mode host 和 patch engine 来自固定版本的 `@openai/codex`，
遵循该软件包附带的 Apache-2.0 许可证及 NOTICE；不随本项目重新授权。
`proto/codex.code_mode.v1.proto` 对应其 gRPC 协议，来源及许可证见
[OpenAI Codex](https://github.com/openai/codex)。

Code Mode 的 gRPC 适配与部分测试基于同一作者此前的 codex-mcp 实现重构。
模型可见的英文工具说明与 Lark grammar 参考并部分沿用 OpenAI Codex 的
`rust-v0.155.1` 和 `6149914a0e59363b6777080b3e953b05d592dbac` 源码，
遵循其 [Apache-2.0 许可证](proto/LICENSE)；ChatGPT MCP 适配差异见 ADR-002。
Skill 目录的公平描述预算与路径别名算法参考并改写自 OpenAI Codex
`7498521d288b9b3b96ffba4eedf089d8d6e06a84` 的
[`render.rs`](https://github.com/openai/codex/blob/7498521d288b9b3b96ffba4eedf089d8d6e06a84/codex-rs/ext/skills/src/render.rs) 和
[`aliases.rs`](https://github.com/openai/codex/blob/7498521d288b9b3b96ffba4eedf089d8d6e06a84/codex-rs/ext/skills/src/aliases.rs)。
这些参考代码遵循 [Apache-2.0](proto/LICENSE)，相关源码属于 OpenAI Codex 贡献者；
本项目只移植必要算法并调整调用策略、预算回退与路径发现，不修改或重新分发一份 Skill Loader 二进制。
其他依赖的许可证保留于各自软件包中。本项目尚未决定公开发布许可。

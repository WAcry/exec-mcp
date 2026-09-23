# Backlog

[English](backlog.md) | 简体中文

这里记录用户已提出、尚未交付且暂缓实现的计划。开始开发仍需另行授权，
当前功能以代码、[README](../README.zh.md) 和生效 ADR 为准。条目只写目标与必要的前置条件，计划变化时同步更新。

## 公共 npm 安装

目前尚未公开发布 npm 包。计划通过公共 npm registry 分发，让用户用 npm install 安装后从命令行启动。
Windows、macOS、Linux 共用这一方式，暂不提供额外的桌面安装器。
1.0.0 当前通过源码构建使用，[README](../README.zh.md) 保留相应步骤。

公开发布前需要确定许可、包名和发布权限，并验证从公共 registry 安装后的启动过程。
现有 CI 已覆盖独立打包安装与跨平台执行，公共分发还需单独验证。

Web 控制台、Cloudflare/Tailscale 接入及异步提问与通知已经交付，相关用法见 [README](../README.zh.md)。

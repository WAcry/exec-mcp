# ADR-008 个人实例的环境继承、代理与 Node 20

[English](008-environment-and-proxy.md) | 简体中文

当前生效，2026-09-22 更新。

## 完整继承环境

实例由受信任的个人部署和使用。Shell/PTY、下游 stdio MCP、Code Mode host 和补丁进程
都继承服务进程的完整环境，不按变量名称或值建立 allowlist/denylist。
仅忽略 undefined，显式 env 配置覆盖同名值，Windows 按大小写不敏感规则处理。
PTY 使用完整副本，PWD/TERM 等字段仍由终端按原生规则维护。
服务不主动输出整个环境，用户明确执行的命令结果也不作环境变量脱敏。

默认 login=false，继承环境无需加载 profile。profile 可能覆盖 PATH 或代理，
也可能输出文字或等待输入，需要这些行为的调用者可通过配置或单次参数启用。

## 本服务的 HTTP 代理

下游 HTTP MCP 的 SDK 请求，包括协商和 SSE，以及原生附件下载，共用 Undici 环境代理 transport。
它读取 HTTP_PROXY、HTTPS_PROXY、NO_PROXY 及小写名称，小写优先；
HTTPS_PROXY 缺失时继承 HTTP_PROXY，NO_PROXY 支持主机、域名后缀、端口及 *。
各 Node 版本使用相同策略，无需额外启用 NODE_USE_ENV_PROXY。

代理只用于本服务的请求，不全局替换 fetch/HTTP agent 或注入 NODE_OPTIONS。
TLS 证书和主机名校验保持开启，私有 CA 通过 NODE_EXTRA_CA_CERTS 配置。
代理凭据仅发给代理，目标服务及错误提示均不接收它。代理失败就返回错误，不直连重放请求，
以免重复产生副作用；取消调用或关闭服务时释放连接。

附件保持 HTTPS 和原始字节流传输，遵循大小、取消与禁止重定向的规则。
直连时由自定义 DNS lookup 固定已验证的公网地址。使用代理时，目标解析和路由交给该代理，
本机无需具备外网 DNS，也无法控制代理的解析结果。字面量私网或本机地址仍不得用作宿主附件来源。

Code Mode gRPC 是父子进程间的回环 IPC，始终直连，服务环境变量保持不变。
用户配置的下游 localhost HTTP 地址仍按 NO_PROXY 处理，服务不隐式增加例外。

## 子进程与 Tunnel

用户子进程取得完整代理变量，是否采用由自身网络栈决定。
exec-mcp 不修改用户代码或网络 API，也不安装透明转发层；需要统一路由所有流量时，
应由用户设置系统网络。忽略代理的程序和 UDP 等流量需按各自方式处理。

OpenAI tunnel-client 由用户独立运行，也可通过 with-token 显式启动并注入凭据。
该包装保留 profile 与已有进程，网络代理能力由供应商客户端决定。
文件下载响应通过入站连接返回给用户，不再发起出站连接。

## Node 20 兼容

支持 Node 20.19+，与 Node 22/24 共用实现。代理采用兼容 Node 20 的 Undici 7，
文件类型识别采用 file-type 21。类型检查和真实二进制测试共同验证兼容性。
Node 20 已结束上游维护，本项目保留兼容，新部署应选择仍受维护的版本。
固定 Codex 组件、Shell 行为和资源限制保持原样，当前不增加代理管理工具或 UI。

相关接口见 [Node 企业网络配置](https://nodejs.org/en/learn/http/enterprise-network-configuration)、
[Undici 环境代理](https://github.com/nodejs/undici/blob/v7.29.1/docs/docs/api/EnvHttpProxyAgent.md) 和
[Node 版本状态](https://nodejs.org/en/about/previous-releases)。

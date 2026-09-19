# ADR-008：个人实例的环境继承、代理与 Node 20

状态：生效。日期：2026-09-18。

## 继承环境，不制造秘密隔离

实例由受信任的个人部署并使用。Shell/PTY、下游 stdio MCP、Code Mode host、补丁进程都继承
服务进程的完整环境，不按变量名称、API key、代理、函数样式值做 allowlist/denylist。
只忽略不存在的 undefined 值；下游的显式 env 配置按字段覆盖继承值，Windows 遵循大小写不敏感语义。
给 PTY 的是完整副本，避免依赖对 process.env 对象做特殊清洗；终端本身维护 PWD/TERM 等原生行为不改写。
不为了证明继承而把全部环境预先展示给模型或写日志，但也不对用户明确执行的命令结果做环境变量脱敏过滤。

登录模式和继承不是同一件事。保留 login=false 默认与已有配置/单次覆盖：
继承已有环境不需要执行 profile；默认加载 profile 反而可能覆盖 PATH/代理、输出启动文字或等待输入。
需要 profile 的用户显式启用，不为本次需求改变所有既有命令的启动副作用。

## 本服务的外部 HTTP 尊重用户代理

下游 HTTP MCP 的所有 SDK 请求（包括连接协商和 SSE）以及原生附件下载，统一使用受生命周期管理的
Undici 环境代理 transport。读取 HTTP_PROXY/HTTPS_PROXY/NO_PROXY 及小写形式，按库语义小写优先；
HTTPS_PROXY 缺失时可继承 HTTP_PROXY，NO_PROXY 支持主机、域名后缀、端口和 *。
不在不同 Node 版本间切换不同代理策略，不依赖用户额外设置 NODE_USE_ENV_PROXY，
不全局替换 fetch/HTTP agent，不注入 NODE_OPTIONS，也不禁用 TLS 证书或主机名校验。
私有 CA 可使用 Node 的 NODE_EXTRA_CA_CERTS，代理凭据只用于代理，不转发给目标或写进错误提示。
代理失败不能悄悄直连重放可能有副作用的请求；调用取消和服务关闭要释放连接。

文件下载保持 HTTPS、无跳转、原始字节流、显式大小与取消规则。
直连由自定义 DNS lookup 固定已验证的公网地址；使用代理时由用户指定的受信任代理解析目标，
不能再要求本机也有外网 DNS，也不声称客户端能约束代理的 DNS/路由。
字面量私网/本机目标仍不作为宿主附件下载地址接受；这些文件来源规则不是环境变量过滤。

本地 Code Mode gRPC 只是父进程到自有子进程的回环 IPC，明确直连，不把它转交给 HTTP 代理。
这不修改环境，也不对用户指定的下游 localhost HTTP 地址做隐式 NO_PROXY；需要绕过时由用户设置。

## 环境代理不是系统级流量劫持

所有用户子进程都会取得完整代理变量，但是否采用由各自网络栈决定；不能仅靠继承变量强迫任意
Node/Python 程序、PowerShell、UDP 或忽略代理的二进制都走 HTTP 代理。
不偷偷给用户代码注入预加载脚本、替换网络 API 或安装透明转发层；确需所有流量统一路由，应使用系统级网络配置。
OpenAI tunnel-client 当前是用户另外启动的程序，应在同一代理环境中启动，并按其支持的协议配置；
本服务不启动、重配或代理接管该进程。资源/URL 下载对用户的响应则是入站请求的返回路径，不是本服务新发起的外部连接。

## Node 20 兼容，不倒退到过时的运行时 API

支持 Node 20.19+；测试矩阵加入 Node 20，与 Node 22/24 共用实现。
代理使用兼容 Node 20 的 Undici 7 分支；文件类型识别选用支持 Node 20 的 file-type 21，
并用 Node 20 类型和真实二进制验证，而不只是修改 engines 后宣称支持。
Node 20 在上游已经结束维护；这是兼容承诺，不是推荐新部署继续选用 EOL 版本。
保留现有 Codex 固定组件、Shell 行为、工具数量与资源边界，不添加新的代理管理工具或 UI。

参考：[Node 企业网络配置](https://nodejs.org/en/learn/http/enterprise-network-configuration)、
[Undici 环境代理](https://github.com/nodejs/undici/blob/v7.29.1/docs/docs/api/EnvHttpProxyAgent.md)、
[Node 版本状态](https://nodejs.org/en/about/previous-releases)。

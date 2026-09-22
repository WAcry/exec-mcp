# ADR-007：默认命令 Shell 与单次覆盖

状态：生效。更新：2026-09-22。

## 稳定的默认值，可选的逐调用覆盖

config.toml 的 execution.shell / execution.login 决定实例默认值；exec_command 同名可选参数
仅覆盖本次新建进程。普通调用继续只提交命令，必要时直接指定 Shell，而不是在命令字符串中多套一个解释器。
采用固定参考版本 rust-v0.155.1 的
[Direct exec_command](https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/core/src/tools/handlers/unified_exec.rs)
支持的 shell/login 参数形状，不引入本地 zsh-fork、App Server 或其他执行模式。

shell 与 login 独立取值：显式参数优先，省略的字段继承实例配置；只换 shell 不改变继承的 login，
显式 login=false 可以覆盖配置的 true。保留原有 login=false 默认，不因恢复参数而突然加载 profile。
Codex 的 allow_login_shell 同时参与默认值和限制判断；本服务的 execution.login 只是默认值，
不是权限开关，不为此次兼容新增 allow_login_shell 或把 false 变成禁止单次 true。

默认可执行路径在创建运行时时解析一次，执行器和目录说明共用它；单次选择是独立不可变值，
不写回配置或后续命令，也不改变同一 exec 中并发运行的其他命令。
write_stdin 继续操作原 session_id 对应的进程，不用后来命令的 Shell 重新解释输入或重建进程。

## 默认选择、路径与启动

Windows 自动选择仍优先 pwsh.exe（通常是 PowerShell 7），其次 Windows PowerShell；检查 PATH 和标准安装位置，
不把 CMD、Git Bash 或 WSL 作为自动回退。macOS/Linux 优先可用的 SHELL；
macOS 再尝试 /bin/zsh、/bin/sh，Linux 回退 /bin/sh。

配置路径相对配置文件目录解析；逐调用路径相对最终命令 workdir 解析（包括 exec_command.workdir 的覆盖）。
裸名称从服务 PATH 查找，~/ 指服务账户主目录；不将工作目录中的同名文件当作 PATH 命中。
保留可执行文件的软链接名称，不通过 realpath 改变 sh 等依赖 argv[0] 的启动语义。
显式配置无效则启动失败，单次覆盖无效则不创建命令进程；启动或执行失败都不换 Shell 自动重试。

直接启动文件并传入参数数组；不增加 cmd.exe /c，不要求 Agent 编 Base64，也不自动改写脚本语义。
PowerShell 在所有平台使用自己的参数，Windows 保留现有 UTF-8 控制台设置。
login 对 PowerShell 表示是否加载 profile，对其他 Shell 表示是否使用 login 模式；
不声称 false 会禁止 zshenv、BASH_ENV 等原生启动规则。PTY 仅分配终端，不自动启用交互 Shell 或 profile。
自定义 Shell 使用 -c/-lc 接口，仍不支持 CMD/批处理作为执行入口；不因 Direct 参数兼容而扩大这些原有边界。

## 描述只提供调用必需的信息

常用 Shell 的英文描述说明默认名称和配置模式，而不是暗示每一次调用必然使用它；未知类别保持通用执行说明。
参数说明只讲本次覆盖、路径基准和省略行为，不增加探测教程、环境清单、用其他 Shell 的教程或新工具。
同一运行时契约生成 exec 描述和 ALL_TOOLS 条目。单次覆盖不刷新全局工具说明；修改配置才需要重启并刷新客户端目录。

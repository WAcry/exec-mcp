# ADR-007：配置级命令 Shell

状态：生效。日期：2026-09-18。

## 一个实例使用一种命令语言

Shell 可执行文件和启动模式由 config.toml 的 execution.shell / execution.login 决定，
不再作为 exec_command 的逐调用参数。多数任务使用同一种 Shell，把环境选择留给操作者，
让 Agent 只提交命令、目录及进程交互参数，避免同一会话的命令语言和环境无意切换。

这不是声称 Codex 没有 shell 参数：固定参考版本 rust-v0.155.1 的
[Direct exec_command](https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/core/src/tools/handlers/unified_exec.rs)
支持 shell/login，而本地 zsh-fork 不允许 shell 覆盖。
我们保留 Codex 的命令、PTY 与会话调用习惯，但有意缩小环境选择接口；不为机械镜像引入无实际需求的选项。

服务创建运行时时解析一次可执行文件路径，同时生成工具契约与执行器，后续不按项目目录或 PATH 变化重新选 Shell。
显式配置无效则启动失败；命令启动或执行失败不换 Shell 自动重试，防止语法变化和重复副作用。
只选择可执行文件，不执行探测脚本、加载用户 profile 或安装 Shell 来猜测版本。

## 默认选择与启动

Windows 优先 pwsh.exe（通常是 PowerShell 7），然后 Windows PowerShell；检查 PATH 和标准安装位置，
不把 CMD、Git Bash 或 WSL 作为自动回退。macOS/Linux 优先继承的 SHELL；无可用选择时，
macOS 回退 /bin/zsh，再到 /bin/sh；Linux 回退 /bin/sh。用户配置可以覆盖这些默认值。
配置中的裸名称从服务 PATH 查找，路径相对配置文件解析；保留可执行文件的软链接名称，
不通过 realpath 改变 sh 等依赖 argv[0] 的启动语义。

直接启动文件并传入参数数组；不增加 cmd.exe /c、不要求 Agent 编 Base64，也不把命令拼进二次 Shell。
PowerShell 在所有平台都使用 PowerShell 参数，Windows 保留现有 UTF-8 控制台设置。
默认 login=false；对 PowerShell 表示不加载 profile，对其他 Shell 表示非 login，
不声称这会禁止 zshenv、BASH_ENV 等原生启动规则。PTY 只分配终端，不自动启用交互 Shell 或 profile。
自定义 Shell 使用 -c 或 -lc 接口，保留其原生退出码与错误语义；仍不支持 CMD/批处理作为执行入口。

## 描述只提供调用必需的信息

已识别的常用 Shell 在 exec_command 描述首句显示名称，未知类别只写“运行 Shell 命令”。
不增加环境探测工具、完整环境清单、探索建议或替代 Shell 的使用教程。
同一份运行时契约生成 exec 描述和 ALL_TOOLS 条目，不使用另一套可能不一致的静态说明。
修改配置需要重启并刷新客户端工具目录；不提供热切换或为旧会话维护兼容别名。

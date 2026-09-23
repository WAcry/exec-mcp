# ADR-007 默认命令 Shell 与单次覆盖

[English](007-command-shell.md) | 简体中文

当前生效，2026-09-22 更新。

## 默认配置与单次参数

config.toml 的 execution.shell 和 execution.login 决定实例默认值，exec_command 的同名参数
只覆盖本次新建进程。普通调用只需提交命令，切换 Shell 时可直接传参数，减少命令中的解释器嵌套。
参数形状参考固定 rust-v0.155.1 的
[Direct exec_command](https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/core/src/tools/handlers/unified_exec.rs)，
不引入 zsh-fork、App Server 或其他执行模式。

shell 与 login 各自独立覆盖，显式参数优先，省略的字段继承实例配置。
只换 shell 时 login 不变，显式 login=false 也可覆盖配置中的 true。默认继续使用 login=false。
Codex 的 allow_login_shell 同时控制默认值和权限，本服务的 execution.login 只给出默认值，
单次调用仍可设为 true，因此不增加 allow_login_shell。

默认可执行路径在创建运行时时解析一次，执行器与说明共用结果。单次选择独立保存，
不会改动配置、后续命令或并发命令。write_stdin 继续操作原 session_id 的进程，
输入由原 Shell 处理，不因后来命令更换 Shell 而重建。

## 路径与启动

Windows 优先查找 pwsh.exe，通常为 PowerShell 7，其次查找 Windows PowerShell，
检查 PATH 及标准安装位置；CMD、Git Bash 和 WSL 不作自动回退。
macOS/Linux 优先可用的 SHELL，失败后 macOS 尝试 /bin/zsh、/bin/sh，Linux 使用 /bin/sh。

配置中的相对路径基于配置文件目录，单次参数中的相对路径基于命令最终 workdir。
裸名称从服务 PATH 查找，~/ 指服务账户主目录；工作目录中的同名文件不会额外加入 PATH 查询。
可执行文件保留软链接名称，使 sh 等依赖 argv[0] 的程序维持原启动语义。
显式配置无效时启动失败，单次覆盖无效时不创建进程；失败后不自动换 Shell 重试。

执行器直接启动可执行文件并传参数数组，省去 cmd.exe /c 或 Base64 包装，脚本内容保持原样。
PowerShell 在各平台使用自己的参数，Windows 保留现有 UTF-8 控制台设置。
login 对 PowerShell 控制 profile 加载，对其他 Shell 控制 login 模式；
login=false 时，zshenv、BASH_ENV 等 Shell 自身的启动规则仍可能生效。PTY 只分配终端，交互模式和 profile 不自动改变。
自定义 Shell 使用 -c/-lc 接口，当前仍不支持 CMD 或批处理入口。

## 动态说明

常用 Shell 的英文描述显示默认名称和配置模式，未知类型使用通用执行说明。
参数描述写清单次覆盖、路径基准和省略行为；环境探测或切换教程留给按需查阅的示例。
同一契约生成 exec 描述和 ALL_TOOLS 条目。单次覆盖不刷新全局说明，
配置更改后才需重启服务并刷新客户端目录。

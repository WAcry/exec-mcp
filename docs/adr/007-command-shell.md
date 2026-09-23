# ADR-007 Default shells and per-command overrides

English | [简体中文](007-command-shell.zh.md)

Active, updated 2026-09-22.

## Instance defaults and call parameters

execution.shell and execution.login in config.toml define instance defaults. The same parameters on exec_command override only the newly created process.
An ordinary call needs just a command. A shell override avoids another interpreter nested inside the command text.
The parameter shape follows [Direct exec_command](https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/core/src/tools/handlers/unified_exec.rs)
in pinned rust-v0.155.1, without introducing zsh-fork, App Server, or another execution mode.

shell and login override independently. Explicit values win; omitted fields inherit configuration.
Changing only shell retains login, and explicit login=false overrides a configured true. The default remains login=false.
Codex's allow_login_shell controls both defaults and permission. This service's execution.login is only a default,
so calls may still set it to true, and there is no additional allow_login_shell option.

Resolve the default executable once at runtime creation and share it between execution and descriptions.
Per-call choices do not change configuration, later commands, or concurrent commands.
write_stdin continues the process identified by its original session_id. Its original shell handles input; later shell choices do not rebuild that terminal.

## Path resolution and launch

Windows first looks for pwsh.exe, normally PowerShell 7, then Windows PowerShell, checking PATH and standard installation locations.
CMD, Git Bash, and WSL are not automatic fallbacks.
macOS/Linux prefer a usable SHELL. Otherwise macOS tries /bin/zsh and /bin/sh; Linux uses /bin/sh.

Relative configured paths resolve from the configuration directory. Relative per-call paths resolve from the command's final workdir.
Bare executable names use the service PATH. ~/ refers to the service account's home; same-named files in workdir are not implicitly added to PATH lookup.
Keep symlink executable names so programs such as sh retain argv[0]-dependent behavior.
An invalid configured shell fails startup; an invalid override creates no process. Neither case retries with a different shell.

Launch the executable directly with an argument array, without cmd.exe /c or Base64 wrappers, and keep the script text intact.
PowerShell uses its own launch arguments on each platform; Windows retains the existing UTF-8 console setup.
login controls profile loading for PowerShell and login mode for other shells.
With login=false, shell-specific rules such as zshenv or BASH_ENV may still apply. PTY allocation does not itself change interactive mode or profile behavior.
Custom shells use a -c/-lc interface. CMD and batch-file entry points remain unsupported.

## Dynamic descriptions

English descriptions for common shells show the resolved default name and mode. Unknown shell types use generic execution wording.
Parameter descriptions explain per-call overrides, path bases, and omission behavior. Environment discovery and switching examples stay in optional documentation.
The same contract generates the exec description and ALL_TOOLS entry. A per-call override does not refresh global descriptions;
configuration changes require restarting the service and refreshing the client catalog.

# ADR-001 Runtime and product scope

English | [简体中文](001-exec-runtime.zh.md)

Active, updated 2026-09-22.

## Rationale

exec-mcp is deployed by ChatGPT users on their own machines. Each connection targets one user-selected remote machine.
Local in a tool description means that machine, independent of ChatGPT's other containers.
The orchestration JS has no direct filesystem or network APIs; shells and other tools access files and networks with the machine account's permissions.

The interface follows Codex and gives JavaScript responsibility for composing calls and filtering results. User testing on 2026-09-22 observed no fixed per-turn tool-call count cap;
the amount of work completed in a turn was constrained by the overall workload. This observation guides the product's efficiency decisions.
We assume neither a fixed call count nor unlimited host execution. The host's internal budget algorithm and thresholds are outside this service's contract.

An agent can call several tools sequentially or concurrently in one exec, process their results, and return only what the model needs.
Combining round trips and filtering results can reduce orchestration and repeated-context tokens. Parallel independent work can shorten waiting
and leave room for more useful work in a turn. Benefits depend on the task and output choices and must be measured.

## Tool entry points and ordering

Only exec and wait are top-level MCP tools. Local operations and downstream MCP methods are bound to tools.* inside exec.
The exec description contains complete local contracts; ALL_TOOLS exposes downstream contracts as needed. No hidden direct entry points remain.
Code Mode Only follows the target Codex models' interaction pattern and gives output a common handling path.
PowerShell, nested templates, and Markdown still make string construction harder. Descriptions briefly identify the language boundaries, with longer examples in documentation.
Strings use ordinary JavaScript syntax; the server does not guess at or repair their content.

Independent calls can run through Promise.all. Data dependencies or conflicting side effects require appropriate ordering,
with error handling and retry conditions retained for each operation.

Local execution methods include tools.exec_command, tools.write_stdin, tools.apply_patch, and tools.view_image.
See [ADR-002](002-tool-discovery.md) for discovery. Reading, searching, and Git/worktree operations use system tools at the caller's direction.
There is no separate project or task manager.

## Directories and patches

exec.source contains JavaScript, while the outer MCP arguments are an object. exec.workdir supplies the default directory for local tools in that call.
Omitting it uses the service account's home; a relative value also resolves from that home. Relative paths in local tools resolve from the call's directory.
A command may override its directory. A shell's cd affects only its process; downstream MCP paths and parameters retain their own semantics.

tools.apply_patch accepts a complete patch string and sends it through stdin to the pinned engine, avoiding command-line argument limits.
The outer MCP object contains source/workdir/files. Nested methods retain their own parameter shapes without separate direct-call wrappers.

Patches use Codex's syntax and engine, with the full grammar in the tool description. A multi-file patch can partially succeed,
so callers must check its result. The service does not generate additional snapshots or line counts for a diff UI.

## Components and platforms

TypeScript/Node handles MCP, configuration, downstream connections, and platform adaptation. JavaScript and patch execution reuse components
from the same pinned Codex version, and MCP uses the official SDK. The integration excludes the full Codex App Server and model loop;
it does not read the installed Codex configuration or database. Component upgrades are explicit dependency changes with contract validation.
See the [Apache-2.0 text](../../proto/LICENSE) for the components and protocol. Retain licenses and NOTICE files shipped with dependencies.

Windows, Linux, and macOS are product targets; Windows uses native execution.
Platform adapters handle system paths, shells, PTYs, process trees, and installation locations.
[ADR-007](007-command-shell.md) covers default shells and overrides. Execution and descriptions share the resolved shell.
Validate the host, patch entry point, and process cleanup on each platform. Bash, POSIX signals, and systemd apply only where available.
Exact OS/CPU support and version pins follow the implementation and validation for the corresponding release.

## Product scope

An optional Web management console is available under [ADR-009](009-web-console.md). It runs separately from ChatGPT,
with no embedded Widget or downstream sign-in interface. User decisions can be discussed in ChatGPT or submitted as asynchronous questions
to that conversation's Web view. Answers and unsolicited notes share the User Note path under [ADR-010](010-session-notes.md).
Question submission returns immediately. There is no synchronous wait for the user, answer-polling tool, or answer database.

Local Skills provide metadata discovery only; the existing shell reads their full content under [ADR-006](006-skill-catalog.md).
Skill installation and execution management, workspaces, subagents, persistent tasks, and scheduling frameworks are outside the current scope.
Output helpers can explicitly send native images and audio. exec orchestrates files under [ADR-005](005-file-transfer.md).

## Accepted costs

Including complete local contracts makes the exec description longer, while letting a fresh agent use common tools immediately.
Every model-facing operation depends on the native host; commands and file operations are also unavailable when it is down.
Binary reuse reduces implementation work and requires protocol and version compatibility maintenance. Reuse parts of the old codex-mcp as needed,
while validating cancellation, result fidelity, and connectivity. Adopt old product constraints only through an explicit decision.

## Source references

Reference snapshot `8b78600dc85cc265d7e7e827f6aa903875405287` of Codex.
Its [patch tool](https://github.com/openai/codex/blob/8b78600dc85cc265d7e7e827f6aa903875405287/codex-rs/core/src/tools/handlers/apply_patch_spec.rs)
is freeform; [Code Mode contract conversion](https://github.com/openai/codex/blob/8b78600dc85cc265d7e7e827f6aa903875405287/codex-rs/code-mode-protocol/src/description.rs)
maps it to a string argument.
The [platform packaging script](https://github.com/openai/codex/blob/8b78600dc85cc265d7e7e827f6aa903875405287/codex-cli/scripts/build_npm_package.py)
is a reference for upstream distribution. exec-mcp's platform support needs its own validation, and project dependencies explicitly pin the runtime version.

# Configuration and operation

English | [简体中文](configuration.zh.md)

Use this guide when installing or maintaining exec-mcp. Add the relevant sections to the same config.toml.
Start with the [README](../../README.md); the [connection guide](connections.md) covers tunnels, Auth0, and token files.

## Configuration file

init creates configuration and prints its location, preserving existing files. Default locations follow the platform.

| Platform | Location |
| --- | --- |
| Linux | `$XDG_CONFIG_HOME/exec-mcp/config.toml`, or `~/.config/exec-mcp/config.toml` when unset |
| macOS | `~/Library/Application Support/exec-mcp/config.toml` |
| Windows | `%APPDATA%\exec-mcp\config.toml` |

init, doctor, serve, and tunnel accept `--config PATH` or the EXEC_MCP_CONFIG environment variable.
Home means the account running the service. exec-mcp does not read another Codex/MCP product's configuration.
Configuration may contain credentials; keep it in a private directory.

The default configuration uses private ingress.

```toml
[server]
access = "openai-tunnel"
host = "127.0.0.1"
port = 8891
```

This configuration has no additional application authentication and is only for a trusted OpenAI private tunnel.
Public ingress uses the [public-mode configuration](connections.md#configure-authentication-before-public-access).
serve uses the specified port and reports conflicts without affecting other processes. /readyz checks local MCP readiness.
Configuration changes usually require restarting the execution service. Changes to tool descriptions also require refreshing ChatGPT's connection metadata.

## Downstream MCP

Local stdio and HTTP services can be configured together.

```toml
[mcp_servers.local]
command = "node"
args = ["/absolute/path/to/mcp-server.js"]
# cwd = "/absolute/path/to/project"
# env = { CUSTOM_SETTING = "value" }

[mcp_servers.remote]
url = "https://example.com/mcp"
headers = { Authorization = "Bearer REPLACE_ME" }
```

Each service chooses command or url. stdio supports args, cwd, and env; HTTP supports headers.
A relative stdio cwd resolves from the configuration directory. Executable names are found on the service environment's PATH.

Both transports support these options in their service section.

| Option | Purpose |
| --- | --- |
| enabled | Defaults to true; false keeps the service stopped. |
| enabled_tools | Omit to load all tools, provide an array to select names, or use an empty array to bind none. Does not filter resources. |
| startup_timeout_sec | Defaults to 30 seconds for connection, negotiation, and all tool-catalog pages. Slow startup can use 120 or 300. |
| tool_timeout_sec | Defaults to 120 seconds for downstream tools and resources, timed independently of outer wait. |

**MCP becomes available only after every enabled service is ready.** Address, authentication, catalog, or contract errors fail startup.
Disable unused services in configuration. Startup checks do not invoke tools or prefetch all resource contents.

Complete vendor sign-in on the machine and configure the environment or headers before starting exec-mcp.
stdio diagnostics stay in the terminal. Generic downstream OAuth sign-in/refresh and ChatGPT login widgets are not provided.
ChatGPT's Auth0 ingress and downstream credentials are configured separately.

Resource-only services are supported. Inspect tool contracts through ALL_TOOLS as needed, and see [Code Mode examples](code-mode-examples.md#mcp-resources)
for resource lists, templates, and reads. Repair failed connections locally; already-sent operations are not replayed automatically.

## Command shell

Windows prefers PowerShell 7 (pwsh), then Windows PowerShell. It does not require WSL or install a shell automatically.
macOS/Linux prefer a usable $SHELL; otherwise macOS tries /bin/zsh and /bin/sh, while Linux uses /bin/sh.

```toml
[execution]
shell = 'C:\Program Files\PowerShell\7\pwsh.exe'
login = false
```

Use an executable name or path such as pwsh, bash, or /bin/zsh. Relative configured paths resolve from the configuration directory, with ~/ support.
Specify the executable alone, without command arguments. CMD and batch files are not shell entry points.

The default login=false skips PowerShell profiles and uses non-login mode for other shells, while preserving shell-specific startup-file rules.
login=true loads PowerShell profiles or enables other shells' login mode. PTY allocation alone does not change it.
Environment inheritance does not require profiles; enable them when the workflow needs them.

Agents can override shell and login independently for a single command without changing defaults or existing terminals.
Per-call relative shell paths resolve from the command's directory. Invalid configuration or overrides fail without retrying under another shell.
Tool descriptions show the instance default shell. After changing configuration, restart and refresh ChatGPT's connection metadata.

## Environment and proxies

Shells, PTYs, and downstream children inherit the entire service environment, including credentials and proxy variables. Explicit downstream env entries override matching values only.
The service does not proactively print the environment or prevent trusted commands from reading or printing it.

HTTP MCP, resource requests, attachment downloads, and JWT public-key fetches initiated by the service respect HTTP_PROXY, HTTPS_PROXY, and NO_PROXY,
including lowercase names, which take precedence. HTTPS_PROXY falls back to HTTP_PROXY when absent. HTTP and HTTPS proxies are supported, without silent direct fallback.
NO_PROXY accepts hosts, domain suffixes, ports, and *, such as `localhost,127.0.0.1,[::1],.internal.example`.
Node 20/22/24 need no NODE_USE_ENV_PROXY setting. Private CAs use NODE_EXTRA_CA_CERTS.

Set proxy variables before startup and restart after changes. Child processes and tunnel clients inherit them but decide whether to honor them through their own network stacks.
Use system networking when you need consistent routing for browsers, user scripts, or UDP.
Loopback communication between execution components bypasses external HTTP proxies.

## Skills

Discovery always includes the service account's ~/.agents/skills/ and ~/.codex/skills/.
When a project is specified, it walks upward to the nearest Git root for .agents/skills/, including worktrees. Without a Git root, it checks only the specified directory.
Directory and file symlinks are supported, with deduplication by real file. Different files sharing a name remain separate.
Discovery returns metadata first; the assistant reads full content as needed.

```toml
[skills]
max_chars = 40000

[[skills.config]]
name = "release"
enabled = false

[[skills.config]]
path = '~/projects/my-project/.agents/skills/release/SKILL.md'
enabled = true
```

Skills without configuration are enabled. Each rule requires enabled and exactly one of name or path.
name exactly matches all same-named items. path selects one SKILL.md and supports paths relative to the configuration directory, ~/, and symlinks.
The last matching rule wins. The example disables every release Skill, then enables one file. Enabling never expands the discovery scope.

For a workflow that should run only when the user names it, set this in its agents/openai.yaml.

```yaml
policy:
  allow_implicit_invocation: false
```

The catalog then lists only its name and path, marked for explicit user invocation, without a trigger description.
Configuration toggles control visibility; invocation policy guides model selection. The shell still reads according to OS permissions.
Rediscover after changing Skill files. Restart after changing exec-mcp configuration. Codex's own enable/disable configuration is neither read nor modified.

max_chars counts Unicode code points. Catalog rendering also adapts to the model-response byte budget; exact token counts depend on the model.
Large catalogs first shorten path representation and description prefixes while retaining names, paths, and policy.
An extreme minimum catalog may still exceed the budget. One response cannot promise to display arbitrarily many Skills; actual output explains compression or truncation.

## Web console

The interface supports English and Simplified Chinese. It selects the first supported browser language preference, with English as fallback.
Browsers commonly inherit OS language preferences. The service machine's language does not determine the UI language.
Expand Interface preferences under Settings to choose Auto, English, or Simplified Chinese. The login page has a language icon.
Changes apply immediately without editing config.toml or restarting.
Manual choices are saved in this site's localStorage and synchronized across same-origin tabs. If storage is blocked, the current page can still switch.
Dates and numbers follow the interface language, while time zones stay local to the browser. User content and raw diagnostics remain unchanged.

The Web defaults are as follows.

```toml
[web]
enabled = true
host = "127.0.0.1"
port = 8893
```

enabled=false disables the UI and audit collection. Web startup failure also stops collection, while MCP remains usable.
Web configuration toggles edit only existing MCP services, discovered Skills, login, and Web enabled. Save, then restart execution to apply them.
Restart failure leaves the management page available for repair. Temporary execution, terminals, export links, and old audit records are not restored.

For LAN access, set host explicitly to `0.0.0.0` or `::` and visit the machine's actual IP or hostname.
Use the startup access token or a link containing #token=… for the first sign-in. The browser then removes that token from the address bar.
The HttpOnly login cookie survives browser closure, refresh, and ordinary service restart. Console visits renew it; it expires after 30 days without a visit.
It applies to the browser and host where saved. Private browsing or clearing site data removes it.
Signing out clears this browser's cookie. Rotating the key locally invalidates all old sign-ins, links, and event streams.

Web credentials are kept beside the configuration in `.exec-mcp/<config-filename>.web-token`, using lightweight token-file encryption without changing config.toml.
The browser stores only a signed cookie. First creation or rotation needs a writable directory; corrupt credentials produce an error.
Preserve this private file to retain sign-in across restarts. Deleting it causes a new key at startup and invalidates old sign-ins.
The LAN UI currently uses HTTP and is suitable only for trusted networks. MCP tunnels do not publish it automatically, and it should not be exposed directly to the internet.

System notifications need browser permission and a secure context, such as loopback or protected HTTPS. Plain HTTP LAN addresses may not support them.
Closed pages, disconnected streams, or Do Not Disturb can prevent alerts. Questions remain available when the page is opened again.

Audit records are temporary observations, retaining the latest 10,000 calls by default. Individual records are also bounded, and large content is marked truncated.
Counts cover retained records only. Audit truncation leaves actual calls unchanged.
Configuration hides credential values, but commands and results may contain sensitive data. Treat the console as a high-privilege page.

## File delivery

Import processes only attachments bound in this call and selected by the assistant, preserving existing targets by default.
Export creates an independent snapshot unaffected by later source edits. Private resource delivery supports up to 32 MiB; the host controls display and mounting.

To download larger files in a browser, prepare a separate HTTPS endpoint and add this configuration.

```toml
[files]
ttl_seconds = 3600
max_file_bytes = 536870912
max_export_bytes = 4294967296

[files.download]
base_url = "https://downloads.example.com/files"
port = 8892
```

Replace the base URL with your real HTTPS address and proxy the entire request path to `http://127.0.0.1:8892`.
This endpoint serves explicit exports only; do not route it to MCP port 8891. It needs separate configuration.
public_url serves MCP only, and OpenAI private tunnels do not offer general browser downloads.

After configuration, ask the assistant to choose URL delivery. Defaults are 512 MiB per file, a 4 GiB snapshot quota including overhead, and a one-hour lifetime.
Any link holder can download or forward it. Keep the machine and endpoint online.
Web revocation stops future access; downloads already started or completed cannot be recalled. Restarts invalidate links.
Normal shutdown and expiry clean up snapshots. Abnormal exits may leave system temporary files, without reviving old links.

## Capacity and temporary state

```toml
[memory]
code_mode_high_water_mib = 4096
idle_retention_hours = 72
terminal_buffer_mib = 16
```

The high-water mark triggers memory reclamation for the Code Mode execution component only. Users manage total machine memory and their child process trees.
Sampling and reclamation are delayed, so instantaneous component memory can exceed the threshold.
Pressure first reclaims the oldest idle sessions, then may reclaim the least recently used active session.
The same ChatGPT conversation can create clean execution state afterward without starting a new chat. Old cells cannot resume, and commands are not replayed.
Save important data to files; the service does not impose disk limits on user-generated files.

Each terminal defaults to a 16 MiB unread head/tail buffer, with up to 4 MiB per read. Dropped middle logs are marked and cannot be recovered.
A noisy terminal does not pause others, and logs are not automatically written to disk. Commands can explicitly save complete logs.

Ordinary model responses allow at most 36,000 UTF-8 bytes, keeping the head and tail on overflow. Responses carrying user notes allow 37,000 bytes combined.
These are conservative service byte budgets; actual ChatGPT token limits may change. Note bodies allow 30,000 bytes, including the question and choice for answers.
If the first queued note does not fit, it waits without further clipping normal output. Messages and questions use bounded memory for 72 hours; insufficient capacity rejects new submissions.

Conversation communication is stored independently. Clearing audit history or restarting execution in Web preserves notes, questions, and labels; exiting the whole process loses them.
Without host conversation identity, ordinary execution still works, but cross-call store/load and conversation communication are unavailable.

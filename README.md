# exec-mcp

English | [简体中文](README.zh.md)

Let ChatGPT develop and run tests on a specific machine, use existing Skills, and call the other MCP services you configure.
ChatGPT does the reasoning. The Web console shows progress and lets you answer questions or send notes while work continues.

**1.0.0 is the first stable version.** Installation currently uses the source tree; a public npm package, dedicated installer, and automatic updates are not yet available.
Model-facing tool descriptions use English. Product documentation and the Web console are available in English and Chinese. See the [Changelog](CHANGELOG.md) for the release record.

The assistant uses the service account's operating-system permissions and inherits its environment, including credentials.
Starting the service as an administrator gives the assistant those privileges. Connect only trusted ChatGPT accounts and downstream services, and manage the account, backups, and recovery environment yourself.

## What it does

Combine tool calls, run long tasks, and filter large results before returning them to the model.
Import ChatGPT attachments onto the machine and deliver files back to the user. Existing Skills and downstream MCP resources are available through the same execution interface.
The Web console groups calls by conversation, supports questions with answer choices, and can notify you through the browser.

Each connection targets one specific machine. It shares no files, processes, or network environment with ChatGPT's separate containers.
The JavaScript orchestration environment has no direct filesystem or network APIs; tools still access the connected machine's filesystem and network.

## Install and start

Linux, Windows, and macOS are supported. CI covers actual execution and isolated installation on Node.js 20, 22, and 24.
Install Git, npm, and Node.js. The minimums are 20.19 for 20.x and 22.19 for 22.x; use 22 or 24 for a new setup.
[Node 20 has reached end of life](https://nodejs.org/en/about/previous-releases). This project retains compatibility, but Node 20 no longer receives upstream security maintenance.
Windows needs PowerShell 7 or Windows PowerShell; WSL is not required. Dependency installation needs network access.

Run these commands on the machine you will connect to ChatGPT.

```sh
git clone https://github.com/WAcry/exec-mcp.git
cd exec-mcp
npm ci
npm run build
node dist/src/cli.js init
node dist/src/cli.js doctor
node dist/src/cli.js serve
```

`init` creates the configuration and prints its location, leaving existing files untouched. `doctor` checks the configuration and local execution components.
`serve` runs in the foreground; press Ctrl+C to stop it. It does not install a system service or take over other programs.

The default MCP address is `http://127.0.0.1:8891/mcp` and the Web console is at `http://127.0.0.1:8893/`.
These addresses are local to that machine. ChatGPT connects through one of the tunnels below. Change your configuration if a port is already in use.

## Connect ChatGPT

| Connection | Prerequisites |
| --- | --- |
| **OpenAI Secure MCP Tunnel** | OpenAI Tunnel access, a Runtime API key, and the official tunnel-client; uses the default private mode. |
| **Cloudflare Named Tunnel** | A stable hostname, cloudflared, and exec-mcp's public authentication configuration. |
| **Tailscale Funnel** | A signed-in Tailscale node with Funnel permissions, and exec-mcp's public authentication configuration. |

Choose a connection in the [connection guide](docs/guides/connections.md). It includes an Auth0 example for public access.
**Keep the default unauthenticated private MCP port off the public internet.** The MCP tunnel does not publish the Web administration console automatically.

Once connected, tell ChatGPT which project to work on, such as inspecting `C:/git/my-project`, running its tests, and fixing failures.
To use another MCP service, [add it to the configuration](docs/guides/configuration.md#downstream-mcp).
exec-mcp reports ready only after every enabled service connects and passes validation. Complete any required downstream sign-in on the machine first.

## Web console

The interface initially follows your browser's language. Change it under Settings, then Interface preferences; the login page also has a language icon.
The choice is saved in this browser. Select Auto to follow the browser again. Commands, questions, and user messages keep their original text.

Open the Web address printed at startup to inspect calls, command and patch text, active terminals, memory status, Skills, downstream tool catalogs, and exported files.
Conversations initially show a hash; add your own label to distinguish them.
After your first LAN sign-in, the browser keeps the session and renews it while you use the console. It expires after 30 days without a visit, and normal service restarts do not require the token again.
Signing out, clearing browser cookies, or rotating the access token requires a new sign-in.

### Send a note

Select Send a note in a conversation card. The text arrives with that conversation's next normal tool response and does not interrupt a running command.
Pending notes can be withdrawn. If ChatGPT has finished its turn, copy the text into the original conversation instead.

### Answer questions

Conversation cards show the number of pending questions and a preview. You can add a note to any answer choice,
or select None of the above and write your own answer. Recommended options are never selected or submitted automatically.
Answers and unsolicited notes use the same delivery path.

### Notifications and settings

Use the bell in the upper-right corner to enable notifications and grant browser permission. New questions trigger a notification that opens the corresponding conversation.
Keep the page open and connected. If the browser cannot notify, permission is denied, or Do Not Disturb is active, questions remain available on the page.

The console can toggle existing MCP services and Skills, change supported settings, and restart the execution service. Saving and applying configuration are separate steps.
It has no arbitrary command prompt or general configuration editor. See the [configuration guide](docs/guides/configuration.md#web-console) for LAN access and disabling the Web console.

## Files, Skills, and long-running use

Attach a file in ChatGPT and specify where to save it, or ask the assistant to deliver a report from the machine.
Imports preserve existing files by default. Exports use private resources by default, with a 32 MiB limit.
For larger files, configure a separate HTTPS download endpoint. Imports and URL exports default to a 512 MiB per-file limit.
Links expire, and anyone holding a public link can download it. ChatGPT controls attachment display; sandbox mounting is not guaranteed.
See [file delivery configuration](docs/guides/configuration.md#file-delivery).

Skills are workflow documents stored in user or project directories; symbolic links are supported.
Enable or disable Skills, or require explicit user invocation, through [Skill configuration](docs/guides/configuration.md#skills).

Execution state, conversation messages, and audit records live in the current process. Cleanup has the following effects.

| Action | Effect |
| --- | --- |
| Clear call history | Removes audit records without undoing execution; keeps conversation notes and questions. |
| Restart the execution service in the Web console | Rebuilds tool connections and clears temporary execution, terminals, store, and export links; keeps notes, questions, and labels. |
| Stop the entire exec-mcp program | In-memory execution, messages, questions, labels, and audit records are not restored. Files already written and external operations are not rolled back. |

The execution component has a loose memory-reclamation target of about 4 GiB and normally retains idle sessions for 72 hours.
Terminal buffers and model output are bounded; oversized results show truncation markers. Save important data to files.
Notes and answers use the response's remaining space in order, so a long message may remain queued. Attached to a tool response records delivery preparation only;
check subsequent replies and operations to establish whether the model read and acted on it.
See the [configuration guide](docs/guides/configuration.md#capacity-and-temporary-state) for settings and boundaries.

## Upgrade and troubleshoot

Finish or save active work, stop the service you started, then run these commands in a clean source checkout.

```sh
git pull --ff-only
npm ci
npm run build
node dist/src/cli.js --version
node dist/src/cli.js doctor
node dist/src/cli.js serve
```

Existing configuration is preserved. After a tool contract changes, refresh tool metadata in ChatGPT's connection settings.
A new conversation may still use cached descriptions; see [refresh and troubleshooting](docs/guides/connections.md#refresh-and-troubleshooting).

For startup failures, check terminal logs, configuration, and downstream sign-in. If MCP works but the Web console does not, check the Web port.
The [configuration guide](docs/guides/configuration.md) and [connection guide](docs/guides/connections.md) cover shells, proxies, and token rotation.
Commands, code, and results may be sent to ChatGPT or external services you call. Account for that when managing self-hosted data.

## Development and planned work

```sh
npm run check
npm run test:package
```

Checks cover tests, types, and builds. The isolated installation check packs and installs in a temporary directory without publishing to npm.
Developers can read the [architecture](docs/architecture.md); coding agents should start with [AGENTS.md](AGENTS.md).
See [Code Mode examples](docs/guides/code-mode-examples.md) for usage.

Unshipped plans are in the [Backlog](docs/backlog.md).
This project has not granted a public open-source license. Public npm distribution requires a separate licensing and release decision.

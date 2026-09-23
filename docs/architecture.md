# Architecture boundaries

English | [简体中文](architecture.zh.md)

This document covers lasting responsibilities. Users can start with the [README](../README.md); development rules are in [AGENTS.md](../AGENTS.md).
See the [configuration](guides/configuration.md) and [connection](guides/connections.md) guides for operational steps.

## Responsibilities

```text
ChatGPT interprets the task and chooses calls and results
    │
Connectivity and authentication deliver requests to the local MCP endpoint
    │
Top-level exec / wait
    └── Code Mode host executes JS orchestration, tools, and explicit output
            ├── Local operations include commands, patches, files, Skills, images, and questions
            └── Downstream MCP validates tool catalogs at startup and serves tools and resources
```

ChatGPT handles model reasoning; exec-mcp executes tools. Each connection points to one specific remote machine.
Local means the service machine, which is independent of ChatGPT's other containers.
The orchestration V8 isolate has no direct filesystem or network APIs. Tools can still access that machine's filesystem and network.
The execution core uses a common connection interface. Users manage projects and Git workflows themselves.
Working directories determine path resolution, and execution handles are valid only during the current run.

The Web console observes and manages bounded temporary state in the same runtime. Model reasoning, ingress authentication, and execution retain their own responsibilities.
User notes and asynchronous questions live in separate instance memory, grouped by conversation hash. Web answers enter the same note queue
and return with top-level tool responses; nested tool values stay unchanged. Clearing audit history or reclaiming a native session preserves messages.
See [ADR-010](adr/010-session-notes.md) for lifecycle and output choices, and [ADR-009](adr/009-web-console.md) for loopback defaults, LAN authentication, and auditing.

Skill discovery returns metadata for remote documents. The agent reads the content or runs supporting scripts as needed.
[ADR-006](adr/006-skill-catalog.md) covers a complete catalog, resolved symlinks, and explicit invocation policy.
A conversation reuses a native session and shares data through host store/load. Each exec still has its own V8 isolate and tool snapshot.
Memory pressure reclaims whole native sessions. Unread terminal logs keep a bounded head and tail.
Conversation keys and native-session generations are separate. Cleanup for an old generation cannot affect a replacement; the same conversation can create fresh state.

JavaScript and patches use pinned Codex Code Mode host and patch engine components.
The full App Server and model client are outside the integration, and Codex's own configuration and session database remain separate.
Platform adapters handle system paths, shells, and process trees, with each platform validated separately.
Children inherit the operator's full environment. Outbound HTTP initiated by this service uses a Node 20-compatible environment proxy;
user programs decide whether to use proxies through their own network stacks, as described in [ADR-008](adr/008-environment-and-proxy.md).
The default shell is resolved at startup and shared by the executor and description. Per-command overrides affect only the new command; see [ADR-007](adr/007-command-shell.md).
[ADR-001](adr/001-exec-runtime.md) records the runtime choices.

exec orchestrates file operations. The host binds inputs in exec.files, and the machine streams selected attachments by index.
After explicit export, the result adapter attaches native resource links; a separate channel transfers the snapshot bytes.
File data bypasses V8 and model-side Base64 handling without changing the pinned host; see [ADR-005](adr/005-file-transfer.md).

## Catalogs, cancellation, and authentication

The complete tool catalog stays in the runtime; the model sees only explicitly printed entries. Bindings and display share a contract source.
Downstream schemas are inspected as needed under [ADR-002](adr/002-tool-discovery.md).

Cancelling a wait stops that observation. Operations already performed remain effective. The agent chooses how much output to show;
the service enforces transport and resource limits and reports execution status and uncertain side effects under [ADR-003](adr/003-results-lifecycle.md).

Tunnels provide connectivity; authentication determines who may call. OpenAI's private tunnel and Cloudflare/Tailscale public access
apply their respective authentication rules under [ADR-004](adr/004-connectivity-trust.md).

Read code and tests for directory structure, function relationships, and exact thresholds. This document maintains responsibilities and tradeoffs.

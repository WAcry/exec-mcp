# ADR-002 Tool discovery and contracts

English | [简体中文](002-tool-discovery.zh.md)

Active, updated 2026-09-22.

## Entry points and contract sources

Only exec and wait are top-level tools. The exec description includes complete local contracts. Tool names, argument validation, and descriptions
share executable definitions that also generate ALL_TOOLS entries and tools.* bindings. Fresh agents can use common tools immediately, while downstream contracts are printed as needed.
There are no hidden direct entry points or handwritten contract copies.

ALL_TOOLS follows Codex's `{name, description}[]` array and contains every local and downstream method bound for that exec.
Descriptions retain complete input and output constraints, including required fields, enums, and references.
The array remains in the runtime until explicitly printed, so keeping full local entries does not automatically add them to model context.
Standard JS filters names and descriptions. A known name and argument shape can be called on the first exec.

tool_search and the BM25 index have been removed, with no replacement schema/read/call API or discovery handshake.
This drops built-in relevance ranking and synonym recall in exchange for fewer interfaces and consistent catalog and invocation behavior.
The Web downstream view filters its current catalog and shows full contracts and connection errors without executing search probes.

## Startup and catalog updates

Before MCP reports ready, every enabled downstream must connect, negotiate the protocol, validate credentials, read the entire tool catalog, and validate input contracts.
Any failure stops that startup and cleans up resources. Users explicitly disable services they do not need.
This adds startup time and lets one failed service block readiness, while making login and missing-tool problems visible before work begins.
Startup only reads catalogs; it does not invoke tools that might have side effects.

The startup deadline covers negotiation and all catalog pages. Cancellation cleans up SDK resources and their owned child processes.
stdio inherits the full environment, uses stderr for local diagnostics, and reserves stdout for the protocol. HTTP uses configured credentials.
Users complete downstream authentication on the machine. Widgets, sampling, elicitation, and generic downstream OAuth sign-in or refresh are outside the proxy's scope;
ChatGPT calls do not wait for those interactions. ChatGPT's ingress OAuth to exec-mcp is configured separately.

Tools and ALL_TOOLS share a snapshot for each exec. Catalog updates affect later calls only.
After disconnection, the last validated contract allows a known method to reconnect; the live contract is checked again before sending.
Removed tools, changed contracts, or an unverifiable contract prevent sending. Failed calls that have already been sent are never retried automatically.
Name-normalization collisions, duplicate tools, and nonexistent enabled_tools entries are explicit errors.

ChatGPT may cache connection metadata. After an upgrade, the operator needs to restart and refresh the connection; a new conversation alone may retain an old description.
The service does not resend schemas on every response. Regressions cover tools/list, ALL_TOOLS, first nested calls, and active snapshots.

## Downstream resources

MCP exposes data separately through resources/list, resources/templates/list, and resources/read.
Some servers provide only resources, and tools may return resource_link values absent from the catalog.
Three helpers inside exec retain Codex's names and reuse downstream connections, authentication, proxies, and request lifecycles.
They read resources from the specified downstream server. Top-level tools remain exec and wait.

Specifying a server returns one page; omitting it aggregates servers in parallel. Resources and templates retain original metadata and add the exact configured server name.
URIs and cursors pass through unchanged for the downstream to resolve. Known URIs can come from lists, expanded templates, or resource links and can be read directly.
The local service neither rewrites URIs nor requires a prior listing.

Aggregation retains successful servers' data and reports failures in errors. Incomplete, looping, or oversized single-server pagination fails explicitly.
Resource contents are read on request. There is no content cache, subscription system, template completion, or resource management page.
SDK single-page requests preserve nextCursor, and reads bypass caching. enabled_tools filters tools only; disabling a server excludes its resources.
Results reach JS before model token budgeting, with transport and concurrency protections still in force.
Exporting this instance's files to the host is a separate direction under [ADR-005](005-file-transfer.md).

## Model contracts and product documentation

Generated MCP instructions, tool and resource descriptions, schema descriptions, and ALL_TOOLS wrappers use English,
which allows reuse of equivalent Codex wording. Token cost depends on the model and text.
Project documents use English in the default .md and Chinese in a sibling .zh.md. Keep both versions synchronized and cross-linked under [AGENTS](../../AGENTS.md).
The Web UI supports English and Simplified Chinese. User notes, Skills, third-party contracts, and runtime diagnostics retain their original language.

A first-time agent should understand parameters, defaults, return types, explicit output, and side effects from the description.
Describe capabilities, environment, and calling rules without personality, progress-reporting, or Git workflow instructions.
Tool descriptions and examples explain nested-language syntax risks. Examples show workable approaches; callers choose how to build strings.
Skill explicit-only behavior comes from user metadata. A compressed catalog explains its own aliases and omissions.

Generate complete grammar and schemas from code. [Code Mode examples](../guides/code-mode-examples.md) and the [configuration guide](../guides/configuration.md)
provide operational detail; tool descriptions need not repeat those tutorials.

## Codex references and adaptation

References include pinned rust-v0.155.1 and the reviewed
[6149914 Code Mode prompt](https://github.com/openai/codex/blob/6149914a0e59363b6777080b3e953b05d592dbac/codex-rs/code-mode-protocol/src/description.rs),
[shell definitions](https://github.com/openai/codex/blob/6149914a0e59363b6777080b3e953b05d592dbac/codex-rs/core/src/tools/handlers/shell_spec.rs), and
[resource definitions](https://github.com/openai/codex/blob/6149914a0e59363b6777080b3e953b05d592dbac/codex-rs/core/src/tools/handlers/mcp_resource_spec.rs).
System prompts, image tools, and asynchronous question definitions were checked at the same snapshot. Reviewing source does not upgrade the separately pinned runtime.
Codex Code Mode Only uses ALL_TOOLS; other model modes may still expose search tools.

| Retained difference | Reason |
| --- | --- |
| MCP source/workdir/files object | MCP lacks Codex's implicit turn directory. The host binds attachments outside JS, which selects them by index. |
| Patch string with Lark grammar in the description | MCP inputSchema has no freeform-grammar slot. The description supplies the grammar, and the pinned engine parses the string. |
| Full JSON Schema and string handles | Preserves actual validation and the executor's field types. |
| Outer budgets and a 110-second wait | Fits the target connector while retaining nested values for JS processing under ADR-003. |
| Shell overrides, EOF/resize/terminate, and zero wait | Preserves supported process operations and per-call overrides of configured defaults. |
| Native MCP image/file blocks, Skills, and Web questions | Fits ChatGPT file and message delivery and provides independent Skill discovery; notify injection is not connected. |
| Direct resource URI reads and aggregate errors | Supports templates and links while retaining partial-failure information. |

Use upstream wording where the meaning matches and explain actual environment differences.
Wording alignment alone does not justify adding the full App Server, approval flows, or another executor.

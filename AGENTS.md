# Agent development guide

English | [简体中文](AGENTS.zh.md)

Read this file when developing the project. Use the README and code for current behavior, and the ADRs below for lasting decisions.
Mark decisions that have not been implemented.

## Working practices

Check the repository, branch, and worktree state before editing. Read applicable instructions and preserve unrelated or concurrent changes.
Inspect relevant code and tests; open the corresponding ADR when the task involves a recorded tradeoff.
Read a clearly applicable Skill in full. The product's Skill feature remains governed by ADR-006.

Handle ordinary implementation, checks, and local Git work autonomously. Commit only changes belonging to the task.
Pushing, publishing, deploying, restarting existing services, and irreversible operations require explicit authorization in the current task.
Preserve any codex-mcp instance already in use while developing a new project; changing or restarting it requires separate authorization.

Maintain English and Chinese versions of project documentation. The default `.md` file is English; its sibling `.zh.md` is Chinese.
This applies to the README, AGENTS, CHANGELOG, architecture, guides, and ADRs. Update both versions together and keep their language links.
Internal links should normally stay in the reader's language. Preserve commands, protocol fields, and sample user content; leave license texts and test fixtures untranslated.
Write new commit messages in English and leave existing commit history intact. The Web UI supports English and Simplified Chinese through one shared message catalog.
Logs, user content, and raw runtime diagnostics keep their original text. Interface language does not change model contracts or user messages.
Model-visible MCP instructions, tool and resource descriptions, schema descriptions, and ALL_TOOLS wrappers use English.
Refer to the pinned Codex version and reviewed upstream prompts; differences need an actual environment or contract reason, as recorded in ADR-002.
Preserve identifiers, protocol fields, commands, enum values, and upstream data. User notes, Skill content, and third-party contracts remain unchanged.
Keep personal paths, company environments, and credentials out of public documentation. Installation instructions must work for independent deployments.

## Documentation responsibilities

Read code first and make the necessary change. Implementation, tests, schemas, and lockfiles already describe many details; do not duplicate them in a specification.
Ordinary features do not need separate planning documents or file-by-file implementation plans. Record only user-requested long-term backlog items.

Keep the reasons for choices, the cost of alternatives, and constraints that code alone cannot explain.
Maintain each topic in one location per language and link to it from elsewhere.
Keep both language versions of README, AGENTS, and CHANGELOG at the repository root. Other documents belong under docs,
with operational guides in guides and decisions in adr. Maintain one architecture document and one backlog per language.

| Document | Audience and purpose |
| --- | --- |
| README.md / README.zh.md | Introduces the product, installation, connections, permissions, and limits to users. |
| [Configuration](docs/guides/configuration.md), [connections](docs/guides/connections.md), and [examples](docs/guides/code-mode-examples.md) | Operational guidance for users and callers. |
| AGENTS.md / AGENTS.zh.md | Development rules and reading entry points for agents. |
| [Changelog](CHANGELOG.md) | User-visible release changes, kept in sync across both languages; currently contains only 1.0.0. |
| [Architecture](docs/architecture.md) | Lasting responsibility boundaries for developers and agents. Read code for functions and file relationships. |
| docs/adr/ | Current choices, reasons, and tradeoffs, primarily for agents. |
| [Backlog](docs/backlog.md) | Explicitly requested, unshipped plans and their prerequisites. |

Keep ADRs current, usually by editing the existing topic; Git retains the history.
When a new ADR supersedes a decision, record that relationship and update this index so conflicting decisions do not remain active.
If implementation diverges from a decision, determine whether it is a defect or a changed product choice, then update code or documentation.
Reflect explicit user changes of direction in the relevant decisions. Keep backlog items current, but obtain separate authorization before implementing them.

The product trusts its individual operator and a capable agent. ADR-004 defines execution permissions, the absence of per-call approval, and recovery responsibilities.
ADR-002 requires complete downstream loading at startup. Preserve both decisions.

## Read by task

| Task | Active decision |
| --- | --- |
| Tool entry points, directories, patches, Codex reuse, platforms | [ADR-001 Runtime and product scope](docs/adr/001-exec-runtime.md) |
| ALL_TOOLS, contract discovery, English model descriptions, downstream MCP | [ADR-002 Tool discovery and contracts](docs/adr/002-tool-discovery.md) |
| JSON deduplication, output budgets, store/load, media, cells and processes | [ADR-003 Results and execution lifecycle](docs/adr/003-results-lifecycle.md) |
| Tunnels, authentication, installation, releases, machine permissions | [ADR-004 Connectivity and trust](docs/adr/004-connectivity-trust.md) |
| Attachments, file transfer, resource reads, download URLs | [ADR-005 File transfer and delivery](docs/adr/005-file-transfer.md) |
| Skill discovery, symlinks, explicit invocation, catalog budgets | [ADR-006 Skill catalog](docs/adr/006-skill-catalog.md) |
| Default shell, per-command overrides, dynamic descriptions | [ADR-007 Command shells](docs/adr/007-command-shell.md) |
| Environment inheritance, outbound proxies, Node 20 compatibility | [ADR-008 Environment and proxies](docs/adr/008-environment-and-proxy.md) |
| Web console, LAN authentication, audit boundaries, frontend delivery | [ADR-009 Web console](docs/adr/009-web-console.md) |
| Conversation labels, asynchronous questions, answers, User Note FIFO | [ADR-010 Conversation notes and questions](docs/adr/010-session-notes.md) |

## Implementation and validation

Generate tool descriptions from executable contracts. Register only exec and wait at the top level.
Local contracts generate the full exec description, ALL_TOOLS entries, and tools.* bindings. ALL_TOOLS contains all bound local and downstream contracts for that exec.
Use JS to inspect downstream entries as needed; do not add a separate search tool or direct-call entry point.
Descriptions must support a correct first call. Keep history and internal mechanisms in ADRs; see ADR-002.

Reuse mature dependencies where they solve the problem. Select old UI or compatibility code only as needed.
Preserve upstream licenses and attribution. Reference repositories must not become undeclared runtime dependencies.

Choose validation based on risk. For tool contracts, check actual MCP responses and argument validation, and verify that a fresh agent has enough information to call correctly.
For platform changes, exercise real processes and installation paths, and report platform results separately.
Change the version only when the user explicitly requests it. Routine changes, commits, and pushes retain the current version.
When bumping it, update the package manifest, lockfile, and runtime constant, then verify agreement across CLI, MCP, and Web.
Source version changes, Git tags or Releases, npm publication, and deployment require separate authorization under ADR-004.

For documentation-only work, check facts, links, decision consistency, wording, and the Git diff. Do not install dependencies or run unrelated builds.
At completion, report changes, validation, Git status, and anything unverified. State whether pushing, deployment, or other requested actions actually occurred.

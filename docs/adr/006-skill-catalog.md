# ADR-006 A complete Skill catalog

English | [简体中文](006-skill-catalog.zh.md)

Active, updated 2026-09-22.

## Catalog and full content

tools.list_skills returns Skill names, descriptions, and full-document paths inside exec, allowing the agent to select workflows.
The existing shell reads content, references, and scripts. There are no separate Skill read/search/activate/run or installation tools.
ALL_TOOLS lists callable methods; Skills remain documents. The Web console can show the catalog and configuration toggles, while the model selects workflows.

Each list_skills call discovers current files. Startup neither scans nor injects full content.
The model may forget a returned catalog after context compaction, so repeat discovery is allowed without loaded flags, caching, or watchers.
The agent chooses the calling order for its task.

## Paths and scope

Always scan the service account's ~/.agents/skills and ~/.codex/skills. list_skills.workdir takes precedence;
when absent, inherit only an explicitly supplied exec.workdir. If neither is supplied, scan user directories only. Relative paths use the current exec.workdir.
Project discovery walks upward to the nearest .git file or directory, checking .agents/skills along the way and excluding sibling projects.
Without a Git boundary, check only the specified directory's own .agents/skills.

Resolve symlinks in directories and SKILL.md to real files, deduplicate by real path, and avoid cycles.
Keep different files with the same name. Real paths locate both the full document and supporting resources; path compression changes display only.
Collections may be nested, including .codex/skills/.system. Once SKILL.md is found, treat that directory as a bundle
and stop looking for Skills inside its scripts, dependencies, or references. Skip version-control internals as well.
Discovery reads files without running Git, Skill scripts, or installers. Other Codex configuration, databases, and plugins remain separate.

## Configuration toggles

Operators configure skills.config in exec-mcp's config.toml. Skills without a matching rule are enabled by default.
Selectors and rule ordering follow [Codex 0.155.1 SkillConfigRules](https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/config/src/skills_config.rs),
while configuration is read only from this service. Each rule specifies name or path and an enabled boolean.
name exactly matches all entries with that name. path identifies one SKILL.md and can distinguish separate files sharing a name.
Apply rules in configuration order; the last match wins.

Relative paths resolve from the configuration file, with ~/ support. Resolve symlinks again on discovery so stale targets cannot determine a current file's identity.
Disabled items do not enter display, description budgeting, or invocation-policy processing, and the model catalog does not report their state.
Keep enable/disable tutorials out of model descriptions; see the [configuration guide](../guides/configuration.md#skills).

enabled=true only includes files within the existing discovery scope. allow_implicit_invocation=false still applies.
Configured paths may be temporarily absent and match on a later discovery. Configuration changes require a restart; there is no hot reload or watcher.
Toggles change catalog visibility only. Shell permissions and content the model already received remain unchanged.

## Explicit invocation policy

Read YAML frontmatter from SKILL.md and invocation policy from agents/openai.yaml, without returning full content during discovery.
Items with allow_implicit_invocation=false are listed separately as explicit-only with name and path.
Their trigger descriptions are neither displayed nor budgeted. These Skills may be used only when the user explicitly requests them.
Task similarity, recommendations from other documents, and a request not to use a Skill are not authorization.

A missing policy file permits task-based selection by default. An unreadable, malformed, or invalid policy is treated as explicit-only with a warning.
Policy comes from the real SKILL.md bundle; a symlink alias directory cannot override it.
This is a model invocation rule. The shell continues to enforce OS file permissions.

## Catalog budget

The default target is 40,000 Unicode code points, roughly 10,000 tokens depending on the model.
Operators adjust [skills] max_chars; there is no separate token setting. Headers, path tables, formatting, escapes, and warnings all count.
Only descriptions of implicitly selectable Skills may be shortened; full names, reconstructible paths, and explicit-only policy remain intact.

First extract common path prefixes at directory boundaries, and use aliases only when their definitions and explanation still save space.
Distribute remaining description capacity character by character in round-robin order. Completed short descriptions yield their unused share; an ellipsis marks truncation.
Return one catalog text without a raw JSON mirror.

The catalog also adapts to the final model-response byte budget, shortening descriptions first to reduce outer head/tail truncation of Skills in the middle.
If names, paths, and policies alone exceed the target, retain all entries and report the excess instead of paginating or hiding Skills.
The outer response limit still applies, so an oversized minimum catalog may be truncated; transport overflow fails explicitly.
Check completeness of the rendered catalog separately from how much the model receives.

Explain aliases and omissions with the actual compressed result. Tool descriptions cover purpose, scope, and how to read full content,
without an advance explanation of the budgeting algorithm or extreme cases.

## Codex reuse

The port references snapshot 7498521d288b9b3b96ffba4eedf089d8d6e06a84,
including [render.rs](https://github.com/openai/codex/blob/7498521d288b9b3b96ffba4eedf089d8d6e06a84/codex-rs/ext/skills/src/render.rs)
and [aliases.rs](https://github.com/openai/codex/blob/7498521d288b9b3b96ffba4eedf089d8d6e06a84/codex-rs/ext/skills/src/aliases.rs).
Only the needed budget and path-alias algorithms and tests are ported. The pinned package has no standalone Skill Loader binary,
and the rendering interface is internal to the upstream extension. Porting this subset requires less maintenance than separate Rust distribution or App Server integration.

This project retains names and paths for explicit-only Skills and does not intentionally drop entries under small budgets. Policy parse failures keep invocation explicit.
Tests cover these differences. The links above and source comments record attribution; see [Apache-2.0](../../proto/LICENSE).
Other Codex Skill configuration is outside the compatibility scope.

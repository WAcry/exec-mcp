# ADR-011 Development philosophy

English | [简体中文](011-development-philosophy.zh.md)

Active, adopted 2026-10-04.

These user-adopted principles guide feature selection, implementation, and design review. They complement ADR-001 through ADR-010;
those decisions remain active and own the detailed behavior of their topics. This document records lasting judgment, not a new feature plan.

## Project constitution

> Build the smallest powerful execution layer that feels native to Codex-trained models, trust the agent and operator, expose truthful complete contracts, avoid unnecessary policy and machinery, and let real dogfooding decide what deserves complexity.

## Principles

1. **Keep it simple, but powerful.** Add capabilities when they materially expand ChatGPT's useful work, reduce friction, or improve reliability.
   Prefer a parameter to another tool and an existing mechanism to a second system. Feature count and architectural completeness are not goals.
   Request polling, persistent task frameworks, another agent runtime, or elaborate permissions need a concrete benefit that justifies their cost.

2. **Follow the habits of Codex-trained models.** The product premise is that models post-trained for Codex-style tool use benefit from familiar interfaces.
   Prefer reviewed Codex tool shapes, Code Mode, exec/wait, ALL_TOOLS, apply_patch, Skills, prompts, and descriptions; test this premise in actual use.
   Reuse the pinned host and patch engine, adapting for real host or contract differences rather than importing the full App Server.
   [ADR-001](001-exec-runtime.md) and [ADR-002](002-tool-discovery.md) own the integration choices.

3. **Code Mode first, with a small tool surface.** Keep exec and wait as the top-level tools. Bind local operations and downstream MCP methods inside exec.
   JavaScript composes sequential and parallel calls, filters and summarizes results, and stores intermediate data, reducing round trips and repeated context.
   Ordering still follows data dependencies and side effects under [ADR-001](001-exec-runtime.md).

4. **ALL_TOOLS belongs to the current exec environment.** The connector's host-assigned name is incidental.
   Its exec.source contains the catalog and tools.* bindings for that machine, including downstream MCP methods.
   An outer host's Code Mode or connector catalog is a separate environment; descriptions must make the boundary clear under [ADR-002](002-tool-discovery.md).

5. **Trust capable current models to choose their workflow.** Describe the environment, capabilities, parameters, and real risks rather than prescribing every step.
   Explain nested JavaScript, shell, PowerShell, Markdown, and regex parsing when relevant; let the model choose string construction and escaping.
   Recoverable small mistakes are an acceptable cost of this freedom. [ADR-002](002-tool-discovery.md) owns description requirements.

6. **Tool descriptions are a core product interface.** A fresh ChatGPT session should be able to make its first call confidently without guessing.
   Provide complete, accurate contracts with schemas that match execution; leave implementation history and tutorials in their appropriate documents.
   English model contracts preserve equivalent Codex wording. Evaluate token efficiency against the actual model and text under [ADR-002](002-tool-discovery.md).

7. **Avoid unnecessary negative prompts.** One agent's isolated, recoverable mistake does not justify a permanent prohibition.
   Keep hard calling rules for predictable misuse with serious consequences, such as resolved absolute literals for destructive deletion
   and explicit authorization before invoking other agent CLIs. [ADR-004](004-connectivity-trust.md) owns those rules.

8. **Trust the operator and agent.** A personal instance inherits its account's permissions and full environment, including credentials and proxies.
   The operator chooses a trusted, recoverable environment and manages backups and isolation. Account permissions, ingress authentication,
   and external authorization remain the boundaries; an additional path sandbox, environment allowlist, or per-command approval system is outside the current design.
   See [ADR-004](004-connectivity-trust.md) and [ADR-008](008-environment-and-proxy.md).

9. **ChatGPT performs the work by default.** An installed, signed-in Codex or Claude Code CLI still needs an explicit user request before use:
   delegation consumes another quota and changes who performs the task. Reusing the Code Mode host and patch engine is local execution,
   not delegation to another agent. [ADR-004](004-connectivity-trust.md) owns this distinction.

10. **Prefer asynchronous human communication.** Questions and agent messages submit immediately; operators can add notes in the conversation's Web view.
    Answers and notes return with normal exec/wait responses. Keep this common path instead of dedicated answer polling or calls waiting minutes for a person.
    Communication capabilities and host limitations are defined in [ADR-010](010-session-notes.md).

11. **The Web UI is an operator console.** Organize it around conversations, their calls, nested operations, questions, messages, and associated processes and files.
    Observation, communication, and runtime management are its responsibilities; model reasoning stays in ChatGPT.
    [ADR-009](009-web-console.md) owns this boundary and the conversation-first interface.

12. **Expose truthful state.** Script completed means JavaScript completed; shell success is determined separately from its result.
    Exit code zero does not imply there was no stderr. A note attached to a response is not proof that ChatGPT read it.
    An agent message's read state belongs to the Web operator and is never converted into a model instruction.
    Keep these meanings distinct under [ADR-003](003-results-lifecycle.md) and [ADR-010](010-session-notes.md).

13. **Avoid duplicate data and context.** Remove only provably equivalent structuredContent/text mirrors and preserve distinct information.
    Let JavaScript select model-facing output; use store/load or explicit files for large intermediate data.
    The purpose is to reserve context for useful reasoning, with result fidelity governed by [ADR-003](003-results-lifecycle.md).

14. **Use generous, simple resource limits.** Bound memory, audit records, and terminal logs to prevent unbounded growth during long-running service use.
    Prefer broad pressure thresholds and long idle retention to precise per-task quotas. User-created project files remain the operator's responsibility.
    Exact thresholds are implementation defaults, not permanent constitutional values; consult [ADR-003](003-results-lifecycle.md),
    [ADR-009](009-web-console.md), and the [configuration guide](../guides/configuration.md#capacity-and-temporary-state).

15. **Avoid replaying uncertain side effects.** A timeout, disconnect, or failed result delivery does not establish that an operation never happened.
    After recovery, observe actual state and let the agent decide how to continue. Automatic resend is appropriate only when non-delivery can be established,
    as specified in [ADR-002](002-tool-discovery.md); execution cancellation and recovery follow [ADR-003](003-results-lifecycle.md).

16. **Cross-platform operation is a product requirement.** Windows, Linux, and macOS receive real execution and installation validation.
    Process, shell, PTY, and installation changes require the three-platform CI matrix with supported Node versions, currently 20/22/24.
    Report platform evidence separately rather than inferring Windows behavior from Linux. Native shell defaults remain in [ADR-007](007-command-shell.md).

17. **Document decisions that code cannot explain.** README serves users, ADRs preserve reasons, constraints, and accepted costs, and AGENTS gives development rules and reading entry points.
    Read code, tests, schemas, and lockfiles for implementation facts. Ordinary features need no duplicate planning spec or file-by-file implementation plan.
    Maintain current decisions in place; Git keeps history. [AGENTS](../../AGENTS.md) owns documentation responsibilities.

18. **Public documentation is bilingual; model contracts are English.** Maintain paired .md/.zh.md documents and English/Simplified Chinese Web UI text.
    Preserve user content, raw logs and diagnostics, Skill content, identifiers, and third-party contracts in their original form.
    [AGENTS](../../AGENTS.md) and [ADR-002](002-tool-discovery.md) define the language boundaries.

19. **Let real dogfooding revise assumptions.** Actual ChatGPT behavior can overturn a design hypothesis.
    Validate workload assumptions, content/structuredContent consumption, nested catalog boundaries, discovery needs, and conversation-centered UI choices in real use.
    Record demonstrated behavior and its limits in the relevant decision; do not turn one observation into a universal host guarantee.
    Complexity earns its place through useful behavior, not the authority of an initial design draft.

20. **Keep versions and task scope deliberate.** Keep the current version unless the user explicitly requests a change.
    Solve the authorized problem without incidental redesign, new subsystems, publication, or deployment.
    Pushing, releasing, deploying, and restarting existing services retain their separate authorization boundaries under [AGENTS](../../AGENTS.md)
    and [ADR-004](004-connectivity-trust.md).

For a proposed feature, identify the concrete gain, the smallest existing mechanism that can provide it, and the evidence that any added complexity is worthwhile.
Update the relevant topic ADR when a choice changes; a philosophy update alone does not authorize implementing deferred features.

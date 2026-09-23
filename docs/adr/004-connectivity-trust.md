# ADR-004 Connectivity and trust boundaries

English | [简体中文](004-connectivity-trust.zh.md)

Active, updated 2026-09-22.

## Personal instances and execution permissions

The product is independently installed on Windows, Linux, or macOS. Each instance belongs to one trusted operator.
Deployment follows the platform; there is no team permission system, central control plane, or multi-machine scheduler.

The service trusts the operator and their ChatGPT/agent to understand the task and work within authorization. It has no per-command approvals,
tool-call confirmations, or allowlists and denylists for paths, commands, or environment-variable names.
Models can still make mistakes. The operator manages the account and recovery arrangements, including backups, version control, virtual machines, or containers as needed.

ChatGPT performs tasks itself by default. Invoking another agent CLI on the remote machine, such as Codex or Claude Code, requires an explicit user request.
Installed and authenticated programs still require permission to consume their quotas. This rule is in the tool description, without command interception or an approval flow.
The pinned Code Mode host and patch engine execute local code; using them does not delegate work to another agent.

Destructive deletion requires explicit, complete, resolved absolute path literals and prior verification of the final targets and scope.
Paths must not contain shell variables, command substitution, wildcards, dynamic concatenation, or other interpolation that could change the deletion scope.
This operator-requested rule is in the exec description. The executor does not intercept commands or rewrite paths.

Commands inherit the service account's full permissions. Starting as administrator/root gives the agent that account's privileges;
starting as a normal user retains those privileges without automatic elevation or demotion. OS, external-service, and ChatGPT authorization requirements still apply.
workdir determines path resolution only. V8 API restrictions apply to orchestration JS; shells retain the account's machine access.
Operators who need isolation for untrusted code configure it in the OS or a container.
Children inherit the full service environment. [ADR-008](008-environment-and-proxy.md) defines outbound proxy behavior.

## Connectivity and authentication

OpenAI Secure MCP Tunnel, Cloudflare Named Tunnel, and Tailscale Funnel are supported. MCP always listens on loopback.
The [official OpenAI tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) uses an outbound private-network client,
with access managed by the OpenAI organization or workspace.
Only an explicitly selected private, single-operator mode may omit local MCP application authentication. It also trusts other local processes.
A loopback peer establishes only the last hop's location; private access still depends on deployment configuration.

Cloudflare and Tailscale use explicit public mode, a stable HTTPS origin, and application authentication.
[Tailscale Funnel](https://tailscale.com/docs/features/tailscale-funnel) can expose a service publicly, while Serve provides tailnet access.
[Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/) also provides connectivity only.
Public requests require application authentication or an explicitly trusted authentication proxy, including requests arriving from localhost.

HTTP ingress consistently checks authentication, Host/Origin, and proxy trust while sharing the same execution core.
Public ChatGPT access uses an external OAuth/OIDC authorization server. exec-mcp validates JWT signatures, issuer,
MCP resource audience, expiry, scopes, and the single authorized operator's subject, and serves protected resource metadata.
The identity provider manages accounts, sign-in, and token issuance.
Other clients that support custom Authorization headers may use a high-entropy bearer token. URL secrets and identity headers are not authentication substitutes.
Authentication and Host/Origin checks cover every MCP request; session IDs and proxy headers grant no exemption.
Tool descriptions are independent of tunnel vendors. Only standard securitySchemes metadata varies with authentication mode.

The tunnel CLI starts a foreground vendor client only when explicitly run. It checks local authenticated ingress and vendor prerequisites first.
Users configure accounts, DNS, system services, and tailnet policy. Existing Serve/Funnel ports remain unchanged, and failed connections are not restarted automatically.
Cloudflare uses Named Tunnel environment credentials or an explicit token file. Quick Tunnel, which lacks SSE, is unsupported.
Tailscale checks node DNS and existing ports before starting in the foreground, without --bg or reset.
Vendor terminal output is retained, and the user answers authorization prompts.

Operators manage token files and the parent environment. The service prints connection addresses and status, not credentials.
See the [connection guide](../guides/connections.md) for installation and identity-provider setup. Cancellation and responses must follow the actual protocol;
claim host capabilities in contracts only after validation.

## Identity providers and credential sources

Documentation recommends Auth0 with concrete setup steps. The implementation depends on standard OAuth/JWT contracts
and supports other compatible providers without an Auth0-specific branch or SDK.
exec-mcp does not store Auth0 client secrets. Users manage tenant settings; the guide covers API identifiers, resources, callbacks, and scopes.

Static bearer authentication accepts either token_file or token_env when configured explicitly.
Files are recommended for long-lived personal deployments, while environment variables support existing integrations. Omitting both reads EXEC_MCP_ACCESS_TOKEN.
An invalid selected source fails without fallback or accepting another token. Files are read at startup and a digest is retained.
Trailing newlines, BOMs, and symlinked mounts are supported; rotation requires a restart.

Cloudflare prefers explicit token_file, then TUNNEL_TOKEN, then TUNNEL_TOKEN_FILE.
Because cloudflared itself prioritizes a token over a token-file, file mode overrides TUNNEL_TOKEN in that child only,
allowing users to keep a global value for other uses. The parent and other environment variables remain unchanged.
The service decrypts the file in memory; the native client receives the value through its environment, never command arguments or a printed launch plan.
Environment-only mode inherits directly. Invalid explicit files stop startup instead of connecting to a different tunnel.
This adaptation follows [ADR-008](008-environment-and-proxy.md).

## Lightweight token-file protection

Token files use reversible protection to reduce matches by simple plaintext credential scanners.
The implementation uses Node's built-in AES-256-GCM, a random nonce, and a version prefix, with a key derived from a public constant in the code.
A process that understands the implementation or can inspect its environment can still obtain plaintext. There is no master password, OS keychain, or separate key service.
Web sign-in keys use the same protection; cookie lifetime and rotation are in [ADR-009](009-web-console.md).
The prefix and decoding key are part of the compatibility format; upgrades must keep reading older files.

Protection applies only to explicitly selected single-token files, including auth.token_file, Cloudflare token_file/TUNNEL_TOKEN_FILE,
with-token inputs, and generated Web credentials. Other environment variables, header/env configuration, vendor profiles and certificates, and Tailscale state remain untouched.
On the first plaintext read, write encrypted content to a sibling temporary file and atomically replace the target. Do not create plaintext backups or decrypted temporary files.
Prefixed contents are decrypted only in memory. Unknown versions or failed validation produce an error and preserve the file.
To rotate, overwrite the same file with new plaintext and restart the relevant service or client. There is no watcher or per-request decryption.

Migration follows symlinks to the real file and preserves the link. Concurrent edits stop migration rather than overwriting a new value.
Plaintext files and their directories must be writable; encrypted files may be mounted read-only. Migration failure prevents startup, with no plaintext or credential fallback.
New POSIX files use 0600. Windows relies on private directories and ACLs; programs under the same account may still access them.
Old disk blocks, editor backups, and snapshots are outside cleanup. Keep encrypted files private and out of Git.

OpenAI tunnel-client manages its own profiles. with-token reads and protects a selected file, then starts the native client with the plaintext in a child environment variable.
Other environment entries and the argument array remain unchanged, with foreground process management retained.
This can supply CONTROL_PLANE_API_KEY while leaving vendor profiles intact, without an MCP tool or extra configuration branch.
External programs can still read their own environment or print credentials.

## Documentation and installation

This ADR records identity-provider choices, credential sources, and conflict precedence.
The [connection guide](../guides/connections.md) maintains matching Auth0 setup and startup steps for users.

Configuration, credentials, and runtime data use platform-specific user directories separate from old codex-mcp.
Installation must not depend on a developer's home, company Devspace, or shell profile. Installation and removal manage only this product's files and processes,
leaving other programs' ports, tunnels, and services intact. Validate fresh installation in an isolated environment.

The service does not write credentials into Git, logs, or tool descriptions. Explicit user output of environment values and command results remains unchanged.
Ingress authenticates the caller; external MCP services require their own authorization. Downstream tools and resources can be proxied,
while UI, sampling, elicitation, and file binding have no transparent proxy support.
[ADR-005](005-file-transfer.md) covers this service's file binding and separate download endpoint. That endpoint exposes only explicit exports
and must not expose unauthenticated execution alongside them.

The README describes available installation and connection steps and marks unshipped features.
The independent Web console is covered by [ADR-009](009-web-console.md). Downstream sign-in stays in vendor clients,
and [ADR-002](002-tool-discovery.md) defines startup checks and failures.

## Versions and releases

1.0.0 is the first stable version and currently runs from source builds. Public npm distribution still requires licensing, permissions, and a publication process.
CHANGELOG.md and CHANGELOG.zh.md record the same release entry. Adding an entry does not create a tag, GitHub Release, or npm publication.
Change the version only on explicit user request. Changing private/UNLICENSED, choosing a license, creating a Release, or publishing a package
requires separate authorization and validation. Deployment and restarting existing instances require their own authorization.

Preserve existing configuration, credential formats, and runtime contracts. Supply migration steps when a later change affects compatibility.
After a version change, verify agreement across the manifest, lockfile, CLI, MCP, and Web. Report platform validation against the corresponding commit.

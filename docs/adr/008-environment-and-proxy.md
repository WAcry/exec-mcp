# ADR-008 Environment inheritance, proxies, and Node 20

English | [简体中文](008-environment-and-proxy.zh.md)

Active, updated 2026-09-22.

## Full environment inheritance

Instances are deployed and used by trusted individuals. Shells, PTYs, downstream stdio MCP servers, the Code Mode host, and patch processes
inherit the service's full environment, with no allowlist or denylist based on names or values.
Only undefined entries are omitted. Explicit env configuration overrides matching values; Windows uses case-insensitive matching.
PTYs receive a complete copy, while native terminal rules still maintain fields such as PWD and TERM.
The service does not print the entire environment itself and does not redact environment values from commands the user explicitly runs.

The default is login=false. Inheritance does not need profile loading. Profiles can override PATH or proxy settings,
print text, or wait for input; callers can enable that behavior in configuration or per call when needed.

## HTTP proxies used by this service

SDK requests to downstream HTTP MCP servers, including negotiation and SSE, and native attachment downloads share an Undici environment-proxy transport.
It reads HTTP_PROXY, HTTPS_PROXY, NO_PROXY, and lowercase equivalents, with lowercase taking precedence.
HTTPS_PROXY falls back to HTTP_PROXY when absent. NO_PROXY supports hosts, domain suffixes, ports, and *.
The policy is the same across Node versions and does not need NODE_USE_ENV_PROXY.

Proxies apply to this service's requests only. The service does not globally replace fetch/HTTP agents or inject NODE_OPTIONS.
TLS certificate and hostname checks remain enabled; private CAs use NODE_EXTRA_CA_CERTS.
Proxy credentials go only to the proxy, not to target services or diagnostics. Proxy failures return errors without replaying directly,
which could repeat side effects. Cancellation and shutdown release connections.

Attachments retain HTTPS and original byte streams, with size, cancellation, and no-redirect rules intact.
Direct connections use a custom DNS lookup to pin validated public addresses. A proxy controls target resolution and routing when selected,
so local public DNS is unnecessary and the service cannot control the proxy's answers. Literal private or local addresses remain invalid host-attachment sources.

Code Mode gRPC is loopback parent-child IPC and always connects directly, without changing environment variables.
User-configured downstream localhost HTTP addresses still follow NO_PROXY; the service adds no implicit bypass.

## Child processes and tunnels

User children inherit all proxy variables. Their network stacks decide whether to honor them.
exec-mcp does not modify user code or network APIs or install a transparent forwarding layer.
Users configure system networking when they need all traffic routed consistently; proxy-ignoring programs and UDP require their own handling.

Users run OpenAI tunnel-client independently or explicitly start it with credentials through with-token.
The wrapper preserves profiles and existing processes. Network proxy support belongs to the vendor client.
File-download responses return over incoming connections and do not open another outbound connection.

## Node 20 compatibility

Node 20.19+ shares the implementation with Node 22/24. Proxies use Node 20-compatible Undici 7, and file identification uses file-type 21.
Type checking and real binary tests jointly validate compatibility.
Node 20 has reached upstream end of life. Compatibility remains, while new deployments should use a maintained release.
Pinned Codex components, shell behavior, and resource limits remain unchanged. There are no additional proxy-management tools or UI.

See [Node enterprise network configuration](https://nodejs.org/en/learn/http/enterprise-network-configuration),
[Undici environment proxies](https://github.com/nodejs/undici/blob/v7.29.1/docs/docs/api/EnvHttpProxyAgent.md),
and [Node release status](https://nodejs.org/en/about/previous-releases).

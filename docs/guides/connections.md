# Connections

English | [简体中文](connections.zh.md)

This guide covers connection setup. [ADR-004](../adr/004-connectivity-trust.md) records identity-provider and credential-precedence decisions.

All connection methods share exec/wait, terminals, file resources, and Skills. serve starts local MCP and any configured Web/download listeners.
The tunnel command separately starts a foreground vendor client. You manage sign-in and system-service installation; existing tunnels stay untouched.
Commands below use exec-mcp as the CLI name. For the README's source installation, run them from the repository and replace it with `node dist/src/cli.js`.
A public npm package is not yet available, and these connections do not require a global installation.

| Method | Suitable setup | Authentication boundary |
| --- | --- | --- |
| OpenAI Secure MCP Tunnel | Existing OpenAI Tunnel access | Retains the private path without additional application authentication. |
| Cloudflare Named Tunnel | Cloudflare account and stable hostname | exec-mcp authenticates every MCP request; Cloudflare provides transport. |
| Tailscale Funnel | Existing Tailscale node and a .ts.net address | Funnel is publicly accessible; exec-mcp authenticates every MCP request. |

## OpenAI Secure MCP Tunnel

Follow the [official OpenAI guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
to install tunnel-client, create your own tunnel, and obtain a Runtime API key.
Associate the tunnel with the intended ChatGPT workspace. Tunnel access and ChatGPT developer-mode permissions are separate prerequisites.

Keep exec-mcp running with its default private configuration. In a second terminal, create a dedicated profile.

```sh
tunnel-client init --profile exec-mcp --tunnel-id YOUR_TUNNEL_ID --mcp-server-url http://127.0.0.1:8891/mcp
```

Set CONTROL_PLANE_API_KEY in that terminal according to the official instructions, or use the [token-file launcher](#lightweight-token-file-protection) below.
Keep real keys out of arguments and Git. Choose a new profile name if one already exists rather than overwriting unrelated configuration.

```sh
tunnel-client doctor --profile exec-mcp
tunnel-client run --profile exec-mcp
```

Choose the tunnel and instance in ChatGPT's developer connection settings. Both processes must remain running while connected and making calls.
Update your profile if the MCP port changes. Private tunnels do not provide general browser file-download URLs.

## Refresh and troubleshooting

After upgrading tool contracts, restart exec-mcp and refresh tool metadata in ChatGPT's connection settings, then verify in a new conversation.
A new conversation may still use cached descriptions; confirm that metadata was refreshed first.
See the current [OpenAI connection and refresh guide](https://developers.openai.com/plugins/deploy/connect-chatgpt#refresh-metadata) for the interface steps.

For connection failures, inspect serve and tunnel logs, MCP /readyz, vendor doctor output, sign-in state, and configured ports.
If an OpenAI tunnel is absent, check workspace association and permissions. Public connections also need correct DNS, certificates, and OAuth configuration.
The [configuration guide](configuration.md) covers the full user settings.

## Configure authentication before public access

**Cloudflare Tunnel and Funnel can be reached by anyone on the internet.** Public ingress requires application authentication;
do not expose the unauthenticated openai-tunnel configuration. Unlisted URLs and a localhost last hop do not remove the need to authenticate.
Vendor identity headers do not bypass this requirement either.

### OAuth for ChatGPT

Auth0 is the recommended sign-in and OAuth provider; exec-mcp validates access tokens.
The implementation uses generic OAuth/JWT contracts and supports other compatible providers.
Replace the sample Auth0 tenant your-tenant.us.auth0.com and MCP hostname exec.example.com with your actual addresses.
The Auth0 domain issues tokens; the MCP domain serves exec-mcp.

```toml
[server]
access = "public"
host = "127.0.0.1"
port = 8891
public_url = "https://exec.example.com"

[auth]
type = "oauth"
issuer = "https://your-tenant.us.auth0.com/"
jwks_url = "https://your-tenant.us.auth0.com/.well-known/jwks.json"
subject = "auth0|YOUR_USER_ID"
scopes = ["exec"]
```

#### Prepare Auth0

1. Create or choose a tenant. Under **Applications → APIs**, create an API for this MCP, for example named Exec MCP.
   **Its Identifier must be `https://exec.example.com/mcp`.** Select RS256 and add the exec permission/scope.
   Identifier is the API audience. The application Client ID, Management API, and Auth0 /userinfo use different values.
   For Tailscale, use the node's public address plus /mcp, including a configured port. See [Auth0 API configuration](https://auth0.com/docs/quickstart/backend/rails).
2. Follow [Auth0's MCP authorization guide](https://auth0.com/ai/docs/mcp/get-started/authorization-for-your-mcp-server)
   to enable **Resource Parameter Compatibility Profile** and **Include Issuer in Authorization Responses** under Settings → Advanced.
   The first binds MCP's resource parameter to the API audience; the second supports issuer validation on callbacks. Setting issuer alone is insufficient.
3. Configure the ChatGPT OAuth client, preferring CIMD when supported by the tenant, or using DCR or a preregistered client.
   Use the client metadata and complete callback URI shown by ChatGPT's current administration interface. Do not hard-code old callbacks or allow arbitrary ones.
   For third-party clients, configure appropriate domain-level connections, user consent, and API access policy under Auth0's guidance.
   Configure refresh tokens for long-lived connections when needed. Machine-to-Machine/client-credentials flows do not replace user sign-in.
   See [OpenAI OAuth and client requirements](https://developers.openai.com/plugins/build/auth).
4. Obtain your User ID from Auth0's user details and put it in subject. Database users commonly have auth0|... IDs;
   social sign-in may use google-oauth2|.... Match the actual user's sub rather than an email address.
   Grant the user and client access to exec; configure roles and permissions when RBAC is enabled.
   The service requires **scope to contain exec**. A permissions field alone does not satisfy this check.
   See [Auth0 API scopes](https://auth0.com/docs/get-started/apis/scopes/api-scopes).
5. Start the service and tunnel, connect ChatGPT to the public /mcp address, and sign in with your account.
   issuer must exactly match discovery metadata and the token's iss, including a trailing slash.
   With an Auth0 custom domain, check issuer and jwks_uri against that domain's OIDC discovery instead of mixing tenant and custom domains.
   Auth0 sets issuer according to the issuing domain; see [Access Tokens](https://auth0.com/docs/secure/tokens/access-tokens/get-access-tokens).

Verify callbacks in your own Auth0 tenant and ChatGPT connection after configuration.
See [Auth0 MCP audience troubleshooting](https://support.auth0.com/center/s/article/mcp-audience-error-with-auth0) for common audience errors.
The service accepts RS256/ES256/EdDSA JWT **access tokens**, not opaque tokens, ID tokens, or browser cookies in their place.

public_url contains the HTTPS origin without /mcp. The MCP resource/audience includes /mcp.
Only the user named by subject is authorized; other tenant users cannot enter through this endpoint.
The service publishes resource discovery at /.well-known/oauth-protected-resource/mcp, with a root-path compatibility endpoint.
Unauthenticated /mcp requests receive a standard bearer challenge. Every request validates signature, issuer, audience, expiry, scope, and subject,
including tool lists, calls, waits, resource reads, and legacy MCP-session requests. Old session IDs do not replace authentication.
JWT validation is local and does not query provider revocation state in real time. Token expiry does not roll back or terminate already-started commands.

### Static bearer authentication

Clients supporting custom request headers may use static bearer authentication. Store a high-entropy random token in a separate permission-protected file.

```toml
[auth]
type = "bearer"
token_file = "./secrets/access-token.txt"
```

Existing environment-variable deployments can use token_env instead. Choose exactly one source when configuring explicitly.

```toml
[auth]
type = "bearer"
token_env = "EXEC_MCP_ACCESS_TOKEN"
```

Setting both fails configuration without guessing precedence. Omitting both retains the default EXEC_MCP_ACCESS_TOKEN source.
An explicitly selected file does not fall back to the environment if missing, unreadable, or invalid.
Initially save only the token as plaintext, without the Bearer prefix. UTF-8 BOM and trailing newlines are accepted.
First startup converts it to lightweight encrypted content with the `exec-mcp:token:v1:` prefix. Later startups decrypt automatically; clients keep using the original token.
Paths support ~/ and symlinks, resolving relative to the configuration directory. Files are read once at startup; updates require restart, with no watcher.

Use a high-entropy random token of at least 32 characters. Node's `crypto.randomBytes(32).toString('base64url')` can generate one.
Keep it in a private credential directory outside Git, and send `Authorization: Bearer ...` from the client.
Keep tokens out of URLs and shared logs. One instance does not accept different file and environment tokens simultaneously.
**For ChatGPT, use OAuth/Auth0 above.** Do not assume its connection UI supports arbitrary static request headers.

## Lightweight token-file protection

File encryption reduces discovery by simple plaintext scanners. The key is fixed in code, so a program that knows the implementation can decrypt it.
Same-account programs and targeted attacks may also obtain plaintext.
A selected plaintext file is replaced with ciphertext on first use, without an extra command or password.
To rotate a key, overwrite the same file with new plaintext and restart.
The file and directory must be writable for migration. Failure is reported; corrupt files are preserved for a compatible version or a newly pasted key.
Existing ciphertext may be mounted read-only. New Linux/macOS encrypted files use 0600; Windows relies on private account directories and ACLs.
Only selected files are protected. Existing backups and snapshots remain, other files and environment inheritance are unchanged, and runtime memory still holds decrypted values.

For a separate OpenAI tunnel-client, first create a profile using the [steps above](#openai-secure-mcp-tunnel),
save the Runtime API key in your own file, and run these commands.

```sh
exec-mcp with-token CONTROL_PLANE_API_KEY ./secrets/openai-token.txt -- tunnel-client doctor --profile exec-mcp
exec-mcp with-token CONTROL_PLANE_API_KEY ./secrets/openai-token.txt -- tunnel-client run --profile exec-mcp
```

with-token injects the selected environment variable only into the program it starts. The real key is not placed in arguments or this program's logs;
other environment values and the argument array are preserved.
The file path resolves from the current terminal directory with ~/ support. Quote Windows paths containing spaces normally.
Native executables are supported without CMD or an extra shell wrapper.
The official client still handles sign-in and authorization. Existing profiles and tunnels remain unchanged, and Ctrl+C stops this child only.
Other clients that accept environment credentials may also use this launcher. See [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) for OpenAI's environment-variable interface.

Let exec-mcp manage these files exclusively. Older exec-mcp versions and third-party programs expecting plaintext cannot read the protected format.
Do not select a plaintext file shared with another program for automatic encryption. Use with-token for that program too, or keep environment-based credentials.

## Cloudflare Named Tunnel

Follow [Cloudflare's setup guide](https://developers.cloudflare.com/tunnel/setup/) to install cloudflared,
create a dedicated remotely managed Named Tunnel, and configure a stable public hostname.
Route **the entire hostname** to `http://127.0.0.1:8891`, preserving paths and Authorization headers so /mcp and /.well-known/... both reach the service.
Do not apply caching, interactive challenges, or an additional browser sign-in wall to those paths.
Cloudflare connection credentials and the MCP bearer access token are separate. One connects the tunnel; the other authenticates MCP requests.

### Reuse TUNNEL_TOKEN

If the environment running exec-mcp tunnel already has TUNNEL_TOKEN, selecting the provider is enough.

```toml
[tunnel]
provider = "cloudflare"
# executable = "/absolute/path/to/cloudflared"
```

There is no need to copy the token into a file, and it is not added to command arguments.
Without token_file, TUNNEL_TOKEN takes precedence over TUNNEL_TOKEN_FILE.
If neither exists, startup fails without searching other account credentials.
An environment-provided file path follows the process working directory. Use explicit configuration below for paths relative to the configuration file.

### Use a separate token file

```toml
[tunnel]
provider = "cloudflare"
token_file = "./secrets/cloudflare-token.txt"
# executable = "/absolute/path/to/cloudflared"
```

**Explicit token_file always wins**, even when TUNNEL_TOKEN or TUNNEL_TOKEN_FILE also exists.
First read encrypts the file; later reads decrypt in memory. Only this cloudflared child's TUNNEL_TOKEN receives the decrypted value.
The parent's variables and the child's other variables, including proxies, stay unchanged. There is no need to remove global credentials or create a plaintext temporary file.
A missing or invalid file fails instead of falling back to a different tunnel. Token content never enters process arguments.

Relative file paths resolve from config.toml, with ~/ support. executable uses PATH when omitted.
This uses the official client's TUNNEL_TOKEN environment interface; see [run parameters](https://developers.cloudflare.com/tunnel/reference/run-parameters/).
Encrypted files are inputs to exec-mcp tunnel and cannot be passed directly to cloudflared --token-file.

Run the service and tunnel in two terminals using the same configuration.

```sh
exec-mcp serve --config /path/to/config.toml
exec-mcp tunnel --config /path/to/config.toml
```

Use `https://exec.example.com/mcp` when connecting ChatGPT.
This path requires Named Tunnel. **Random-hostname Quick Tunnel is unsupported** because it lacks stable identity and SSE support.
See [Quick Tunnel limitations](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/).

## Tailscale Funnel

Install and sign in to the official Tailscale client, enabling MagicDNS, HTTPS, and the required node Funnel permissions.
Use an installation that can run the Tailscale CLI. Platform requirements are in the [official Funnel documentation](https://tailscale.com/docs/features/tailscale-funnel).

Change the public origin above to this node's DNS name, for example as follows.

```toml
[server]
access = "public"
host = "127.0.0.1"
port = 8891
public_url = "https://my-machine.my-tailnet.ts.net"

# Keep the [auth] settings aligned with this new resource/audience.
[tunnel]
provider = "tailscale"
# executable = "/absolute/path/to/tailscale"
```

public_url can use port 443, which is the default when omitted, 8443, or 10000.
If 443 is occupied, use an origin such as `https://my-machine.my-tailnet.ts.net:8443` and update the identity-provider audience to that origin plus /mcp.
Run serve and tunnel in separate terminals as before.

Startup checks node sign-in, DNS name, and existing Serve/Funnel configuration on the selected port.
Existing services are not overwritten. The wrapper does not run reset, down, or automatic sign-in; you handle first-time Funnel confirmation in the vendor client.
It uses foreground Funnel without --bg. Ctrl+C ends this client, without deliberately creating a public configuration that persists across restarts.
External node-configuration changes can still race; avoid simultaneous administrators modifying the same port.
See [tailscale funnel CLI](https://tailscale.com/docs/reference/tailscale-cli/funnel).

## Operation and validation boundaries

Before launching a vendor client, tunnel checks that local /mcp rejects anonymous requests and, in OAuth mode, checks resource identity.
Public access also requires valid certificates, DNS, and account permissions, plus suitable firewall, CDN timeout, and identity-provider settings.
Vendor output stays in the launching terminal. Confirm reachability through an actual public request.
Ctrl+C cleans up only processes started by this command; it does not restart MCP or stop other tools.
Unexpected client exit does not trigger replay or restart.

HTTP proxy variables are fully inherited by vendor clients; their own implementation determines whether QUIC and control connections use them.
OAuth JWKS downloads use exec-mcp's environment proxy with TLS validation intact. Proxies must preserve the external Host or rewrite it to the actual local listener address.
X-Forwarded-*, Cloudflare Access, and Tailscale identity headers cannot bypass authentication.

File delivery=resource uses the same protected MCP. delivery=url retains a separate download endpoint and expiring token;
file ports are not automatically added to tunnel routes. public_url does not implicitly become files.download.base_url.
Test ChatGPT OAuth callbacks and vendor account connectivity separately, and report the actual validation coverage.

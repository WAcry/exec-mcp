import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import type { AuthConfig } from "./access-config.js";
import { EnvironmentHttpClient } from "../network/http.js";
import { readTokenFile } from "../credentials.js";

export const RESOURCE_METADATA_PATH =
  "/.well-known/oauth-protected-resource/mcp";

/** Authenticate at the HTTP boundary, before parsing or dispatching any MCP request.
 * One configured operator owns every session; issuer/audience alone are not user authorization.
 */
export class PublicAccess {
  readonly resource: string;
  readonly challenge: string;
  private readonly expected?: Buffer;
  private readonly http?: EnvironmentHttpClient;
  private readonly keys?: ReturnType<typeof createRemoteJWKSet>;

  constructor(
    readonly origin: string,
    readonly config: AuthConfig,
    options: { fetch?: typeof fetch } = {},
  ) {
    this.resource = `${origin}/mcp`;
    if (config.type === "bearer") {
      const field =
        config.token_file === undefined
          ? `认证环境变量 ${config.token_env ?? "EXEC_MCP_ACCESS_TOKEN"}`
          : "auth.token_file";
      const token =
        config.token_file === undefined
          ? process.env[config.token_env ?? "EXEC_MCP_ACCESS_TOKEN"]
          : readTokenFile(config.token_file, "auth.token_file");
      if (!token || !/^[A-Za-z0-9._~-]{32,}$/.test(token))
        throw new Error(
          `${field} 必须是至少 32 个字符的随机令牌；未启动公网入口。`,
        );
      this.expected = createHash("sha256").update(token).digest();
      this.challenge = 'Bearer realm="exec-mcp"';
    } else {
      this.challenge = `Bearer resource_metadata="${origin}${RESOURCE_METADATA_PATH}", scope="${config.scopes.join(" ")}"`;
      if (!options.fetch) this.http = new EnvironmentHttpClient();
      const send = options.fetch ?? this.http!.fetch;
      this.keys = createRemoteJWKSet(new URL(config.jwks_url), {
        [customFetch]: async (url, init) => {
          const response = await send(url, { ...init, redirect: "error" });
          // JWKS is control metadata, not an artifact. Bound a misconfigured provider response.
          if (!response.ok) {
            await response.body?.cancel().catch(() => undefined);
            return new Response(null, { status: response.status });
          }
          const reader = response.body?.getReader();
          if (!reader) throw new Error("JWKS 响应为空。");
          const chunks: Uint8Array[] = [];
          let size = 0;
          try {
            while (true) {
              const next = await reader.read();
              if (next.done) break;
              size += next.value.byteLength;
              if (size > 1024 * 1024) throw new Error("JWKS 响应过大。");
              chunks.push(next.value);
            }
          } finally {
            await reader.cancel().catch(() => undefined);
            reader.releaseLock();
          }
          return new Response(Buffer.concat(chunks), {
            status: response.status,
            headers: { "content-type": "application/json" },
          });
        },
        timeoutDuration: 10_000,
      });
    }
  }

  metadata() {
    return this.config.type === "oauth"
      ? {
          resource: this.resource,
          authorization_servers: [this.config.issuer],
          scopes_supported: this.config.scopes,
          bearer_methods_supported: ["header"],
          resource_name: "Exec MCP",
        }
      : undefined;
  }

  async authorize(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<boolean> {
    const value = request.headers.authorization;
    const match =
      typeof value === "string" &&
      /^Bearer ([A-Za-z0-9._~+\/-]+=*)$/i.exec(value);
    if (!match) {
      this.deny(response, 401);
      return false;
    }
    const token = match[1]!;
    if (this.config.type === "bearer") {
      if (
        timingSafeEqual(
          this.expected!,
          createHash("sha256").update(token).digest(),
        )
      )
        return true;
      this.deny(response, 401);
      return false;
    }
    try {
      const { payload } = await jwtVerify(token, this.keys!, {
        issuer: this.config.issuer,
        audience: this.resource,
        algorithms: ["RS256", "ES256", "EdDSA"],
        requiredClaims: ["exp", "sub"],
        clockTolerance: 5,
      });
      if (payload.sub !== this.config.subject) {
        this.deny(response, 403);
        return false;
      }
      const scopes = new Set(
        typeof payload.scope === "string" ? payload.scope.split(/\s+/) : [],
      );
      if (!this.config.scopes.every((scope) => scopes.has(scope))) {
        this.deny(response, 403, true);
        return false;
      }
      return true;
    } catch {
      // Never echo the bearer token, provider payload, claims or URLs with credentials.
      this.deny(response, 401);
      return false;
    }
  }

  close(): Promise<void> {
    return this.http?.close() ?? Promise.resolve();
  }
  private deny(
    response: ServerResponse,
    status: 401 | 403,
    scope = false,
  ): void {
    response.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "WWW-Authenticate":
        this.challenge + (scope ? ', error="insufficient_scope"' : ""),
    });
    response.end(
      JSON.stringify({ error: status === 401 ? "unauthorized" : "forbidden" }),
    );
  }
}

/** Do not trust spoofable forwarding or provider identity headers. Authentication
 * remains mandatory even when cloudflared/tailscaled reaches us via localhost.
 */
export function publicHeadersAllowed(
  request: IncomingMessage,
  response: ServerResponse,
  origin: string,
  localAuthority: string,
): boolean {
  const publicUrl = new URL(origin);
  const host = request.headers.host;
  const allowedHost =
    typeof host === "string" &&
    [publicUrl.host.toLowerCase(), localAuthority.toLowerCase()].includes(
      host.toLowerCase(),
    );
  const from = request.headers.origin;
  const allowedOrigin = from === undefined || from === publicUrl.origin;
  const authorizationCount = request.rawHeaders.filter(
    (_, index) =>
      index % 2 === 0 &&
      request.rawHeaders[index]!.toLowerCase() === "authorization",
  ).length;
  const hostCount = request.rawHeaders.filter(
    (_, index) =>
      index % 2 === 0 && request.rawHeaders[index]!.toLowerCase() === "host",
  ).length;
  if (
    allowedHost &&
    allowedOrigin &&
    authorizationCount <= 1 &&
    hostCount === 1
  )
    return true;
  response.writeHead(403, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  response.end('{"error":"forbidden"}');
  return false;
}

import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";

export const WEB_COOKIE = "exec_web_session";
export const WEB_SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
export const WEB_ACTION_HEADER = "x-exec-web";

export function isLoopbackAddress(ip: string | undefined): boolean {
  if (!ip) return false;
  return (
    ip === "::1" ||
    ip === "::ffff:127.0.0.1" ||
    (isIP(ip) === 4 && ip.startsWith("127."))
  );
}

export function requestHostname(request: IncomingMessage): string | undefined {
  const host = request.headers.host;
  if (!host || /[\s/@\\]/.test(host)) return undefined;
  try {
    return new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

export function isLoopbackHostname(hostname: string | undefined): boolean {
  if (!hostname) return false;
  const value = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    value === "localhost" ||
    value === "::1" ||
    (isIP(value) === 4 && value.startsWith("127."))
  );
}

/** Remote address alone is insufficient because DNS rebinding keeps it loopback. */
export function isTrustedLoopbackRequest(request: IncomingMessage): boolean {
  return (
    isLoopbackAddress(request.socket.remoteAddress) &&
    isLoopbackHostname(requestHostname(request))
  );
}

export function requestOriginAllowed(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (!origin) return true; // CLI/curl and same-origin non-browser requests.
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (!new Set(["http:", "https:"]).has(url.protocol)) return false;
  const host = request.headers.host?.toLowerCase();
  return !!host && url.host.toLowerCase() === host;
}

export function tokenMatches(
  candidate: string | undefined,
  expected: string,
): boolean {
  if (!candidate) return false;
  const left = createHash("sha256").update(candidate).digest();
  const right = createHash("sha256").update(expected).digest();
  return timingSafeEqual(left, right);
}

export function parseCookies(
  header: string | undefined,
): Record<string, string> {
  const result: Record<string, string> = {};
  if (!header) return result;
  for (const item of header.split(";")) {
    const [name, ...rest] = item.trim().split("=");
    if (!name) continue;
    try {
      result[name] = decodeURIComponent(rest.join("="));
    } catch {
      // A malformed cookie is ignored rather than turning every API call into 500.
    }
  }
  return result;
}

export function webCookie(value: string, clear = false): string {
  return `${WEB_COOKIE}=${clear ? "" : encodeURIComponent(value)}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : WEB_SESSION_MAX_AGE_SECONDS}`;
}

export function applyWebSecurityHeaders(
  response: ServerResponse,
  trustworthyOrigin: boolean,
): void {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  // Browsers reject COOP on plain-HTTP LAN origins and log a console error.
  // Loopback HTTP is a trustworthy origin, so retain it for the default mode.
  if (trustworthyOrigin)
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()",
  );
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'; worker-src 'none'; manifest-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'",
  );
}

export function applyCorsForAllowedOrigin(
  request: IncomingMessage,
  response: ServerResponse,
): void {
  const origin = request.headers.origin;
  if (!origin) return;
  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Access-Control-Allow-Credentials", "true");
  response.setHeader("Vary", "Origin");
}

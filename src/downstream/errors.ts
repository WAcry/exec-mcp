import {
  ProtocolError,
  SdkError,
  SdkErrorCode,
  SdkHttpError,
  UnauthorizedError,
  type Transport,
} from "@modelcontextprotocol/client";

const MAX_SERVER_TEXT = 1000;
/** JSON-RPC codes for a request the server refused before it ran anything. */
const REJECTED_CODES = new Set([-32_700, -32_600, -32_601, -32_602]);

/** A classified setup failure. Its message is ready for operators and models. */
export class SetupError extends Error {}

export type SetupStage = "connect" | "catalog";

const STAGE_TEXT: Record<SetupStage, string> = {
  connect: "connection and tool discovery failed",
  catalog: "reading the tool catalog failed",
};

function quoted(server: string): string {
  return `downstream MCP server ${JSON.stringify(server)}`;
}

function clip(text: string): string {
  const line = text.replace(/\s+/gu, " ").trim();
  return line.length > MAX_SERVER_TEXT
    ? `${line.slice(0, MAX_SERVER_TEXT)}…`
    : line;
}

/**
 * A stable code from an error chain: an errno code, an SDK error code, or an
 * HTTP status. Never free text, which could hold a URL or a credential.
 */
export function errorCode(error: unknown): string | undefined {
  if (SdkHttpError.isInstance(error)) return `HTTP ${error.status}`;
  if (SdkError.isInstance(error)) return error.code;
  let value: unknown = error;
  for (
    let depth = 0;
    value && typeof value === "object" && depth < 5;
    depth++
  ) {
    const { code } = value as { code?: unknown };
    if (typeof code === "string" && /^E[A-Z0-9_]{1,30}$/u.test(code))
      return code;
    value = (value as { cause?: unknown }).cause;
  }
  return undefined;
}

/** The code and message that the downstream server itself returned. */
export function protocolDetail(error: ProtocolError): string {
  const message = clip(error.message);
  return `MCP error ${error.code}${message ? `: ${message}` : ""}`;
}

function authenticationFailed(error: unknown): boolean {
  return (
    error instanceof UnauthorizedError ||
    (SdkHttpError.isInstance(error) && [401, 403].includes(error.status)) ||
    (SdkError.isInstance(error) &&
      (error.code === SdkErrorCode.ClientHttpAuthentication ||
        error.code === SdkErrorCode.ClientHttpForbidden))
  );
}

function timedOut(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "TimeoutError") ||
    (SdkError.isInstance(error) && error.code === SdkErrorCode.RequestTimeout)
  );
}

/** Classify a failure to connect or to read the tool catalog. */
export function setupError(
  server: string,
  stage: SetupStage,
  error?: unknown,
): SetupError {
  if (error instanceof SetupError) return error;
  let detail: string;
  if (authenticationFailed(error))
    detail =
      "authentication is missing or was rejected. Sign in or set the server's credentials on this machine, then restart exec-mcp; a call cannot complete an interactive sign-in";
  else if (timedOut(error))
    detail =
      "it timed out. Check the server's diagnostics in the exec-mcp log, finish any sign-in, or raise startup_timeout_sec, then restart exec-mcp";
  else if (ProtocolError.isInstance(error))
    detail = `the server returned ${protocolDetail(error)}. If it needs a sign-in or user input, complete that on this machine first`;
  else {
    const code = errorCode(error);
    detail = `${code ? `${code}. ` : ""}Check the URL or command, its dependencies, and the server's diagnostics in the exec-mcp log`;
  }
  return new SetupError(
    `${capitalize(quoted(server))}: ${STAGE_TEXT[stage]}: ${detail}.`,
  );
}

/** Recorded when a ready connection closes; the next operation reconnects. */
export function disconnectedReason(server: string): string {
  return `${capitalize(quoted(server))}: the connection closed. The next call reconnects.`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** True when the connection should be replaced before the next operation. */
export function shouldDiscardConnection(
  error: unknown,
  transport: Transport,
): boolean {
  if (ProtocolError.isInstance(error)) return false;
  // A legacy HTTP session can expire without closing the transport. Discard
  // that session, but leave reconnecting to the next operation.
  if (
    SdkHttpError.isInstance(error) &&
    error.status === 404 &&
    transport.sessionId !== undefined
  ) {
    return true;
  }
  if (SdkError.isInstance(error)) {
    return (
      error.code === SdkErrorCode.NotConnected ||
      error.code === SdkErrorCode.ConnectionClosed ||
      error.code === SdkErrorCode.SendFailed
    );
  }
  return error instanceof Error && error.name !== "AbortError";
}

/**
 * True only when the server cannot have processed the request: the transport
 * was not connected, or the server answered 404 for an unknown session, which
 * MCP servers do before they process the request.
 */
export function definitelyNotSent(
  error: unknown,
  transport: Transport,
): boolean {
  if (
    SdkHttpError.isInstance(error) &&
    error.status === 404 &&
    transport.sessionId !== undefined
  )
    return true;
  return SdkError.isInstance(error) && error.code === SdkErrorCode.NotConnected;
}

export interface DownstreamOperation {
  server: string;
  /** "tools/call", "resources/read", "resources/list", ... */
  method: string;
  /** Tool name or resource URI, when there is one. */
  target?: string;
  /** Tool calls can have side effects; resource reads cannot. */
  mutating: boolean;
  timeoutMs: number;
}

function subject(operation: DownstreamOperation): string {
  return operation.target === undefined
    ? `${operation.method}`
    : `${operation.method} for ${JSON.stringify(operation.target)}`;
}

/** The request never left this machine, so calling again cannot repeat work. */
export function notSentError(
  operation: DownstreamOperation,
  reason: string,
): Error {
  return new Error(
    `The request was not sent: ${subject(operation)} on ${quoted(operation.server)} could not start. ${reason} Check the server's connection and credentials on this machine, and restart exec-mcp if the problem stays.`,
  );
}

/** Classify a failure after the request was handed to the transport. */
export function requestFailure(
  operation: DownstreamOperation,
  error: unknown,
  options: { sent: boolean; timedOut?: boolean },
): Error {
  const server = quoted(operation.server);
  const what = subject(operation);
  const unknownEffect = operation.mutating
    ? " The tool may have done part or all of its work; check its effects before you call again. It was not retried."
    : " Reading has no side effects, so you can read again.";
  if (!options.sent)
    return notSentError(
      operation,
      `The connection could not be used even after exec-mcp reconnected once (${errorCode(error) ?? "no code"}).`,
    );
  if (ProtocolError.isInstance(error)) {
    if (REJECTED_CODES.has(error.code))
      return new Error(
        `The ${server} rejected ${what} (${protocolDetail(error)}). It did not run the request. Change the request based on this message, then send it again.`,
      );
    return new Error(
      `The ${server} returned an error for ${what} (${protocolDetail(error)}).${operation.mutating ? " The tool may have done part of its work; check its effects before you call again. It was not retried." : " Check the URI or cursor, then read again."}`,
    );
  }
  if (
    SdkError.isInstance(error) &&
    error.code === SdkErrorCode.UnsupportedResultType
  )
    return new Error(
      `The ${server} asked for user input during ${what}, which a call through exec-mcp cannot provide. The request did not finish. Complete that step on this machine, or use another tool.`,
    );
  if (SdkError.isInstance(error) && error.code === SdkErrorCode.InvalidResult)
    return new Error(
      `The ${server} answered ${what}, but the result does not match the declared result schema (INVALID_RESULT).${operation.mutating ? " The tool ran; check its effects before you call again." : ""}`,
    );
  if (options.timedOut || timedOut(error))
    return new Error(
      `The request was sent, but the ${server} did not answer ${what} within ${operation.timeoutMs / 1000} s (tool_timeout_sec).${unknownEffect}`,
    );
  return new Error(
    `The request was sent, but the connection to the ${server} failed before a result arrived for ${what} (${errorCode(error) ?? "no code"}).${unknownEffect}`,
  );
}

export function positiveInteger(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(
      `${name} must be a positive integer number of milliseconds.`,
    );
  }
  return resolved;
}

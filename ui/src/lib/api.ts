import type { ApiErrorBody, ApiErrorCode } from "../types";

const AUTH_REQUIRED_EVENT = "exec-auth-required";

/** "network" means no HTTP response arrived. */
export type ClientErrorCode = ApiErrorCode | "network";

/** A failed console request. The code selects the translated text; message is a diagnostic. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ClientErrorCode | undefined,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function isApiError(
  error: unknown,
  code?: ClientErrorCode,
): error is ApiError {
  return (
    error instanceof ApiError && (code === undefined || error.code === code)
  );
}

async function failure(response: Response): Promise<ApiError> {
  try {
    const body = (await response.json()) as Partial<ApiErrorBody>;
    if (typeof body.error === "string")
      return new ApiError(
        response.status,
        body.error,
        typeof body.message === "string" ? body.message : body.error,
      );
  } catch {
    /* A proxy or a crashed server can answer without the JSON error body. */
  }
  return new ApiError(response.status, undefined, `HTTP ${response.status}`);
}

export async function apiFetch<T>(
  endpoint: string,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  const method = (options.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") headers.set("x-exec-web", "1");

  let response: Response;
  try {
    response = await fetch(endpoint, {
      ...options,
      method,
      headers,
      credentials: "same-origin",
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new ApiError(
      0,
      "network",
      error instanceof Error ? error.message : String(error),
    );
  }

  if (response.status === 401)
    window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
  if (!response.ok) throw await failure(response);
  return response.json() as Promise<T>;
}

export { AUTH_REQUIRED_EVENT };

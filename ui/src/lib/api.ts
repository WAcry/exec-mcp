const AUTH_REQUIRED_EVENT = "exec-auth-required";

export async function apiFetch<T>(
  endpoint: string,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  const method = (options.method ?? "GET").toUpperCase();
  if (!new Set(["GET", "HEAD", "OPTIONS"]).has(method))
    headers.set("x-exec-web", "1");

  const response = await fetch(endpoint, {
    ...options,
    method,
    headers,
    credentials: "same-origin",
  });

  if (response.status === 401) {
    window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT));
    throw new Error("UNAUTHORIZED");
  }
  if (!response.ok) {
    let message = `请求失败：HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { message?: unknown };
      if (typeof body.message === "string") message = body.message;
    } catch {
      /* Keep the status-only message. */
    }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

export { AUTH_REQUIRED_EVENT };

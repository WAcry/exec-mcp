export function getAuthHeaders(): Record<string, string> {
  const token = localStorage.getItem("exec_lan_token");
  const headers: Record<string, string> = {};
  if (token) {
    headers["x-exec-token"] = token;
  }
  return headers;
}

export async function apiFetch<T>(
  endpoint: string,
  options: RequestInit = {},
): Promise<T> {
  const headers = {
    ...getAuthHeaders(),
    ...options.headers,
  };

  const response = await fetch(endpoint, {
    ...options,
    headers,
  });

  if (response.status === 401) {
    throw new Error("UNAUTHORIZED");
  }

  if (!response.ok) {
    let msg = `请求失败: ${response.statusText}`;
    try {
      const err = await response.json();
      if (err.message) msg = err.message;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }

  return response.json();
}

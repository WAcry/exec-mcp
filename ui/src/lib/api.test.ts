// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch, AUTH_REQUIRED_EVENT } from "./api";

const authRequired = vi.fn();
const listeners: (() => void)[] = [];

beforeEach(() => {
  authRequired.mockClear();
  window.addEventListener(AUTH_REQUIRED_EVENT, authRequired);
});

afterEach(() => {
  window.removeEventListener(AUTH_REQUIRED_EVENT, authRequired);
  for (const listener of listeners)
    window.removeEventListener(AUTH_REQUIRED_EVENT, listener);
  listeners.length = 0;
  vi.unstubAllGlobals();
});

describe("Web API authentication failures", () => {
  it("requests authentication revalidation for Exec's unauthorized response", async () => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json(
        {
          error: "unauthorized",
          message: "This request needs a valid Web access key.",
          needAuth: true,
        },
        { status: 401 },
      ),
    );
    vi.stubGlobal("fetch", fetch);

    await expect(apiFetch("/api/sessions")).rejects.toMatchObject({
      name: "ApiError",
      status: 401,
      code: "unauthorized",
    });

    expect(authRequired).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      kind: "an HTML proxy response",
      body: "<html><body>Sign in to the proxy</body></html>",
      code: undefined,
    },
    {
      kind: "a JSON response without an Exec error code",
      body: JSON.stringify({ message: "Sign in to the proxy" }),
      code: undefined,
    },
    {
      kind: "an unrecognized proxy error code",
      body: JSON.stringify({ error: "proxy_unauthorized" }),
      code: "proxy_unauthorized",
    },
  ])("does not change authentication for $kind", async ({ body, code }) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(body, { status: 401 })),
    );

    await expect(apiFetch("/api/sessions")).rejects.toMatchObject({
      status: 401,
      code,
    });

    expect(authRequired).not.toHaveBeenCalled();
  });

  it("does not request revalidation for an invalid submitted token", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ error: "invalid_token" }, { status: 401 }),
        ),
    );

    await expect(
      apiFetch("/api/auth/verify", {
        method: "POST",
        body: JSON.stringify({ token: "incorrect-token" }),
      }),
    ).rejects.toMatchObject({ status: 401, code: "invalid_token" });

    expect(authRequired).not.toHaveBeenCalled();
  });

  it("does not replay a failed POST when a status revalidation succeeds", async () => {
    const fetch = vi.fn(async (endpoint: string) => {
      if (endpoint === "/api/status") return Response.json({ status: "ready" });
      return Response.json({ error: "unauthorized" }, { status: 401 });
    });
    vi.stubGlobal("fetch", fetch);
    let revalidation: Promise<unknown> | undefined;
    const revalidate = () => {
      revalidation = apiFetch("/api/status");
    };
    listeners.push(revalidate);
    window.addEventListener(AUTH_REQUIRED_EVENT, revalidate);

    await expect(
      apiFetch("/api/sessions/chat-1/notes", {
        method: "POST",
        body: JSON.stringify({ text: "Keep this note" }),
      }),
    ).rejects.toMatchObject({ status: 401, code: "unauthorized" });
    await expect(revalidation).resolves.toEqual({ status: "ready" });

    expect(authRequired).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.map(([endpoint]) => endpoint)).toEqual([
      "/api/sessions/chat-1/notes",
      "/api/status",
    ]);
  });
});

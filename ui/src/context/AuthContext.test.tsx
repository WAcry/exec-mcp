// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "./AuthContext";
import { apiFetch } from "../lib/api";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const ready = () => new Response(JSON.stringify({ status: "ready" }));
const unauthorized = () =>
  new Response(JSON.stringify({ error: "unauthorized", needAuth: true }), {
    status: 401,
  });
const fetchMock = vi.fn<typeof fetch>();
let root: Root;
let container: HTMLDivElement;

function Probe() {
  const { isAuthenticated, isVerifying, refreshStatus, logout } = useAuth();
  return (
    <>
      <output>
        {isVerifying
          ? "checking"
          : isAuthenticated
            ? "signed in"
            : "signed out"}
      </output>
      <button onClick={() => void refreshStatus()}>Check</button>
      <button onClick={() => void logout()}>Sign out</button>
    </>
  );
}

async function mount() {
  await act(async () => {
    root.render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
  });
}

async function click(label: string) {
  await act(async () => {
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === label)!
      .click();
  });
}

const state = () => container.querySelector("output")!.textContent;

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => ready());
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("browser sign-in recovery", () => {
  it("rechecks the current cookie when an older API request is unauthorized", async () => {
    await mount();
    expect(state()).toBe("signed in");
    fetchMock.mockResolvedValueOnce(unauthorized());

    await act(async () => {
      await expect(apiFetch("/api/sessions")).rejects.toMatchObject({
        code: "unauthorized",
      });
    });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/status",
      "/api/sessions",
      "/api/status",
    ]);
    expect(state()).toBe("signed in");
  });

  it.each(["focus", "visibilitychange", "online"])(
    "recovers an existing cookie on %s without reloading",
    async (event) => {
      await mount();
      fetchMock.mockResolvedValueOnce(unauthorized());
      await click("Check");
      expect(state()).toBe("signed out");

      await act(async () => {
        const target = event === "visibilitychange" ? document : window;
        target.dispatchEvent(new Event(event));
      });

      expect(state()).toBe("signed in");
      expect(fetchMock).toHaveBeenLastCalledWith(
        "/api/status",
        expect.objectContaining({
          credentials: "same-origin",
          cache: "no-store",
        }),
      );
    },
  );

  it.each(["HTML", "unrecognized JSON"])(
    "keeps known sign-in when a proxy answers status with 401 %s",
    async (format) => {
      await mount();
      fetchMock.mockResolvedValueOnce(
        new Response(
          format === "HTML"
            ? "<html>Sign in to the proxy</html>"
            : JSON.stringify({ error: "proxy_login_required" }),
          { status: 401 },
        ),
      );

      await click("Check");
      expect(state()).toBe("signed in");
    },
  );

  it("keeps the key form when a resumed tab still has no valid cookie", async () => {
    fetchMock.mockImplementation(async () => unauthorized());
    await mount();
    expect(state()).toBe("signed out");

    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(state()).toBe("signed out");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("ignores an old unauthorized body after a newer status check succeeds", async () => {
    await mount();
    let finish!: (body: unknown) => void;
    const body = new Promise((resolve) => {
      finish = resolve;
    });
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: () => body,
    } as Response);
    await click("Check");

    await act(async () => window.dispatchEvent(new Event("focus")));
    await act(async () => finish({ error: "unauthorized" }));
    expect(state()).toBe("signed in");
  });

  it("does not restore sign-in after explicit sign-out while a check is pending", async () => {
    await mount();
    let finish!: (response: Response) => void;
    fetchMock.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await click("Check");
    await click("Sign out");
    const calls = fetchMock.mock.calls.length;

    await act(async () => {
      finish(ready());
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("online"));
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(state()).toBe("signed out");
    expect(fetchMock).toHaveBeenCalledTimes(calls);
  });

  it("does not start a status check when a tab becomes hidden", async () => {
    await mount();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(async () =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

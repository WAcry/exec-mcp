import { useCallback, useEffect, useState } from "react";

export type ToolsTab = "mcp" | "skills";
export type Route =
  | { name: "home" }
  | { name: "conversation"; id: string; call?: string }
  | { name: "activity"; query?: string; status?: string; call?: string }
  | { name: "processes" }
  | { name: "tools"; tab: ToolsTab }
  | { name: "files" }
  | { name: "settings" };

/** Routes live in the fragment; the sign-in token fragment never starts with "/". */
export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#/, "");
  if (!raw.startsWith("/")) return { name: "home" };
  const [pathPart = "", search = ""] = raw.split("?", 2);
  const query = new URLSearchParams(search);
  const parts = pathPart.split("/").filter(Boolean).map(safeDecode);
  const call = query.get("call") ?? undefined;
  switch (parts[0]) {
    case "c":
      return parts[1]
        ? { name: "conversation", id: parts[1], ...(call ? { call } : {}) }
        : { name: "home" };
    case "activity": {
      const q = query.get("q") ?? undefined;
      const status = query.get("status") ?? undefined;
      return {
        name: "activity",
        ...(q ? { query: q } : {}),
        ...(status ? { status } : {}),
        ...(call ? { call } : {}),
      };
    }
    case "processes":
      return { name: "processes" };
    case "tools":
      return { name: "tools", tab: parts[1] === "skills" ? "skills" : "mcp" };
    case "files":
      return { name: "files" };
    case "settings":
      return { name: "settings" };
    default:
      return { name: "home" };
  }
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function routeHref(route: Route): string {
  const query = new URLSearchParams();
  let path: string;
  switch (route.name) {
    case "home":
      path = "/";
      break;
    case "conversation":
      path = `/c/${encodeURIComponent(route.id)}`;
      if (route.call) query.set("call", route.call);
      break;
    case "activity":
      path = "/activity";
      if (route.query) query.set("q", route.query);
      if (route.status) query.set("status", route.status);
      if (route.call) query.set("call", route.call);
      break;
    case "tools":
      path = route.tab === "skills" ? "/tools/skills" : "/tools";
      break;
    default:
      path = `/${route.name}`;
  }
  const search = query.toString();
  return `#${path}${search ? `?${search}` : ""}`;
}

export type Navigate = (route: Route, options?: { replace?: boolean }) => void;

export function useRoute(): [Route, Navigate] {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const changed = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", changed);
    window.addEventListener("popstate", changed);
    return () => {
      window.removeEventListener("hashchange", changed);
      window.removeEventListener("popstate", changed);
    };
  }, []);
  const navigate = useCallback<Navigate>((next, options) => {
    const href = routeHref(next);
    if (href === window.location.hash) return;
    if (options?.replace) {
      window.history.replaceState(
        window.history.state,
        "",
        window.location.pathname + window.location.search + href,
      );
      setRoute(parseRoute(href));
    } else window.location.hash = href;
  }, []);
  return [route, navigate];
}

import { useEffect, useState } from "react";
import { AuthScreen } from "./components/AuthScreen";
import { ActivityView } from "./components/activity/ActivityView";
import { ConversationView } from "./components/conversation/ConversationView";
import { FilesView } from "./components/pages/FilesView";
import { ProcessesView } from "./components/pages/ProcessesView";
import { SettingsView } from "./components/pages/SettingsView";
import { ToolsView } from "./components/pages/ToolsView";
import { ConnectionBanner, RuntimeBanner } from "./components/shell/Banners";
import { HomeView } from "./components/shell/HomeView";
import { MessageToasts } from "./components/shell/MessageToasts";
import { ShortcutSheet } from "./components/shell/ShortcutSheet";
import { Sidebar } from "./components/shell/Sidebar";
import { useAuth } from "./context/AuthContext";
import { DraftsProvider } from "./context/DraftsContext";
import { LiveProvider, useLive } from "./context/LiveContext";
import { useLocale } from "./context/LocaleContext";
import { ManagementProvider } from "./context/ManagementContext";
import { preferredConversation } from "./lib/conversation";
import { updateTabState } from "./lib/favicon";
import { isTyping, useMedia, WIDE } from "./lib/use-media";
import { useRoute, type Navigate, type Route } from "./lib/router";

export function App() {
  const [route, navigate] = useRoute();
  return (
    <ManagementProvider>
      <DraftsProvider>
        <LiveProvider
          onOpenQuestion={(id) => navigate({ name: "conversation", id })}
        >
          <Gate route={route} navigate={navigate} />
        </LiveProvider>
      </DraftsProvider>
    </ManagementProvider>
  );
}

function Gate({ route, navigate }: { route: Route; navigate: Navigate }) {
  const { isAuthenticated, isVerifying } = useAuth();
  const { t } = useLocale();
  if (isVerifying)
    return (
      <div className="flex h-full items-center justify-center text-sm text-ink-3">
        {t("app.checkingAuth")}
      </div>
    );
  if (!isAuthenticated) return <AuthScreen />;
  return <Shell route={route} navigate={navigate} />;
}

function Shell({ route, navigate }: { route: Route; navigate: Navigate }) {
  const live = useLive();
  const { t } = useLocale();
  const wide = useMedia(WIDE);
  const [shortcuts, setShortcuts] = useState(false);

  useEffect(() => {
    if (route.name !== "home" || !wide || !live.sessions) return;
    const target = preferredConversation(live.sessions, live.native);
    if (target)
      navigate({ name: "conversation", id: target.id }, { replace: true });
  }, [route.name, wide, live.sessions, live.native, navigate]);

  const unread = (live.sessions ?? []).reduce(
    (sum, item) => sum + (item.unreadMessages ?? 0),
    0,
  );
  useEffect(() => {
    updateTabState({
      attention: live.pendingQuestionsTotal
        ? "question"
        : unread
          ? "message"
          : null,
      count: live.pendingQuestionsTotal + unread,
      title: t("app.title"),
    });
  }, [live.pendingQuestionsTotal, unread, t]);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isTyping(event.target)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "?") {
        event.preventDefault();
        setShortcuts((value) => !value);
      } else if (event.key === "Escape") setShortcuts(false);
      else if (event.key === "/") {
        event.preventDefault();
        window.dispatchEvent(new Event("exec:focus-search"));
      } else if (event.key === "[" || event.key === "]") {
        event.preventDefault();
        window.dispatchEvent(
          new CustomEvent("exec:step-conversation", {
            detail: event.key === "]" ? 1 : -1,
          }),
        );
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);

  const home = route.name === "home";
  return (
    <div className="flex h-dvh w-full overflow-hidden">
      {(wide || home) && (
        <Sidebar
          route={route}
          navigate={navigate}
          wide={wide}
          onShortcuts={() => setShortcuts(true)}
        />
      )}
      {(wide || !home) && (
        <main className="flex min-w-0 flex-1 flex-col bg-bg">
          <RuntimeBanner />
          <ConnectionBanner />
          <div className="min-h-0 flex-1">
            <RouteView route={route} navigate={navigate} wide={wide} />
          </div>
        </main>
      )}
      <MessageToasts route={route} navigate={navigate} />
      {shortcuts && <ShortcutSheet onClose={() => setShortcuts(false)} />}
    </div>
  );
}

function RouteView({
  route,
  navigate,
  wide,
}: {
  route: Route;
  navigate: Navigate;
  wide: boolean;
}) {
  switch (route.name) {
    case "conversation":
      return (
        <ConversationView
          key={route.id}
          id={route.id}
          {...(route.call ? { focusCall: route.call } : {})}
          navigate={navigate}
          wide={wide}
        />
      );
    case "activity":
      return <ActivityView route={route} navigate={navigate} wide={wide} />;
    case "processes":
      return <ProcessesView navigate={navigate} wide={wide} />;
    case "tools":
      return <ToolsView tab={route.tab} navigate={navigate} wide={wide} />;
    case "files":
      return <FilesView navigate={navigate} wide={wide} />;
    case "settings":
      return <SettingsView navigate={navigate} wide={wide} />;
    default:
      return <HomeView />;
  }
}

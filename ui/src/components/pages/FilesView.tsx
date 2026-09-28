import { FileOutput } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLive, useLiveEvents } from "../../context/LiveContext";
import { useLocale } from "../../context/LocaleContext";
import { apiFetch } from "../../lib/api";
import { formatBytes, formatElapsed } from "../../lib/format";
import { routeHref, type Navigate } from "../../lib/router";
import { useNow } from "../../lib/use-now";
import type { ArtifactItem } from "../../types";
import { ConfirmButton, EmptyState, Loading } from "../ui/Controls";
import { CopyButton } from "../ui/CopyButton";
import { Sigil } from "../ui/Sigil";
import { PageFrame, Panel } from "./PageFrame";

function Expiry({ at }: { at: string }) {
  const { t } = useLocale();
  const now = useNow(1000);
  const left = new Date(at).getTime() - now;
  return (
    <span
      className={`tabular ${left < 5 * 60_000 ? "text-warn" : "text-ink-3"}`}
    >
      {left > 0
        ? t("files.expiresIn", formatElapsed(left))
        : t("files.expired")}
    </span>
  );
}

export function FilesView({
  navigate,
  wide,
}: {
  navigate: Navigate;
  wide: boolean;
}) {
  const { t, locale } = useLocale();
  const live = useLive();
  const [items, setItems] = useState<ArtifactItem[] | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      const value = await apiFetch<{ artifacts: ArtifactItem[] }>(
        "/api/artifacts",
      );
      setItems(value.artifacts);
    } catch (caught) {
      setError(String(caught));
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 10_000);
    return () => window.clearInterval(timer);
  }, [load]);
  useLiveEvents((event) => {
    if (event.type === "call:finish") void load();
  });
  const sessions = useMemo(
    () => new Map((live.sessions ?? []).map((item) => [item.id, item])),
    [live.sessions],
  );
  const revoke = async (id: string) => {
    setError("");
    try {
      await apiFetch("/api/artifacts/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
    } catch (caught) {
      setError(t("files.revokeFailed", String(caught)));
    }
    await load();
  };
  return (
    <PageFrame
      title={t("files.title")}
      description={t("files.description")}
      navigate={navigate}
      wide={wide}
    >
      {error && <p className="mb-3 text-sm text-err">{error}</p>}
      {!items ? (
        <Loading />
      ) : items.length === 0 ? (
        <Panel>
          <EmptyState
            icon={<FileOutput className="h-6 w-6" strokeWidth={1.5} />}
            title={t("files.empty")}
          >
            {t("files.emptyHelp")}
          </EmptyState>
        </Panel>
      ) : (
        <Panel className="divide-y divide-line">
          {items.map((item) => {
            const conversation = item.conversation
              ? sessions.get(item.conversation)
              : undefined;
            return (
              <div key={item.id} className="flex items-start gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p
                    className="truncate text-sm font-medium text-ink"
                    title={item.name}
                  >
                    {item.name}
                  </p>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-ink-3">
                    <span className="tabular">
                      {formatBytes(item.size, locale)}
                    </span>
                    <span className="font-mono">{item.mime_type}</span>
                    <Expiry at={item.expires_at} />
                    {item.conversation && (
                      <a
                        href={routeHref({
                          name: "conversation",
                          id: item.conversation,
                        })}
                        className="inline-flex items-center gap-1.5 text-ink-2 hover:text-ink"
                      >
                        <Sigil id={item.conversation} size={14} />
                        {conversation?.label || item.conversation.slice(0, 6)}
                      </a>
                    )}
                  </div>
                  <p className="mt-1 flex min-w-0 items-center gap-1 font-mono text-2xs text-ink-3">
                    <span className="truncate">{item.uri}</span>
                    <CopyButton text={item.uri} className="h-5 w-5 shrink-0" />
                  </p>
                </div>
                <ConfirmButton
                  onConfirm={() => revoke(item.id)}
                  confirmLabel={t("files.revokeConfirm")}
                >
                  {t("files.revoke")}
                </ConfirmButton>
              </div>
            );
          })}
        </Panel>
      )}
    </PageFrame>
  );
}

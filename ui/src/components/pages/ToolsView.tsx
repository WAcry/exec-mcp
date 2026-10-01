import { ChevronRight, RefreshCw, Search, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useLocale } from "../../context/LocaleContext";
import { useManagement } from "../../context/ManagementContext";
import { apiFetch } from "../../lib/api";
import { errorText } from "../../lib/errors";
import { plural } from "../../lib/locale";
import { routeHref, type Navigate, type ToolsTab } from "../../lib/router";
import { downstreamTool } from "../../lib/steps";
import type {
  McpServerItem,
  McpServersResponse,
  McpToolItem,
  SkillsResponse,
} from "../../types";
import { CodeView } from "../ui/CodeSurface";
import {
  Button,
  EmptyState,
  Meter,
  SectionTitle,
  Loading,
  Switch,
} from "../ui/Controls";
import { PageFrame, Panel } from "./PageFrame";

function Tabs({ tab }: { tab: ToolsTab }) {
  const { t } = useLocale();
  const items: { value: ToolsTab; label: string }[] = [
    { value: "mcp", label: t("tools.mcp") },
    { value: "skills", label: t("tools.skills") },
  ];
  return (
    <nav className="flex gap-4 text-sm" aria-label={t("nav.tools")}>
      {items.map((item) => (
        <a
          key={item.value}
          href={routeHref({ name: "tools", tab: item.value })}
          aria-current={tab === item.value ? "page" : undefined}
          className={`-mb-3 border-b-2 pb-2.5 transition-colors ${tab === item.value ? "border-ink font-medium text-ink" : "border-transparent text-ink-2 hover:text-ink"}`}
        >
          {item.label}
        </a>
      ))}
    </nav>
  );
}

function ServerRow({
  server,
  tools,
  error,
}: {
  server: McpServerItem;
  tools: number;
  error: string | undefined;
}) {
  const { t } = useLocale();
  const management = useManagement();
  const enabled = server.enabled !== false;
  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-3">
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${error ? "bg-err" : server.active === false || !enabled ? "bg-ink-4" : "bg-ok"}`}
        />
        <span className="font-mono text-sm font-medium text-ink">
          {server.name}
        </span>
        <span className="font-mono text-2xs text-ink-3">
          {server.transport}
        </span>
        <span className="text-xs text-ink-3">
          {server.active === false
            ? enabled
              ? t("tools.notLoaded")
              : t("common.disabled")
            : plural(t, tools, "tools.toolCountOne", "tools.toolCount")}
        </span>
        <span className="flex-1" />
        {management.data?.available && (
          <Switch
            label={t("tools.enableServer", server.name)}
            checked={enabled}
            disabled={management.busy}
            onChange={(value) =>
              void management.toggle({
                kind: "mcp",
                name: server.name,
                enabled: value,
              })
            }
          />
        )}
      </div>
      <div className="mt-1.5 space-y-0.5 pl-5 text-xs text-ink-3">
        <p className="truncate font-mono" title={server.command ?? server.url}>
          {server.transport === "stdio"
            ? `${server.command ?? ""}${server.argsCount ? ` ${t("tools.args", server.argsCount)}` : ""}`
            : server.url}
        </p>
        {(server.envKeys?.length ||
          server.headerNames?.length ||
          server.bearerTokenEnvVar ||
          server.cwd) && (
          <p className="truncate">
            {server.cwd && (
              <span className="mr-3">
                {t("tools.cwd")} <span className="font-mono">{server.cwd}</span>
              </span>
            )}
            {!!server.envKeys?.length && (
              <span className="mr-3">
                {t("tools.env")}{" "}
                <span className="font-mono">{server.envKeys.join(", ")}</span>
              </span>
            )}
            {!!server.headerNames?.length && (
              <span className="mr-3">
                {t("tools.headers")}{" "}
                <span className="font-mono">
                  {server.headerNames.join(", ")}
                </span>
              </span>
            )}
            {server.bearerTokenEnvVar && (
              <span>
                {t("tools.tokenEnv")}{" "}
                <span className="font-mono">{server.bearerTokenEnvVar}</span>
              </span>
            )}
          </p>
        )}
        {server.enabledTools && (
          <p className="truncate">
            {t("tools.selected")}{" "}
            <span className="font-mono">{server.enabledTools.join(", ")}</span>
          </p>
        )}
        {error && <p className="text-err">{error}</p>}
      </div>
    </div>
  );
}

function ToolRow({
  tool,
  short,
  summary,
}: {
  tool: McpToolItem;
  short: string;
  summary: string;
}) {
  const [open, setOpen] = useState(false);
  const first = summary;
  return (
    <div className="px-4 py-2">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full min-w-0 items-baseline gap-2 text-left"
      >
        <ChevronRight
          className={`h-3 w-3 shrink-0 translate-y-0.5 text-ink-3 transition-transform duration-200 ${open ? "rotate-90" : ""}`}
        />
        <span className="shrink-0 font-mono text-[12.5px] text-ink">
          {short}
        </span>
        <span className="min-w-0 truncate text-xs text-ink-3">{first}</span>
      </button>
      {open && (
        <div className="fade-in mt-2 space-y-2 pl-5">
          <p className="text-2xs text-ink-3">
            <span className="font-mono">tools.{tool.name}</span>
          </p>
          <CodeView
            code={tool.description}
            language="text"
            collapsedLines={10}
          />
          {tool.inputSchema && (
            <CodeView
              code={JSON.stringify(tool.inputSchema, null, 2)}
              language="json"
              collapsedLines={10}
            />
          )}
        </div>
      )}
    </div>
  );
}

function McpTab() {
  const { t } = useLocale();
  const management = useManagement();
  const [data, setData] = useState<McpServersResponse | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [query, setQuery] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    apiFetch<McpServersResponse>("/api/mcp-servers", {
      signal: controller.signal,
    })
      .then((value) => {
        setData(value);
        setError("");
      })
      .catch((caught) => {
        if (!controller.signal.aborted) setError(errorText(caught, t));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [management.data?.revision, management.data?.generation, refresh]);

  const parsed = useMemo(
    () =>
      (data?.tools ?? []).map((tool) => ({ tool, ...downstreamTool(tool) })),
    [data],
  );
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const map = new Map<string, typeof parsed>();
    for (const item of parsed) {
      if (
        q &&
        !`${item.tool.name} ${item.tool.description}`.toLowerCase().includes(q)
      )
        continue;
      map.set(item.server, [...(map.get(item.server) ?? []), item]);
    }
    return [...map.entries()];
  }, [parsed, query]);
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const item of parsed)
      map.set(item.server, (map.get(item.server) ?? 0) + 1);
    return map;
  }, [parsed]);

  if (!data)
    return error ? <p className="text-sm text-err">{error}</p> : <Loading />;
  const matched = groups.reduce((sum, [, items]) => sum + items.length, 0);
  return (
    <>
      <section className="mb-8">
        <SectionTitle
          description={t("tools.serversHelp")}
          action={
            <Button
              size="sm"
              tone="ghost"
              disabled={loading}
              onClick={() => setRefresh((value) => value + 1)}
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
              />
              {t("common.refresh")}
            </Button>
          }
        >
          {t("tools.servers")}
        </SectionTitle>
        {data.servers.length === 0 ? (
          <Panel>
            <EmptyState title={t("tools.noServers")}>
              {t("tools.noServersHelp")}
            </EmptyState>
          </Panel>
        ) : (
          <Panel className="divide-y divide-line">
            {data.servers.map((server) => (
              <ServerRow
                key={server.name}
                server={server}
                tools={counts.get(server.name) ?? 0}
                error={data.errors[server.name]}
              />
            ))}
          </Panel>
        )}
      </section>
      <section>
        <SectionTitle description={t("tools.catalogHelp")}>
          {t("tools.catalog", data.tools.length)}
        </SectionTitle>
        <label className="mb-3 flex h-8 items-center gap-2 rounded-lg border border-line bg-surface px-2.5 focus-within:border-line-strong sm:max-w-sm">
          <Search className="h-3.5 w-3.5 shrink-0 text-ink-3" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("tools.filter")}
            aria-label={t("tools.filter")}
            className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none"
          />
          {query && (
            <span className="text-2xs tabular text-ink-3">{matched}</span>
          )}
        </label>
        {groups.length === 0 ? (
          <p className="text-sm text-ink-3">
            {data.tools.length ? t("tools.noMatches") : t("tools.noTools")}
          </p>
        ) : (
          <div className="space-y-3">
            {groups.map(([server, items]) => (
              <Panel key={server}>
                <div className="flex items-baseline justify-between border-b border-line px-4 py-2">
                  <span className="font-mono text-xs font-medium text-ink-2">
                    {server || t("tools.otherTools")}
                  </span>
                  <span className="text-2xs tabular text-ink-3">
                    {items.length}
                  </span>
                </div>
                <div className="divide-y divide-line">
                  {items.map((item) => (
                    <ToolRow
                      key={item.tool.name}
                      tool={item.tool}
                      short={item.short}
                      summary={item.summary}
                    />
                  ))}
                </div>
              </Panel>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

function SkillsTab() {
  const { t, locale } = useLocale();
  const management = useManagement();
  const [data, setData] = useState<SkillsResponse | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [workdir, setWorkdir] = useState("");
  const [applied, setApplied] = useState("");
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    apiFetch<SkillsResponse>(
      `/api/skills${applied ? `?workdir=${encodeURIComponent(applied)}` : ""}`,
      { signal: controller.signal },
    )
      .then((value) => {
        setData(value);
        setError("");
      })
      .catch((caught) => {
        if (!controller.signal.aborted) setError(errorText(caught, t));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [
    applied,
    refresh,
    management.data?.revision,
    management.data?.generation,
  ]);
  const usage = data ? (data.totalChars / Math.max(1, data.maxChars)) * 100 : 0;
  return (
    <>
      <section className="mb-6">
        <SectionTitle
          description={t("skills.help")}
          action={
            <Button
              size="sm"
              tone="ghost"
              disabled={loading}
              onClick={() => setRefresh((value) => value + 1)}
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
              />
              {t("common.refresh")}
            </Button>
          }
        >
          {t("skills.title", data?.count ?? 0)}
        </SectionTitle>
        <div className="flex flex-wrap items-center gap-4">
          {data && (
            <div className="min-w-48 flex-1">
              <div className="flex justify-between text-2xs tabular text-ink-3">
                <span>{t("skills.budget")}</span>
                <span>
                  {data.totalChars.toLocaleString(locale)} /{" "}
                  {data.maxChars.toLocaleString(locale)}
                </span>
              </div>
              <Meter
                value={usage}
                tone={usage > 90 ? "warn" : "neutral"}
                className="mt-1"
              />
            </div>
          )}
          <form
            className="flex min-w-0 flex-[2] gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              setApplied(workdir.trim());
            }}
          >
            <input
              value={workdir}
              onChange={(event) => setWorkdir(event.target.value)}
              placeholder={t("skills.placeholder")}
              aria-label={t("skills.directory")}
              className="h-8 min-w-0 flex-1 rounded-lg border border-line bg-surface px-2.5 font-mono text-xs text-ink outline-none focus:border-line-strong"
            />
            <Button size="md" type="submit" disabled={loading}>
              {t("skills.view")}
            </Button>
          </form>
        </div>
      </section>
      {error && <p className="mb-3 text-sm text-err">{error}</p>}
      {!!data?.warnings.length && (
        <Panel className="mb-4 px-4 py-3">
          <p className="flex items-center gap-1.5 text-sm font-medium text-ink">
            <TriangleAlert className="h-3.5 w-3.5 text-warn" />
            {t("skills.warnings")}
          </p>
          <ul className="mt-1.5 space-y-0.5 font-mono text-2xs text-ink-2">
            {data.warnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
        </Panel>
      )}
      {!data ? (
        <Loading />
      ) : data.skills.length === 0 ? (
        <Panel>
          <EmptyState title={t("skills.empty")} />
        </Panel>
      ) : (
        <Panel className="divide-y divide-line">
          {data.skills.map((skill) => {
            const enabled = skill.enabled !== false;
            return (
              <div
                key={skill.path}
                className="flex items-start gap-3 px-4 py-3"
              >
                <div
                  className={`min-w-0 flex-1 ${enabled ? "" : "opacity-60"}`}
                >
                  <div className="flex items-baseline gap-2">
                    <span className="font-mono text-sm font-medium text-ink">
                      {skill.name}
                    </span>
                    {!skill.implicit && (
                      <span className="text-2xs text-ink-3">
                        {t("skills.explicit")}
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-sm text-ink-2">
                    {skill.description || t("skills.explicitHelp")}
                  </p>
                  <p
                    className="mt-1 truncate font-mono text-2xs text-ink-3"
                    title={skill.path}
                  >
                    {skill.path}
                  </p>
                </div>
                {management.data?.available && (
                  <Switch
                    label={t("skills.enable", skill.name)}
                    checked={enabled}
                    disabled={management.busy}
                    onChange={(value) =>
                      void management.toggle({
                        kind: "skill",
                        path: skill.path,
                        enabled: value,
                        ...(applied ? { workdir: applied } : {}),
                      })
                    }
                  />
                )}
              </div>
            );
          })}
        </Panel>
      )}
    </>
  );
}

export function ToolsView({
  tab,
  navigate,
  wide,
}: {
  tab: ToolsTab;
  navigate: Navigate;
  wide: boolean;
}) {
  const { t } = useLocale();
  return (
    <PageFrame
      title={t("tools.title")}
      description={t("tools.description")}
      navigate={navigate}
      wide={wide}
      toolbar={<Tabs tab={tab} />}
    >
      {tab === "skills" ? <SkillsTab /> : <McpTab />}
    </PageFrame>
  );
}

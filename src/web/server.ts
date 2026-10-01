import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
  type Server,
} from "node:http";
import type { AddressInfo } from "node:net";
import { hostname, networkInterfaces } from "node:os";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod/v4";
import type { ExecRuntime } from "../runtime.js";
import { defaultConfigPath, type Config } from "../config.js";
import { SseBroker } from "./events.js";
import { WebSessionAuth } from "./session-auth.js";
import { VERSION } from "../version.js";
import { discoverSkills } from "../skills/discover.js";
import { characterCount, renderSkills } from "../skills/render.js";
import { MEMORY_DEFAULTS } from "../memory.js";
import { effectiveWebConfig, webIsExposed, type WebConfig } from "./config.js";
import { configView, mcpServerView } from "./config-view.js";
import type { ServiceController } from "../service-controller.js";
import { ConfigEditError, type ConfigToggle } from "./config-edit.js";
import { resolveUserPath } from "../util.js";
import { callListItem } from "./call-summary.js";
import { SessionNoteError, type SessionNotes } from "../session-notes.js";
import { QUESTION_ANSWER_SCHEMA } from "../user-questions.js";
import { NOTE_MAX_BYTES } from "../session-notes-types.js";
import type { ProtocolCounter } from "../http/protocol-stats.js";
import type { ActivityStore } from "./activity.js";
import type * as Api from "./api-types.js";
import {
  WEB_ACTION_HEADER,
  WEB_COOKIE,
  applyWebSecurityHeaders,
  isTrustedLoopbackRequest,
  parseCookies,
  requestOriginAllowed,
  tokenMatches,
  webCookie,
} from "./security.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const JSON_BODY_BYTES = 64 * 1024;
// JSON escaping can make a valid 30 KB message larger than the usual management body cap.
const NOTE_BODY_BYTES = NOTE_MAX_BYTES * 6 + 2048;

export interface WebServerInstance {
  server: Server;
  port: number;
  host: WebConfig["host"];
  exposed: boolean;
  loopbackUrl: string;
  lanUrls: string[];
  token: string;
  close(): Promise<void>;
}

export interface WebServerOptions {
  port?: number | undefined;
  host?: WebConfig["host"] | undefined;
  token?: string | undefined;
  publicDir?: string | undefined;
  configPath?: string | undefined;
  mcpUrl?: string | undefined;
  controller?: ServiceController;
  /** MCP wire counts when no controller supplies the current server. */
  protocol?: ProtocolCounter | undefined;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: Api.ApiErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export function getLocalIpAddresses(family?: "IPv4" | "IPv6"): string[] {
  const addresses = new Set<string>();
  for (const nets of Object.values(networkInterfaces())) {
    for (const net of nets ?? []) {
      if (net.internal) continue;
      if (family && net.family !== family) continue;
      if (net.family === "IPv4") addresses.add(net.address);
      else if (net.family === "IPv6" && !net.address.startsWith("fe80:"))
        addresses.add(net.address.split("%")[0]!);
    }
  }
  return [...addresses].sort();
}

function formatUrlHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

export async function startWebServer(
  runtime: ExecRuntime,
  config: Config,
  options: WebServerOptions = {},
): Promise<WebServerInstance> {
  const configured = effectiveWebConfig(config.web);
  const web: WebConfig = {
    ...configured,
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.port === undefined ? {} : { port: options.port }),
  };
  let closePromise: Promise<void> | undefined;
  const configPath = options.configPath ?? defaultConfigPath();
  const auth = new WebSessionAuth(configPath, options.token);
  const mcpUrl = options.mcpUrl ? new URL(options.mcpUrl) : undefined;
  const exposed = webIsExposed(web);
  const sse = new SseBroker();
  const currentRuntime = () =>
    options.controller?.current.server.runtime ?? runtime;

  // Follow the runtime the controller serves now; a restart rebinds at once.
  let observedActivity: ActivityStore | undefined;
  let unsubscribeActivity = () => {};
  let observedNotes: SessionNotes | undefined;
  let unsubscribeNotes = () => {};
  const bind = () => {
    const active = currentRuntime();
    let reset = false;
    if (active.activity !== observedActivity) {
      unsubscribeActivity();
      reset = observedActivity !== undefined;
      observedActivity = active.activity;
      unsubscribeActivity = observedActivity.subscribe((event) =>
        sse.broadcast(event),
      );
    }
    if (active.notes !== observedNotes) {
      unsubscribeNotes();
      observedNotes = active.notes;
      unsubscribeNotes = observedNotes.openWeb((event) => sse.broadcast(event));
    }
    // Calls from a replaced store would return 404, so open timelines start over.
    if (reset) sse.broadcast({ type: "call:clear" } satisfies Api.LiveEvent);
  };
  const unbind = () => {
    unsubscribeActivity();
    unsubscribeNotes();
  };

  let publicDir = options.publicDir;
  if (!publicDir) {
    const installed = path.resolve(__dirname, "public");
    const checkout = path.resolve(__dirname, "../../dist/src/web/public");
    publicDir = existsSync(installed)
      ? installed
      : existsSync(checkout)
        ? checkout
        : installed;
  }
  publicDir = path.resolve(publicDir);

  const lanAddresses = exposed
    ? getLocalIpAddresses(web.host === "0.0.0.0" ? "IPv4" : "IPv6")
    : [];
  const lanUrlsFor = (value: string) =>
    lanAddresses.map(
      (address) =>
        `http://${formatUrlHost(address)}:${actualPort}/#token=${encodeURIComponent(value)}`,
    );
  let actualPort = web.port;

  const server = createServer(async (req, res) => {
    applyWebSecurityHeaders(res, isTrustedLoopbackRequest(req));
    if (!requestOriginAllowed(req)) {
      fail(
        res,
        403,
        "forbidden_origin",
        "The Web UI accepts only same-origin requests.",
      );
      return;
    }

    let reqUrl: URL;
    try {
      reqUrl = new URL(
        req.url ?? "/",
        `http://${req.headers.host ?? "invalid"}`,
      );
    } catch {
      fail(res, 400, "invalid_url", "The request URL is not valid.");
      return;
    }
    const pathname = reqUrl.pathname;

    if (!pathname.startsWith("/api/")) {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.setHeader("Allow", "GET, HEAD");
        res.writeHead(405);
        res.end();
        return;
      }
      try {
        await serveStatic({ pathname, method: req.method, res, publicDir });
      } catch (error) {
        if (!res.headersSent) respondError(res, error);
        else res.destroy();
      }
      return;
    }

    const isLocal = isTrustedLoopbackRequest(req);
    const cookies = parseCookies(req.headers.cookie);
    const headerToken = Array.isArray(req.headers["x-exec-token"])
      ? req.headers["x-exec-token"][0]
      : req.headers["x-exec-token"];
    const bearer = req.headers.authorization?.startsWith("Bearer ")
      ? req.headers.authorization.slice(7).trim()
      : undefined;
    const clientToken = headerToken ?? bearer;
    const credentialValid = () =>
      isLocal ||
      (clientToken === undefined
        ? auth.verifyCookie(cookies[WEB_COOKIE])
        : tokenMatches(clientToken, auth.token));
    const sessionValid = auth.verifyCookie(cookies[WEB_COOKIE]);

    try {
      const match = matchRoute(req.method ?? "GET", pathname);
      if (match.kind === "method") {
        // Authentication still comes first, so the method list is not public.
        if (!credentialValid()) throw unauthorized();
        res.setHeader("Allow", match.allow.join(", "));
        throw new HttpError(
          405,
          "method_not_allowed",
          "This endpoint does not accept this HTTP method.",
        );
      }
      if (match.kind === "none") {
        if (!credentialValid()) throw unauthorized();
        throw new HttpError(404, "not_found", "Unknown endpoint.");
      }
      const { route, params } = match;
      if (!route.public && !credentialValid()) throw unauthorized();
      if (route.method !== "GET" && req.headers[WEB_ACTION_HEADER] !== "1")
        throw new HttpError(
          403,
          "missing_action_header",
          "This request needs the Web UI request header.",
        );
      if (route.loopback && !isLocal)
        throw new HttpError(403, "loopback_only", route.loopback);
      // The UI already requests status on entry and while open. Renew there,
      // without adding a refresh poll or issuing cookies on long-lived streams.
      if (pathname === "/api/status" && sessionValid)
        res.setHeader("Set-Cookie", webCookie(auth.issueCookie()));
      const body = route.body
        ? parseBody(
            route.body,
            await readJsonBody(req, route.maxBody ?? JSON_BODY_BYTES),
          )
        : undefined;
      const current = options.controller?.current;
      await route.handle({
        req,
        res,
        query: reqUrl.searchParams,
        params,
        body,
        runtime: currentRuntime(),
        config: current?.config ?? config,
        web: { ...web, port: actualPort },
        isLocal,
        sse,
        configPath,
        loopbackUrl: loopbackUrlFor(web.host, actualPort),
        mcpUrl: current ? new URL(current.server.url) : mcpUrl,
        protocol: current?.server.protocol ?? options.protocol,
        controller: options.controller,
        cookies,
        auth,
        lanUrls: () => lanUrlsFor(auth.token),
        eventAuthorized: credentialValid,
      });
    } catch (error) {
      if (!res.headersSent) respondError(res, error);
      else res.destroy();
    }
  });

  try {
    actualPort = await listen(server, web.port, web.host);
  } catch (error) {
    sse.close();
    server.closeAllConnections();
    throw error;
  }

  bind();
  const unsubscribeController = options.controller?.subscribe(() => {
    bind();
    const controller = options.controller!;
    sse.broadcast({
      type: "runtime",
      state: controller.state,
      generation: controller.generation,
    } satisfies Api.LiveEvent);
  });

  const loopbackUrl = loopbackUrlFor(web.host, actualPort);
  return {
    server,
    port: actualPort,
    host: web.host,
    exposed,
    loopbackUrl,
    get lanUrls() {
      return lanUrlsFor(auth.token);
    },
    get token() {
      return auth.token;
    },
    async close() {
      closePromise ??= (async () => {
        unsubscribeController?.();
        unbind();
        sse.close();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        });
      })();
      await closePromise;
    },
  };
}

function unauthorized(): HttpError {
  return new HttpError(
    401,
    "unauthorized",
    "This Web UI request needs a valid access token.",
  );
}

function loopbackUrlFor(host: WebConfig["host"], port: number): string {
  const loopback = host === "::" || host === "::1" ? "[::1]" : "127.0.0.1";
  return `http://${loopback}:${port}/`;
}

async function listen(
  server: Server,
  port: number,
  host: string,
): Promise<number> {
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.listen(port, host, () => {
        server.removeListener("error", onError);
        resolve();
      });
    });
  } catch (error) {
    throw new Error(
      `Cannot start the Web UI on ${host}:${port}. Change the [web] port or host.`,
      { cause: error },
    );
  }
  return (server.address() as AddressInfo).port;
}

interface RouteContext<B> {
  req: IncomingMessage;
  res: ServerResponse;
  query: URLSearchParams;
  params: Record<string, string>;
  body: B;
  runtime: ExecRuntime;
  config: Config;
  web: WebConfig;
  isLocal: boolean;
  sse: SseBroker;
  configPath: string;
  loopbackUrl: string;
  mcpUrl: URL | undefined;
  protocol: ProtocolCounter | undefined;
  controller: ServiceController | undefined;
  cookies: Record<string, string>;
  auth: WebSessionAuth;
  lanUrls(): string[];
  /** Checked again at each event, so expiry and key rotation end the stream. */
  eventAuthorized(): boolean;
}

interface Route<B = unknown> {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  /** Literal segments and :name parameters, matched against the whole path. */
  path: string;
  /** Validated JSON body; routes without one never read the body. */
  body?: z.ZodType<B>;
  maxBody?: number;
  /** Reachable without credentials; used only for sign-in and sign-out. */
  public?: true;
  /** Restricted to trusted loopback requests; the value explains why. */
  loopback?: string;
  handle(context: RouteContext<B>): Promise<void> | void;
}

interface CompiledRoute extends Route {
  pattern: RegExp;
  names: string[];
}

const route = <B = undefined>(definition: Route<B>): Route =>
  definition as unknown as Route;

const MESSAGE_IDS_BODY = z.object({
  ids: z.array(z.string().max(100)).max(200),
});
const RENAME_BODY = z.object({ label: z.string() });
const NOTE_BODY = z.object({ id: z.string(), text: z.string() });
const REVOKE_BODY = z.object({ id: z.string().min(1) });
const VERIFY_BODY = z.object({ token: z.string().optional() });
const TOGGLE_BODY: z.ZodType<Api.ConfigToggleRequest> = z.discriminatedUnion(
  "kind",
  [
    z.object({
      kind: z.literal("mcp"),
      name: z.string(),
      enabled: z.boolean(),
      revision: z.string(),
    }),
    z.object({
      kind: z.literal("skill"),
      path: z.string(),
      workdir: z.string().optional(),
      enabled: z.boolean(),
      revision: z.string(),
    }),
    z.object({
      kind: z.literal("setting"),
      name: z.enum(["execution.login", "web.enabled"]),
      enabled: z.boolean(),
      revision: z.string(),
    }),
  ],
) as z.ZodType<Api.ConfigToggleRequest>;

const ROUTES: CompiledRoute[] = [
  route({
    method: "POST",
    path: "/api/auth/verify",
    public: true,
    body: VERIFY_BODY,
    handle({ res, body, cookies, auth }) {
      if (
        !auth.verifyCookie(cookies[WEB_COOKIE]) &&
        !(body.token !== undefined && tokenMatches(body.token, auth.token))
      )
        throw new HttpError(
          401,
          "invalid_token",
          "The access token is not correct.",
        );
      res.setHeader("Set-Cookie", webCookie(auth.issueCookie()));
      json<Api.VerifyResponse>(res, 200, { valid: true });
    },
  }),
  route({
    method: "POST",
    path: "/api/auth/logout",
    public: true,
    handle({ res }) {
      res.setHeader("Set-Cookie", webCookie("", true));
      json<Api.SuccessResponse>(res, 200, { success: true });
    },
  }),
  route({
    method: "GET",
    path: "/api/status",
    async handle({
      res,
      runtime,
      config,
      web,
      isLocal,
      controller,
      mcpUrl,
      protocol,
      loopbackUrl,
      lanUrls,
    }) {
      json<Api.StatusResponse>(res, 200, {
        status: controller?.state ?? (runtime.ready ? "ready" : "stopped"),
        generation: controller?.generation ?? 1,
        version: VERSION,
        uptime: process.uptime(),
        isLoopback: isLocal,
        mcp: {
          host: mcpUrl?.hostname ?? config.host,
          port: mcpUrl ? Number(mcpUrl.port) : config.port,
          access: config.access,
          public_url: config.public_url,
          ...(protocol ? { protocol: protocol.snapshot() } : {}),
        },
        web: {
          host: web.host,
          port: web.port,
          exposed: webIsExposed(web),
          loopbackUrl,
          lanUrls: isLocal ? lanUrls() : [],
        },
        stats: runtime.activity.getStats(),
        memory: await runtime.codeMode.getMemoryStatus(),
        system: {
          hostname: hostname(),
          platform: process.platform,
          arch: process.arch,
          nodeVersion: process.version,
        },
      });
    },
  }),
  route({
    method: "GET",
    path: "/api/events",
    handle({ res, sse, eventAuthorized }) {
      if (!sse.addClient(res, eventAuthorized))
        throw new HttpError(
          503,
          "too_many_event_clients",
          "Too many live event streams are open. Close other console tabs.",
        );
    },
  }),
  route({
    method: "GET",
    path: "/api/sessions",
    handle({ res, runtime, query }) {
      const search = query.get("search");
      json<Api.SessionsResponse>(
        res,
        200,
        runtime.notes.sessions(runtime.activity.sessionSummaries(), {
          page: positiveInteger(query.get("page"), 1, 1_000_000),
          pageSize: positiveInteger(query.get("pageSize"), 20, 100),
          pendingQuestionsOnly: query.get("pendingQuestions") === "true",
          ...(search ? { search } : {}),
        }),
      );
    },
  }),
  route({
    method: "GET",
    path: "/api/sessions/:id/questions",
    handle({ res, runtime, params, query }) {
      json<Api.QuestionsResponse>(
        res,
        200,
        runtime.notes.questions(
          params.id!,
          positiveInteger(query.get("page"), 1, 1_000_000),
          query.get("status") === "pending",
        ),
      );
    },
  }),
  route({
    method: "POST",
    path: "/api/sessions/:id/questions/:questionId/answer",
    body: QUESTION_ANSWER_SCHEMA,
    maxBody: NOTE_BODY_BYTES,
    handle({ res, runtime, params, body }) {
      json<Api.NoteResponse>(
        res,
        200,
        runtime.notes.answer(params.id!, params.questionId!, body),
      );
    },
  }),
  route({
    method: "POST",
    path: "/api/sessions/:id/messages/read",
    body: MESSAGE_IDS_BODY,
    handle({ res, runtime, params, body }) {
      runtime.notes.readMessages(params.id!, body.ids);
      json<Api.SuccessResponse>(res, 200, { success: true });
    },
  }),
  route({
    method: "PATCH",
    path: "/api/sessions/:id",
    body: RENAME_BODY,
    handle({ res, runtime, params, body }) {
      runtime.notes.rename(params.id!, body.label);
      json<Api.SuccessResponse>(res, 200, { success: true });
    },
  }),
  route({
    method: "GET",
    path: "/api/sessions/:id/notes",
    handle({ res, runtime, params, query }) {
      json<Api.NotesResponse>(
        res,
        200,
        runtime.notes.page(
          params.id!,
          positiveInteger(query.get("page"), 1, 1_000_000),
        ),
      );
    },
  }),
  route({
    method: "POST",
    path: "/api/sessions/:id/notes",
    body: NOTE_BODY,
    maxBody: NOTE_BODY_BYTES,
    handle({ res, runtime, params, body }) {
      json<Api.NoteResponse>(
        res,
        200,
        runtime.notes.enqueue(params.id!, body.id, body.text),
      );
    },
  }),
  route({
    method: "DELETE",
    path: "/api/sessions/:id/notes/:noteId",
    handle({ res, runtime, params }) {
      runtime.notes.withdraw(params.id!, params.noteId!);
      json<Api.SuccessResponse>(res, 200, { success: true });
    },
  }),
  route({
    method: "GET",
    path: "/api/calls",
    handle({ res, runtime, query }) {
      const sessionId = query.get("sessionId");
      const status = query.get("status");
      const tool = query.get("tool");
      const search = query.get("search");
      const data = runtime.activity.getCalls({
        page: positiveInteger(query.get("page"), 1, 1_000_000),
        pageSize: positiveInteger(query.get("pageSize"), 20, 100),
        ...(sessionId ? { sessionId } : {}),
        ...(status ? { status } : {}),
        ...(tool ? { tool } : {}),
        ...(search ? { search } : {}),
      });
      json<Api.CallsResponse>(res, 200, {
        ...data,
        items: data.items.map(callListItem),
      });
    },
  }),
  route({
    method: "DELETE",
    path: "/api/calls",
    handle({ res, runtime }) {
      runtime.activity.clear();
      json<Api.SuccessResponse>(res, 200, { success: true });
    },
  }),
  route({
    method: "GET",
    path: "/api/calls/:id",
    handle({ res, runtime, params }) {
      const call = runtime.activity.getCall(params.id!);
      if (!call)
        throw new HttpError(
          404,
          "call_not_found",
          "The call record does not exist.",
        );
      json<Api.CallResponse>(res, 200, call);
    },
  }),
  route({
    method: "GET",
    path: "/api/media/:hash",
    handle({ res, runtime, params }) {
      const item = /^[a-f0-9]{64}$/.test(params.hash!)
        ? runtime.activity.media.get(params.hash!)
        : undefined;
      if (!item)
        throw new HttpError(
          404,
          "media_not_found",
          "The image is no longer in the audit records.",
        );
      res.writeHead(200, {
        "Content-Type": item.mimeType,
        "Content-Length": item.data.length,
        "Cache-Control": "no-store",
      });
      res.end(item.data);
    },
  }),
  route({
    method: "GET",
    path: "/api/skills",
    async handle({ res, runtime, controller, query }) {
      const saved = controller ? await controller.editor.read() : undefined;
      const workdir = query.get("workdir");
      const catalog = await discoverSkills({
        includeDisabled: true,
        config: saved?.config.skills?.config ?? runtime.skillConfig,
        ...(workdir ? { workdir: resolveUserPath(workdir) } : {}),
      });
      const rendered = renderSkills(
        {
          ...catalog,
          skills: catalog.skills.filter((skill) => skill.enabled !== false),
        },
        runtime.skillMaxChars,
      );
      json<Api.SkillsResponse>(res, 200, {
        skills: catalog.skills,
        warnings: catalog.warnings,
        maxChars: runtime.skillMaxChars,
        totalChars: characterCount(rendered),
        count: catalog.skills.length,
      });
    },
  }),
  route({
    method: "GET",
    path: "/api/mcp-servers",
    async handle({ res, runtime, config, controller, isLocal }) {
      let servers: Api.McpServerItem[] = config.mcpServers.map((server) =>
        mcpServerView(server, isLocal),
      );
      if (controller) {
        const document = await controller.editor.read();
        const raw = (document.raw.mcp_servers ?? {}) as Record<
          string,
          { url?: string; enabled?: boolean }
        >;
        servers = Object.entries(raw).map(([name, settings]) => ({
          ...(servers.find((server) => server.name === name) ?? {
            name,
            transport: settings.url ? "streamable-http" : "stdio",
          }),
          enabled: settings.enabled !== false,
          active: config.mcpServers.some((server) => server.name === name),
        }));
      }
      json<Api.McpServersResponse>(res, 200, {
        servers,
        tools: runtime.discovery.snapshot().map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
        errors: runtime.downstream.catalogErrors(),
      });
    },
  }),
  route({
    method: "GET",
    path: "/api/management",
    async handle({ res, controller }) {
      json<Api.ManagementResponse>(
        res,
        200,
        controller ? await managementState(controller) : { available: false },
      );
    },
  }),
  route({
    method: "POST",
    path: "/api/config/toggle",
    body: TOGGLE_BODY,
    async handle({ res, controller, body }) {
      if (!controller)
        throw new HttpError(
          409,
          "management_unavailable",
          "This embedded instance has no configuration management.",
        );
      if (controller.state === "restarting")
        throw new HttpError(
          409,
          "restart_in_progress",
          "A restart is in progress. Change the configuration after it finishes.",
        );
      const { revision, ...change } = body;
      await controller.editor.toggle(change as ConfigToggle, revision);
      json<Api.ManagementResponse>(res, 200, await managementState(controller));
    },
  }),
  route({
    method: "POST",
    path: "/api/runtime/restart",
    handle({ res, controller }) {
      if (!controller)
        throw new HttpError(
          409,
          "management_unavailable",
          "This instance has no restart control.",
        );
      // Acknowledge before retiring any executing requests; repeated clicks coalesce.
      json<Api.RestartResponse>(res, 202, { accepted: true });
      void controller.restart().catch(() => undefined);
    },
  }),
  route({
    method: "GET",
    path: "/api/terminals",
    handle({ res, runtime }) {
      json<Api.TerminalsResponse>(res, 200, {
        sessions: runtime.terminal.getActiveSessions(),
      });
    },
  }),
  route({
    method: "GET",
    path: "/api/native-sessions",
    async handle({ res, runtime }) {
      json<Api.NativeSessionsResponse>(res, 200, {
        sessions: runtime.codeMode.getNativeSessions(),
        memory: await runtime.codeMode.getMemoryStatus(),
      });
    },
  }),
  route({
    method: "GET",
    path: "/api/artifacts",
    handle({ res, runtime }) {
      json<Api.ArtifactsResponse>(res, 200, {
        artifacts: runtime.artifacts.getActiveArtifacts(),
      });
    },
  }),
  route({
    method: "POST",
    path: "/api/artifacts/revoke",
    body: REVOKE_BODY,
    async handle({ res, runtime, body }) {
      await runtime.artifacts.revokeFromInstance(body.id);
      json<Api.SuccessResponse>(res, 200, { success: true });
    },
  }),
  route({
    method: "GET",
    path: "/api/config",
    handle({ res, config, configPath, runtime, web, isLocal }) {
      json<Api.ConfigResponse>(res, 200, {
        ...configView({ config, configPath, runtime, web, local: isLocal }),
        config_exists: existsSync(configPath),
        memory: { ...MEMORY_DEFAULTS, ...config.memory },
      });
    },
  }),
  route({
    method: "POST",
    path: "/api/config/reveal",
    loopback: "Only this machine can open the configuration folder.",
    async handle({ res, configPath }) {
      await revealConfig(configPath);
      json<Api.SuccessResponse>(res, 200, { success: true });
    },
  }),
  route({
    method: "POST",
    path: "/api/auth/regenerate-token",
    loopback: "Only this machine can rotate the LAN access token.",
    handle({ res, auth, sse, lanUrls }) {
      auth.rotate();
      // Existing EventSource responses were authorized with the previous token.
      // Close them now so a rotated credential actually revokes live observers.
      sse.disconnectClients();
      res.setHeader("Set-Cookie", webCookie(auth.issueCookie()));
      json<Api.RegenerateTokenResponse>(res, 200, {
        success: true,
        lanUrls: lanUrls(),
      });
    },
  }),
].map((definition) => {
  const names: string[] = [];
  const source = definition.path
    .split("/")
    .map((segment) => {
      if (!segment.startsWith(":")) return segment;
      names.push(segment.slice(1));
      return "([^/]+)";
    })
    .join("/");
  return { ...definition, pattern: new RegExp(`^${source}$`), names };
});

type RouteMatch =
  | { kind: "route"; route: CompiledRoute; params: Record<string, string> }
  | { kind: "method"; allow: string[] }
  | { kind: "none" };

function matchRoute(method: string, pathname: string): RouteMatch {
  const allow: string[] = [];
  for (const candidate of ROUTES) {
    const found = candidate.pattern.exec(pathname);
    if (!found) continue;
    if (candidate.method !== method) {
      allow.push(candidate.method);
      continue;
    }
    const params: Record<string, string> = {};
    try {
      candidate.names.forEach((name, index) => {
        params[name] = decodeURIComponent(found[index + 1]!);
      });
    } catch {
      throw new HttpError(
        400,
        "invalid_request",
        "An ID in the request path is not valid.",
      );
    }
    return { kind: "route", route: candidate, params };
  }
  return allow.length ? { kind: "method", allow } : { kind: "none" };
}

function parseBody<B>(schema: z.ZodType<B>, value: unknown): B {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new HttpError(
    400,
    "invalid_request",
    `The request body is not valid: ${parsed.error.issues
      .slice(0, 3)
      .map(
        (issue) =>
          `${issue.path.length ? issue.path.join(".") : "body"}: ${issue.message}`,
      )
      .join("; ")}`,
  );
}

async function managementState(
  controller: ServiceController,
): Promise<Api.ManagementResponse> {
  const document = await controller.editor.read();
  const definitions = (document.raw.mcp_servers ?? {}) as Record<
    string,
    { enabled?: boolean }
  >;
  return {
    available: true,
    revision: document.revision,
    pending: document.revision !== controller.current.revision,
    state: controller.state,
    generation: controller.generation,
    ...(controller.error ? { error: controller.error } : {}),
    servers: Object.entries(definitions).map(([name, value]) => ({
      name,
      enabled: value.enabled !== false,
      active: controller.current.config.mcpServers.some(
        (server) => server.name === name,
      ),
    })),
    settings: {
      login: document.config.execution?.login ?? false,
      web: effectiveWebConfig(document.config.web).enabled,
    },
  };
}

async function revealConfig(configPath: string): Promise<void> {
  const directory = path.dirname(configPath);
  const child =
    process.platform === "win32"
      ? spawn(
          "explorer.exe",
          [existsSync(configPath) ? `/select,${configPath}` : directory],
          {
            detached: true,
            stdio: "ignore",
          },
        )
      : process.platform === "darwin"
        ? spawn(
            "open",
            existsSync(configPath) ? ["-R", configPath] : [directory],
            {
              detached: true,
              stdio: "ignore",
            },
          )
        : spawn("xdg-open", [directory], { detached: true, stdio: "ignore" });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
}

async function serveStatic(options: {
  pathname: string;
  method: string | undefined;
  res: ServerResponse;
  publicDir: string;
}): Promise<void> {
  const { res, publicDir } = options;
  let pathname: string;
  try {
    pathname = decodeURIComponent(options.pathname);
  } catch {
    throw new HttpError(400, "invalid_url", "The file path is not valid.");
  }
  if (pathname.includes("\0"))
    throw new HttpError(400, "invalid_url", "The file path is not valid.");
  const root = path.resolve(publicDir);
  let filePath = path.resolve(
    root,
    `.${pathname === "/" ? "/index.html" : pathname}`,
  );
  const relative = path.relative(root, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new HttpError(
      403,
      "not_found",
      "Files outside the Web UI folder are not available.",
    );

  try {
    let info = await stat(filePath);
    if (info.isDirectory()) {
      filePath = path.join(filePath, "index.html");
      info = await stat(filePath);
    }
    if (!info.isFile()) throw new Error("not a file");
    await sendFile(res, filePath, options.method === "HEAD");
  } catch {
    if (path.extname(pathname))
      throw new HttpError(404, "not_found", "The file does not exist.");
    const index = path.join(root, "index.html");
    if (existsSync(index))
      await sendFile(res, index, options.method === "HEAD");
    else sendHtml(res, renderFallbackHtml(VERSION), options.method === "HEAD");
  }
}

async function sendFile(
  res: ServerResponse,
  file: string,
  head: boolean,
): Promise<void> {
  const content = await readFile(file);
  const ext = path.extname(file).toLowerCase();
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
  };
  res.writeHead(200, {
    "Content-Type": types[ext] ?? "application/octet-stream",
    "Content-Length": content.length,
    "Cache-Control": file.includes(`${path.sep}assets${path.sep}`)
      ? "public, max-age=31536000, immutable"
      : "no-cache",
  });
  res.end(head ? undefined : content);
}

function sendHtml(res: ServerResponse, html: string, head: boolean): void {
  const bytes = Buffer.byteLength(html);
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": bytes,
    "Cache-Control": "no-cache",
  });
  res.end(head ? undefined : html);
}

function renderFallbackHtml(version: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>EXEC MCP console</title></head><body><main><h1>EXEC MCP v${version}</h1><p>The Web UI files are not built. Run npm run build, then reload this page.</p></main></body></html>`;
}

function positiveInteger(
  value: string | null,
  fallback: number,
  maximum: number,
): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? Math.min(parsed, maximum)
    : fallback;
}

/** The explicit type argument ties each response to the shared contract. */
function json<T = never>(
  res: ServerResponse,
  status: number,
  data: NoInfer<T>,
): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
}

function fail(
  res: ServerResponse,
  status: number,
  code: Api.ApiErrorCode,
  message: string,
): void {
  json<Api.ApiErrorBody>(res, status, {
    error: code,
    message,
    ...(code === "unauthorized" ? { needAuth: true as const } : {}),
  });
}

function respondError(res: ServerResponse, error: unknown): void {
  if (
    error instanceof HttpError ||
    error instanceof SessionNoteError ||
    error instanceof ConfigEditError
  ) {
    fail(res, error.status, error.code, error.message);
    return;
  }
  if (error instanceof z.ZodError) {
    fail(res, 400, "invalid_request", error.issues[0]?.message ?? "invalid");
    return;
  }
  fail(
    res,
    500,
    "internal_error",
    "The operation failed. Check the service status or the local logs.",
  );
}

async function readJsonBody(
  req: IncomingMessage,
  maximum = JSON_BODY_BYTES,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maximum) {
      req.resume();
      throw new HttpError(
        413,
        "body_too_large",
        `The request body is larger than ${maximum} bytes.`,
      );
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(
      400,
      "invalid_json",
      "The request body is not valid JSON.",
    );
  }
}

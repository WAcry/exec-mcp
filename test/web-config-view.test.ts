import { expect, it } from "vitest";
import type { DownstreamMcpServerConfig } from "../src/downstream/config.js";
import { mcpServerView } from "../src/web/config-view.js";

it("shows only the names of HTTP headers and token variables", () => {
  const server = {
    name: "remote",
    transport: "streamable-http",
    url: "https://user:pass@example.com/mcp?key=secret#part",
    headers: { "X-Static": "static-secret" },
    envHeaders: { "X-From-Env": "REMOTE_HEADER", "X-Static": "OTHER" },
    bearerTokenEnvVar: "REMOTE_TOKEN",
    startupTimeoutMs: 1000,
    toolTimeoutMs: 1000,
  } as unknown as DownstreamMcpServerConfig;
  const view = mcpServerView(server, false);
  expect(view).toMatchObject({
    url: "https://example.com/mcp",
    headerNames: ["X-From-Env", "X-Static"],
    bearerTokenEnvVar: "REMOTE_TOKEN",
  });
  const text = JSON.stringify(view);
  for (const secret of ["static-secret", "REMOTE_HEADER", "OTHER", "pass"])
    expect(text).not.toContain(secret);
});

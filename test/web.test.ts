import { describe, expect, it } from "vitest";
import { startServer } from "../src/server.js";
import { startWebServer } from "../src/web/server.js";
import { ActivityStore } from "../src/web/activity.js";

describe("Web UI Server & Activity Lifecycle", () => {
  it("starts the web server, generates LAN random secret, and handles health/status", async () => {
    const activity = new ActivityStore();
    const mcpServer = await startServer(
      {
        host: "127.0.0.1",
        port: 0,
        access: "openai-tunnel",
        mcpServers: [],
      },
      { activity },
    );

    const web = await startWebServer(
      mcpServer.runtime,
      {
        host: "127.0.0.1",
        port: 0,
        access: "openai-tunnel",
        mcpServers: [],
      },
      {
        port: 0,
        host: "127.0.0.1",
      },
    );

    try {
      expect(web.port).toBeGreaterThan(0);
      expect(web.token).toBeDefined();
      expect(web.token.length).toBeGreaterThanOrEqual(16);
      expect(web.loopbackUrl).toContain(`:${web.port}/`);
      expect(web.lanUrl).toContain(`:${web.port}/?token=${web.token}`);

      // Test status API
      const statusRes = await fetch(`http://127.0.0.1:${web.port}/api/status`);
      expect(statusRes.status).toBe(200);
      const status = await statusRes.json();
      expect(status.status).toBe("ready");
      expect(status.stats.totalCalls).toBe(0);

      // Record a test call in activity
      const tracker = activity.startCall({
        tool: "exec",
        sessionId: "test-session-1",
        args: { source: 'text("hello web ui");' },
      });
      tracker.recordSubcall({
        name: "exec_command",
        durationMs: 42,
        input: { command: "echo test" },
        output: { stdout: "test\n" },
        status: "success",
      });
      tracker.finish({
        status: "completed",
        output: { content: [{ type: "text", text: "hello web ui" }] },
      });

      // Verify call appeared in API
      const callsRes = await fetch(`http://127.0.0.1:${web.port}/api/calls`);
      expect(callsRes.status).toBe(200);
      const calls = await callsRes.json();
      expect(calls.total).toBe(1);
      expect(calls.items[0].tool).toBe("exec");
      expect(calls.items[0].subcalls.length).toBe(1);
      expect(calls.items[0].subcalls[0].name).toBe("exec_command");

      // Verify session appeared in API
      const sessionsRes = await fetch(
        `http://127.0.0.1:${web.port}/api/sessions`,
      );
      expect(sessionsRes.status).toBe(200);
      const sessions = await sessionsRes.json();
      expect(sessions.total).toBe(1);
      expect(sessions.items[0].id).toBe("test-session-1");
    } finally {
      await web.close();
      await mcpServer.close();
    }
  });

  it("verifies and regenerates LAN token", async () => {
    const activity = new ActivityStore();
    const mcpServer = await startServer(
      {
        host: "127.0.0.1",
        port: 0,
        access: "openai-tunnel",
        mcpServers: [],
      },
      { activity },
    );

    const web = await startWebServer(
      mcpServer.runtime,
      {
        host: "127.0.0.1",
        port: 0,
        access: "openai-tunnel",
        mcpServers: [],
      },
      {
        port: 0,
        host: "127.0.0.1",
      },
    );

    try {
      const initialToken = web.token;

      // Verify initial token
      const verifyOk = await fetch(
        `http://127.0.0.1:${web.port}/api/auth/verify`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: initialToken }),
        },
      );
      expect(verifyOk.status).toBe(200);
      const verifyJson = await verifyOk.json();
      expect(verifyJson.valid).toBe(true);

      // Verify wrong token
      const verifyBad = await fetch(
        `http://127.0.0.1:${web.port}/api/auth/verify`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: "wrong_token_123" }),
        },
      );
      expect(verifyBad.status).toBe(401);

      // Regenerate token
      const regenRes = await fetch(
        `http://127.0.0.1:${web.port}/api/auth/regenerate-token`,
        {
          method: "POST",
        },
      );
      expect(regenRes.status).toBe(200);
      const regenJson = await regenRes.json();
      expect(regenJson.success).toBe(true);
      expect(regenJson.token).not.toBe(initialToken);
      expect(web.token).toBe(regenJson.token);
    } finally {
      await web.close();
      await mcpServer.close();
    }
  });
});

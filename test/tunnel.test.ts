import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startServer } from "../src/server.js";
import type { Config } from "../src/config.js";

const fixture = vi.hoisted(() => ({
  commands: [] as {
    file: string;
    args: string[];
    inheritedProbe: string;
  }[],
  started: [] as {
    file: string;
    args: string[];
    inheritedProbe: string;
    cloudflareEnvUnchanged: boolean;
  }[],
  status: {} as Record<string, unknown>,
  serving: {} as Record<string, unknown>,
  invalidJson: false,
  exitCode: 0,
  longRunning: false,
}));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: (
      file: string,
      args: string[],
      options: import("node:child_process").ExecFileOptions,
      callback: (...args: unknown[]) => void,
    ) => {
      // Only fake the provider. taskkill remains a real owned-process cleanup call on Windows.
      if (file !== process.execPath)
        return actual.execFile(file, args, options, callback);
      fixture.commands.push({
        file,
        args,
        inheritedProbe: options.env?.EXEC_MCP_TUNNEL_INHERIT ?? "",
      });
      const value = args[0] === "status" ? fixture.status : fixture.serving;
      const output = fixture.invalidJson
        ? "invalid provider output"
        : JSON.stringify(value);
      return actual.execFile(
        process.execPath,
        ["-e", `process.stdout.write(${JSON.stringify(output)})`],
        options,
        callback,
      );
    },
    spawn: (
      file: string,
      args: string[],
      options: import("node:child_process").SpawnOptions,
    ) => {
      fixture.started.push({
        file,
        args,
        inheritedProbe: options.env?.EXEC_MCP_TUNNEL_INHERIT ?? "",
        cloudflareEnvUnchanged:
          options.env?.TUNNEL_TOKEN === process.env.TUNNEL_TOKEN &&
          options.env?.TUNNEL_TOKEN_FILE === process.env.TUNNEL_TOKEN_FILE,
      });
      const source = fixture.longRunning
        ? "setInterval(()=>{},1000)"
        : `process.exitCode=${fixture.exitCode}`;
      return actual.spawn(process.execPath, ["-e", source], {
        ...options,
        stdio: "ignore",
      });
    },
  };
});
import { prepareTunnel, runTunnel } from "../src/tunnel.js";

const cleanup: (() => Promise<unknown>)[] = [];
const envName = "EXEC_MCP_TEST_TUNNEL_TOKEN";
const savedEnv = process.env[envName];
const savedCloudflareToken = process.env.TUNNEL_TOKEN;
const savedCloudflareFile = process.env.TUNNEL_TOKEN_FILE;
const savedFixture = process.env.EXEC_MCP_TUNNEL_INHERIT;
let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "exec tunnel ' -")));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  process.env[envName] = "test-tunnel-auth-01234567890123456789012345";
  delete process.env.TUNNEL_TOKEN;
  delete process.env.TUNNEL_TOKEN_FILE;
  process.env.EXEC_MCP_TUNNEL_INHERIT = "fixture-value";
  fixture.commands = [];
  fixture.started = [];
  fixture.status = {
    BackendState: "Running",
    Self: { DNSName: "node.tailnet.ts.net." },
  };
  fixture.serving = {};
  fixture.invalidJson = false;
  fixture.exitCode = 0;
  fixture.longRunning = false;
});
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  for (const [key, value] of [
    [envName, savedEnv],
    ["TUNNEL_TOKEN", savedCloudflareToken],
    ["TUNNEL_TOKEN_FILE", savedCloudflareFile],
    ["EXEC_MCP_TUNNEL_INHERIT", savedFixture],
  ]) {
    if (value === undefined) delete process.env[key!];
    else process.env[key!] = value;
  }
});
async function configured(provider: "cloudflare" | "tailscale" = "tailscale") {
  const tokenFile = path.join(root, "token file.txt");
  await writeFile(tokenFile, "synthetic-cloudflare-token");
  const config: Config = {
    access: "public",
    host: "127.0.0.1",
    port: 0,
    public_url: "https://node.tailnet.ts.net",
    mcpServers: [],
    auth: { type: "bearer", token_env: envName },
    tunnel:
      provider === "cloudflare"
        ? { provider, executable: process.execPath, token_file: tokenFile }
        : { provider, executable: process.execPath },
  };
  const server = await startServer(config);
  cleanup.push(() => server.close());
  config.port = Number(new URL(server.url).port);
  return { config, server, tokenFile };
}

describe("foreground provider plans", () => {
  it("runs a named Cloudflare tunnel using a token file, never a secret argument or a Quick Tunnel", async () => {
    const { config, tokenFile } = await configured("cloudflare");
    const plan = await prepareTunnel(config);
    expect(plan).toEqual({
      file: process.execPath,
      provider: "cloudflare",
      publicUrl: "https://node.tailnet.ts.net/mcp",
      args: [
        "tunnel",
        "--no-autoupdate",
        "run",
        "--token=",
        "--token-file",
        tokenFile,
      ],
    });
    expect(JSON.stringify(plan)).not.toContain("synthetic-cloudflare-token");
    expect(plan.args).not.toContain("--url");
    expect(plan.args).not.toContain("service");
    expect(fixture.commands).toHaveLength(0);
  });
  it("checks tailscale identity and existing configuration before starting a non-persistent Funnel", async () => {
    const { config } = await configured();
    const plan = await prepareTunnel(config);
    expect(fixture.commands.map((item) => item.args)).toEqual([
      ["status", "--json"],
      ["serve", "status", "--json"],
    ]);
    expect(
      fixture.commands.every((item) => item.inheritedProbe === "fixture-value"),
    ).toBe(true);
    expect(plan.args).toEqual([
      "funnel",
      "--https=443",
      `http://127.0.0.1:${config.port}`,
    ]);
    expect(plan.args).not.toContain("--bg");
    expect(plan.args).not.toContain("reset");
    expect(plan.args).not.toContain("--yes");
  });
  it.each([
    { TCP: { "443": { HTTPS: true } } },
    { Foreground: { other: { TCP: { "443": { HTTPS: true } } } } },
    { Web: { "node.tailnet.ts.net:443": { Handlers: {} } } },
  ])(
    "refuses to take over a pre-existing Serve/Funnel listener",
    async (serving) => {
      const { config } = await configured();
      fixture.serving = serving;
      await expect(prepareTunnel(config)).rejects.toThrow("不会覆盖");
      expect(fixture.started).toHaveLength(0);
      expect(fixture.commands.some((item) => item.args.includes("reset"))).toBe(
        false,
      );
    },
  );
  it("leaves unrelated ports alone and supports the other Funnel HTTPS ports", async () => {
    const { config } = await configured();
    config.public_url = "https://node.tailnet.ts.net:8443";
    fixture.serving = { TCP: { "443": { HTTPS: true } } };
    const plan = await prepareTunnel(config);
    expect(plan.args).toContain("--https=8443");
    expect(plan.publicUrl).toBe("https://node.tailnet.ts.net:8443/mcp");
  });
  it("fails before changing any provider when the local endpoint is unauthenticated", async () => {
    const server = createServer((_request, response) =>
      response.end("unprotected"),
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    cleanup.push(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    );
    const { config } = await configured();
    config.port = (server.address() as AddressInfo).port;
    await expect(prepareTunnel(config)).rejects.toThrow("未返回认证挑战");
    expect(fixture.commands).toEqual([]);
    expect(fixture.started).toEqual([]);
  });
  it("rejects private mode, random ports and missing executable", async () => {
    const { config } = await configured("cloudflare");
    await expect(
      prepareTunnel({
        host: "127.0.0.1",
        port: 8891,
        access: "openai-tunnel",
        mcpServers: [],
      }),
    ).rejects.toThrow("公网模式");
    await expect(prepareTunnel({ ...config, port: 0 })).rejects.toThrow(
      "随机端口",
    );
    await expect(
      prepareTunnel({
        ...config,
        tunnel: {
          provider: "cloudflare",
          executable: path.join(root, "missing"),
          token_file: "missing",
        },
      }),
    ).rejects.toThrow("找不到");
    expect(fixture.started).toEqual([]);
  });
  it("rejects another tailscale node, a logged-out client, malformed status and missing token files", async () => {
    const { config } = await configured();
    fixture.status = {
      BackendState: "NeedsLogin",
      Self: { DNSName: "node.tailnet.ts.net." },
    };
    await expect(prepareTunnel(config)).rejects.toThrow("已登录");
    fixture.status = {
      BackendState: "Running",
      Self: { DNSName: "different.tailnet.ts.net." },
    };
    await expect(prepareTunnel(config)).rejects.toThrow("本节点");
    fixture.invalidJson = true;
    await expect(prepareTunnel(config)).rejects.toThrow("未修改现有配置");
    const cloudflare = await configured("cloudflare");
    await rm(cloudflare.tokenFile);
    await expect(prepareTunnel(cloudflare.config)).rejects.toThrow(
      "token_file",
    );
    expect(fixture.started).toEqual([]);
  });
});

describe("owned Tunnel process lifecycle", () => {
  it("uses an explicit token file even with an inherited token, without removing either environment variable", async () => {
    const { config, tokenFile } = await configured("cloudflare");
    process.env.TUNNEL_TOKEN = "synthetic-existing-other-tunnel-token";
    process.env.TUNNEL_TOKEN_FILE = path.join(root, "unrelated-file");
    const started = vi.fn();
    await runTunnel(config, { onStarted: started });
    expect(fixture.started).toHaveLength(1);
    expect(fixture.started[0]!.args).toEqual([
      "tunnel",
      "--no-autoupdate",
      "run",
      "--token=",
      "--token-file",
      tokenFile,
    ]);
    expect(fixture.started[0]!.cloudflareEnvUnchanged).toBe(true);
    expect(process.env.TUNNEL_TOKEN).toBe(
      "synthetic-existing-other-tunnel-token",
    );
    expect(process.env.TUNNEL_TOKEN_FILE).toBe(
      path.join(root, "unrelated-file"),
    );
    expect(JSON.stringify(started.mock.calls)).not.toContain(
      "synthetic-existing-other-tunnel-token",
    );
    expect(JSON.stringify(started.mock.calls)).not.toContain(
      "synthetic-cloudflare-token",
    );
  });
  it("reuses TUNNEL_TOKEN without materializing it in a file, arguments or the public plan", async () => {
    const { config, tokenFile } = await configured("cloudflare");
    config.tunnel = { provider: "cloudflare", executable: process.execPath };
    process.env.TUNNEL_TOKEN = "synthetic-reused-tunnel-token";
    process.env.TUNNEL_TOKEN_FILE = path.join(
      root,
      "missing-file-ignored-by-native-token",
    );
    const plan = await prepareTunnel(config);
    expect(plan.args).toEqual(["tunnel", "--no-autoupdate", "run"]);
    expect(JSON.stringify(plan)).not.toContain(process.env.TUNNEL_TOKEN);
    await rm(tokenFile);
    await runTunnel(config);
    expect(fixture.started[0]!.cloudflareEnvUnchanged).toBe(true);
    expect(fixture.started[0]!.args).toEqual(plan.args);
  });
  it("accepts native TUNNEL_TOKEN_FILE only when neither explicit file nor environment token takes priority", async () => {
    const { config, tokenFile } = await configured("cloudflare");
    config.tunnel = { provider: "cloudflare", executable: process.execPath };
    process.env.TUNNEL_TOKEN_FILE = tokenFile;
    const plan = await prepareTunnel(config);
    expect(plan.args).toEqual([
      "tunnel",
      "--no-autoupdate",
      "run",
      "--token=",
      "--token-file",
      tokenFile,
    ]);
    await runTunnel(config);
    expect(fixture.started[0]!.cloudflareEnvUnchanged).toBe(true);
    delete process.env.TUNNEL_TOKEN_FILE;
    await expect(prepareTunnel(config)).rejects.toThrow(
      "需要 tunnel.token_file",
    );
  });
  it("does not fall back to an inherited token when an explicitly selected file is missing or empty", async () => {
    const { config, tokenFile } = await configured("cloudflare");
    process.env.TUNNEL_TOKEN = "synthetic-token-that-must-not-be-used";
    await writeFile(tokenFile, " \r\n");
    await expect(runTunnel(config)).rejects.toThrow("token_file");
    await rm(tokenFile);
    await expect(runTunnel(config)).rejects.toThrow("token_file");
    expect(fixture.started).toEqual([]);
  });
  it("starts only the selected provider, preserves the environment and never stops the MCP server", async () => {
    const { config, server } = await configured("cloudflare");
    const started = vi.fn();
    await runTunnel(config, { onStarted: started });
    expect(started).toHaveBeenCalledTimes(1);
    expect(fixture.started).toHaveLength(1);
    expect(fixture.started[0]!.inheritedProbe).toBe("fixture-value");
    expect(fixture.started[0]!.args[0]).toBe("tunnel");
    expect((await fetch(server.url)).status).toBe(401);
  });
  it("stops its foreground provider on cancellation without resetting persistent Tailscale configuration", async () => {
    const { config, server } = await configured();
    fixture.longRunning = true;
    const controller = new AbortController();
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const work = runTunnel(config, {
      signal: controller.signal,
      onStarted: () => ready(),
    });
    await started;
    controller.abort();
    await work;
    expect(fixture.started).toHaveLength(1);
    expect(fixture.commands.map((item) => item.args)).toEqual([
      ["status", "--json"],
      ["serve", "status", "--json"],
    ]);
    expect((await fetch(server.url)).status).toBe(401);
  });
  it("does not replay failed launches and does no work when already cancelled", async () => {
    const { config } = await configured("cloudflare");
    fixture.exitCode = 2;
    await expect(runTunnel(config)).rejects.toThrow("已退出");
    expect(fixture.started).toHaveLength(1);
    await expect(
      runTunnel(config, { signal: AbortSignal.abort() }),
    ).rejects.toThrow();
    expect(fixture.started).toHaveLength(1);
  });
});

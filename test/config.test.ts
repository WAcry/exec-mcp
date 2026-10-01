import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONFIG_TEMPLATE,
  ConfigError,
  initializeConfig,
  parseConfig,
} from "../src/config.js";
import { configDirectory } from "../src/host/platform.js";
import { codexTarget } from "../src/codex-package.js";

describe("configuration and platform boundaries", () => {
  it("accepts every TOML example in the user configuration guide", async () => {
    const guide = await readFile(
      new URL("../docs/guides/configuration.md", import.meta.url),
      "utf8",
    );
    const examples = [...guide.matchAll(/^```toml\r?\n([\s\S]*?)^```/gm)];
    expect(examples.length).toBeGreaterThan(0);
    for (const [, example] of examples) {
      const input = /^\[server\]/m.test(example!)
        ? example!
        : `${CONFIG_TEMPLATE}\n${example}`;
      expect(() => parseConfig(input, "config.toml")).not.toThrow();
    }
  });
  it("keeps the Web console loopback-only by default and validates explicit exposure", () => {
    expect(parseConfig(CONFIG_TEMPLATE, "config.toml").web).toBeUndefined();
    expect(
      parseConfig(
        CONFIG_TEMPLATE + '\n[web]\nenabled=true\nhost="0.0.0.0"\nport=9000\n',
        "config.toml",
      ).web,
    ).toEqual({ enabled: true, host: "0.0.0.0", port: 9000 });
    for (const value of [
      'host="localhost"',
      'host="192.168.1.10"',
      "port=-1",
      "port=65536",
      'enabled="true"',
      "unknown=true",
    ])
      expect(() =>
        parseConfig(CONFIG_TEMPLATE + `\n[web]\n${value}\n`, "config.toml"),
      ).toThrow("web");
  });
  it("accepts a configurable Skill character budget with a 40000 default and rejects ambiguous knobs", () => {
    expect(
      parseConfig(CONFIG_TEMPLATE + "\n[skills]\n", "config.toml").skills,
    ).toEqual({ max_chars: 40000 });
    expect(
      parseConfig(
        CONFIG_TEMPLATE + "\n[skills]\nmax_chars=80000\n",
        "config.toml",
      ).skills,
    ).toEqual({ max_chars: 80000 });
    for (const entry of [
      "max_chars=0",
      "max_chars=-1",
      "max_chars=1.5",
      'max_chars="40000"',
      "max_tokens=10000",
      "max_chars=9007199254740992",
    ])
      expect(() =>
        parseConfig(CONFIG_TEMPLATE + `\n[skills]\n${entry}\n`, "config.toml"),
      ).toThrow("skills");
  });
  it("requires an explicit private-tunnel trust mode", () => {
    expect(() => parseConfig("[server]\nport=8891", "config.toml")).toThrow(
      "- server.access: Invalid option",
    );
    expect(parseConfig(CONFIG_TEMPLATE, "config.toml")).toEqual({
      host: "127.0.0.1",
      port: 8891,
      access: "openai-tunnel",
      mcpServers: [],
    });
  });
  it.each(["0.0.0.0", "localhost", "public.example"])(
    "rejects listener %s",
    (host) => {
      expect(() =>
        parseConfig(CONFIG_TEMPLATE.replace("127.0.0.1", host), "config.toml"),
      ).toThrow();
    },
  );
  it("parses stdio and HTTP configuration without importing other products", () => {
    const value = parseConfig(
      CONFIG_TEMPLATE +
        '\n[mcp_servers.local]\ncommand="node"\nargs=["x.js"]\ncwd="project"\n[mcp_servers.remote]\nurl="https://example.com/mcp"\n',
      path.join(tmpdir(), "config.toml"),
    );
    expect(value.mcpServers).toHaveLength(2);
    expect(value.mcpServers[0]).toMatchObject({
      transport: "stdio",
      cwd: path.join(tmpdir(), "project"),
    });
  });
  it("never echoes credential-bearing TOML source on errors", () => {
    let message = "";
    try {
      parseConfig('[server]\nsecret="hidden-secret\n', "config.toml");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe(
      "The configuration is not valid TOML near line 2, column 22. Fix the syntax there. The content is not shown, because it can hold credentials.",
    );
  });
  it("lists each field error with its reason and without the configured values", () => {
    let message = "";
    try {
      parseConfig(
        CONFIG_TEMPLATE +
          [
            "[mcp_servers.remote]",
            'url="https://user:SECRET_PASSWORD@example.test/mcp"',
            'headers={ "bad name"="SECRET_HEADER", Authorization="SECRET_TOKEN" }',
            'bearer_token_env_var="REMOTE_TOKEN"',
            "[mcp_servers.local]",
            'command="node"',
            'env_http_headers={ X-Key="SECRET_NAME" }',
            "[mcp_servers.slow]",
            'command="node"',
            "tool_timeout_sec=1e9",
          ].join("\n"),
        "config.toml",
      );
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      message = (error as Error).message;
    }
    expect(message.split("\n")).toEqual([
      "The configuration has fields that are not valid. Fix them, then start exec-mcp again:",
      "- mcp_servers.remote.headers.bad name: the key must be an HTTP header name with only letters, digits, and !#$%&'*+-.^_`|~",
      "- mcp_servers.remote.bearer_token_env_var: bearer_token_env_var sets the Authorization header; remove Authorization from headers and env_http_headers",
      "- mcp_servers.remote.url: url must be an http or https URL without a user name or password; send credentials with headers, env_http_headers, or bearer_token_env_var",
      "- mcp_servers.local: a server with command cannot have the HTTP fields headers, env_http_headers, or bearer_token_env_var; pass credentials to a stdio server with env",
      "- mcp_servers.slow.tool_timeout_sec: Too big: expected number to be <=2147483.647",
    ]);
    expect(message).not.toContain("SECRET");
  });
  it("converts timeouts to whole milliseconds within the Node.js timer range", () => {
    const [server] = parseConfig(
      CONFIG_TEMPLATE +
        '\n[mcp_servers.local]\ncommand="node"\nstartup_timeout_sec=16.1\ntool_timeout_sec=2.01\n',
      "config.toml",
    ).mcpServers;
    expect(server).toMatchObject({
      startupTimeoutMs: 16_100,
      toolTimeoutMs: 2_010,
    });
    const [longest] = parseConfig(
      CONFIG_TEMPLATE +
        '\n[mcp_servers.local]\ncommand="node"\ntool_timeout_sec=2147483.647\n',
      "config.toml",
    ).mcpServers;
    expect(longest!.toolTimeoutMs).toBe(2 ** 31 - 1);
    for (const value of ["0", "0.0004", "2147484"])
      expect(() =>
        parseConfig(
          CONFIG_TEMPLATE +
            `\n[mcp_servers.local]\ncommand="node"\ntool_timeout_sec=${value}\n`,
          "config.toml",
        ),
      ).toThrow("mcp_servers.local.tool_timeout_sec");
  });
  it("reads HTTP credentials from environment variable names like Codex", () => {
    const [server] = parseConfig(
      CONFIG_TEMPLATE +
        '\n[mcp_servers.remote]\nurl="https://example.test/mcp"\nheaders={ X-Static="1" }\nenv_http_headers={ X-Api-Key="REMOTE_API_KEY" }\nbearer_token_env_var="REMOTE_TOKEN"\n',
      "config.toml",
    ).mcpServers;
    expect(server).toEqual({
      name: "remote",
      transport: "streamable-http",
      url: "https://example.test/mcp",
      headers: { "X-Static": "1" },
      envHeaders: { "X-Api-Key": "REMOTE_API_KEY" },
      bearerTokenEnvVar: "REMOTE_TOKEN",
    });
  });
  it("initializes once and refuses overwrite", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "exec-init-"));
    const file = path.join(dir, "config.toml");
    try {
      await initializeConfig(file);
      await expect(initializeConfig(file)).rejects.toThrow();
      expect(await readFile(file, "utf8")).toBe(CONFIG_TEMPLATE);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("chooses platform user paths and PowerShell rather than assuming Bash", () => {
    expect(
      configDirectory("linux", { XDG_CONFIG_HOME: "/custom" }, "/home/test"),
    ).toBe(path.join("/custom", "exec-mcp"));
    expect(configDirectory("darwin", {}, "/Users/test")).toContain("Library");
    expect(
      configDirectory(
        "win32",
        { APPDATA: "C:/Users/test/AppData/Roaming" },
        "C:/Users/test",
      ),
    ).toContain("Roaming");
  });
  it.each(["linux", "darwin", "win32"])(
    "selects pinned packages for %s",
    (platform) => {
      expect(codexTarget(platform, "x64").target).toBeTruthy();
      expect(codexTarget(platform, "arm64").target).toBeTruthy();
    },
  );
});

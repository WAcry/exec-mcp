import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONFIG_TEMPLATE,
  initializeConfig,
  parseConfig,
} from "../src/config.js";
import { configDirectory } from "../src/host/platform.js";
import { codexTarget } from "../src/codex-package.js";

describe("configuration and platform boundaries", () => {
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
      "配置字段",
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
    expect(() => parseConfig('secret="hidden-secret\n', "config.toml")).toThrow(
      "配置不是有效的 TOML",
    );
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

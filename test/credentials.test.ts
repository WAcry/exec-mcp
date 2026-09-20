import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readTokenFile, TOKEN_FILE_PREFIX } from "../src/credentials.js";
import { CONFIG_TEMPLATE, parseConfig } from "../src/config.js";
import { startServer } from "../src/server.js";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { jsonOutput } from "./helpers.js";

const cleanups: (() => Promise<unknown>)[] = [];
const defaultToken = process.env.EXEC_MCP_ACCESS_TOKEN;
const envName = "EXEC_MCP_CREDENTIAL_TEST_TOKEN";
const customToken = process.env[envName];
const token = "synthetic-file-token-012345678901234567890123456789";
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const [name, value] of [
    ["EXEC_MCP_ACCESS_TOKEN", defaultToken],
    [envName, customToken],
  ]) {
    if (value === undefined) delete process.env[name!];
    else process.env[name!] = value;
  }
});
async function directory() {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "exec credentials ' -")),
  );
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}
function config(auth: string, filename = path.join(tmpdir(), "config.toml")) {
  return parseConfig(
    CONFIG_TEMPLATE.replace(
      'access = "openai-tunnel"',
      'access = "public"\npublic_url="https://credential.example.test"',
    ).replace("port = 8891", "port = 0") + `\n[auth]\ntype="bearer"\n${auth}\n`,
    filename,
  );
}

describe("explicit bearer credential sources", () => {
  it("preserves the environment default while allowing exactly one explicit source", () => {
    expect(config("").auth).toEqual({
      type: "bearer",
      token_env: "EXEC_MCP_ACCESS_TOKEN",
    });
    expect(config(`token_env="${envName}"`).auth).toEqual({
      type: "bearer",
      token_env: envName,
    });
    const filename = path.join(tmpdir(), "settings", "config.toml");
    expect(config('token_file="./secrets/token.txt"', filename).auth).toEqual({
      type: "bearer",
      token_file: path.join(tmpdir(), "settings", "secrets", "token.txt"),
    });
    expect(config('token_file="~/secrets/token.txt"', filename).auth).toEqual({
      type: "bearer",
      token_file: path.join(homedir(), "secrets", "token.txt"),
    });
    for (const fields of [
      'token_env="TOKEN"\ntoken_file="./token"',
      'token_file=""',
      "token_file=7",
      'token_env="bad name"',
    ])
      expect(() => config(fields)).toThrow("auth");
  });
  it("reads one bounded regular file, accepting UTF-8 BOM and trailing editor newlines", async () => {
    const root = await directory();
    const file = path.join(root, "token.txt");
    await writeFile(file, `\uFEFF${token}\r\n`);
    expect(readTokenFile(file, "auth.token_file")).toBe(token);
    const protectedText = await readFile(file, "utf8");
    expect(protectedText.startsWith(TOKEN_FILE_PREFIX)).toBe(true);
    expect(protectedText).not.toContain(token);
    expect(readTokenFile(file, "auth.token_file")).toBe(token);
    expect(await readFile(file, "utf8")).toBe(protectedText);
  });
  it("rejects unreadable, empty, whitespace-only, directory and oversized sources without exposing contents", async () => {
    const root = await directory();
    const file = path.join(root, "token.txt");
    expect(() => readTokenFile(file, "auth.token_file")).toThrow(
      "auth.token_file",
    );
    expect(() => readTokenFile(root, "auth.token_file")).toThrow(
      "普通 token 文件",
    );
    for (const value of ["", " \n\r\t", "PRIVATE_DATA".repeat(7000)]) {
      await writeFile(file, value);
      let message = "";
      try {
        readTokenFile(file, "auth.token_file");
      } catch (error) {
        message = String(error);
      }
      expect(message).toContain("auth.token_file");
      expect(message).not.toContain("PRIVATE_DATA");
    }
  });
  it("supports a symlinked credential directory without altering it", async () => {
    const root = await directory();
    const actual = path.join(root, "actual");
    await mkdir(actual);
    await writeFile(path.join(actual, "token.txt"), token);
    const alias = path.join(root, "secret mount");
    await symlink(
      actual,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(
      readTokenFile(path.join(alias, "token.txt"), "auth.token_file"),
    ).toBe(token);
  });
  it("does not fall back to the default environment when the chosen file is absent, invalid or weak", async () => {
    process.env.EXEC_MCP_ACCESS_TOKEN = token;
    const root = await directory();
    const file = path.join(root, "token.txt");
    const selected = config(
      'token_file="./token.txt"',
      path.join(root, "config.toml"),
    );
    await expect(startServer(selected)).rejects.toThrow("auth.token_file");
    for (const value of [
      "short",
      token + "\nSECOND_TOKEN",
      '"' + token + '"',
      "invalid-token-with-空格-".repeat(3),
    ]) {
      await writeFile(file, value);
      await expect(startServer(selected)).rejects.toThrow("至少 32");
    }
    await expect(
      startServer({
        ...selected,
        auth: {
          type: "bearer",
          token_env: "EXEC_MCP_ACCESS_TOKEN",
          token_file: file,
        },
      }),
    ).rejects.toThrow("二选一");
    expect(process.env.EXEC_MCP_ACCESS_TOKEN).toBe(token);
  });
});

describe.each([false, true])(
  "file-backed bearer on actual MCP (legacy=%s)",
  (legacy) => {
    it("authenticates without any env credential and preserves the startup snapshot until restart", async () => {
      delete process.env.EXEC_MCP_ACCESS_TOKEN;
      const root = await directory();
      const file = path.join(root, "token.txt");
      await writeFile(file, `\uFEFF${token}\r\n`);
      const selected = config(
        'token_file="./token.txt"',
        path.join(root, "config.toml"),
      );
      const server = await startServer(selected);
      cleanups.push(() => server.close());
      expect((await readFile(file, "utf8")).startsWith(TOKEN_FILE_PREFIX)).toBe(
        true,
      );
      expect(await readFile(file, "utf8")).not.toContain(token);
      expect((await fetch(server.url)).status).toBe(401);
      const client = new Client(
        { name: "file-credential-test", version: "1" },
        { versionNegotiation: { mode: legacy ? "legacy" : "auto" } },
      );
      cleanups.push(() => client.close());
      await client.connect(
        new StreamableHTTPClientTransport(new URL(server.url), {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
        }),
      );
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(
        TOP_LEVEL_TOOL_NAMES,
      );
      expect(JSON.stringify(tools)).not.toContain(token);
      expect(JSON.stringify(tools)).not.toContain(file);
      const newer = token + "-rotated";
      await writeFile(file, newer);
      expect(
        (
          await fetch(server.url, {
            headers: { Authorization: `Bearer ${newer}` },
          })
        ).status,
      ).toBe(401);
      const result = await client.callTool({
        name: "exec",
        arguments: { source: "text(6*7)" },
      });
      expect(result.isError).not.toBe(true);
      expect(jsonOutput(result)).toBe(42);
      await client.close();
      await server.close();
      const restarted = await startServer(selected);
      cleanups.push(() => restarted.close());
      expect(readTokenFile(file, "auth.token_file")).toBe(newer);
      expect(await readFile(file, "utf8")).not.toContain(newer);
      expect(
        (
          await fetch(restarted.url, {
            headers: { Authorization: `Bearer ${token}` },
          })
        ).status,
      ).toBe(401);
      const next = new Client(
        { name: "rotated-credential-test", version: "1" },
        { versionNegotiation: { mode: legacy ? "legacy" : "auto" } },
      );
      cleanups.push(() => next.close());
      await next.connect(
        new StreamableHTTPClientTransport(new URL(restarted.url), {
          requestInit: { headers: { Authorization: `Bearer ${newer}` } },
        }),
      );
      expect((await next.listTools()).tools).toHaveLength(
        TOP_LEVEL_TOOL_NAMES.length,
      );
    });
  },
);
import { TOP_LEVEL_TOOL_NAMES } from "../src/tool-names.js";

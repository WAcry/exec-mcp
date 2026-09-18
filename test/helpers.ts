import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
} from "@modelcontextprotocol/client";
import { startServer } from "../src/server.js";
import type { Config } from "../src/config.js";
import type { TerminalResult, WriteStdinInput } from "../src/host/terminal.js";
import { performance } from "node:perf_hooks";

/** Observe one process, never replay the command/input. Use one absolute deadline,
 * not a fixed number of polls or an assumption that output implies process exit.
 */
export async function observeTerminal(
  first: TerminalResult,
  read: (input: WriteStdinInput) => Promise<TerminalResult>,
  until?: (result: TerminalResult) => boolean,
  timeoutMs = 15_000,
): Promise<TerminalResult> {
  const deadline = performance.now() + timeoutMs;
  let current = first;
  let output = first.output;
  let elapsed = first.wall_time_seconds;
  while (true) {
    const aggregate = { ...current, output, wall_time_seconds: elapsed };
    if (until ? until(aggregate) : !current.session_id) return aggregate;
    const remaining = Math.floor(deadline - performance.now());
    if (!current.session_id || remaining <= 0)
      throw new Error(
        `Terminal did not reach the expected state: ${JSON.stringify({ ...aggregate, output: output.slice(-4096) })}`,
      );
    current = await read({
      session_id: current.session_id,
      yield_time_ms: Math.min(1000, remaining),
    });
    output += current.output;
    elapsed += current.wall_time_seconds;
  }
}
export function texts(result: CallToolResult): string[] {
  return result.content.flatMap((item) =>
    item.type === "text" ? [item.text] : [],
  );
}
export function jsonOutput<T = Record<string, unknown>>(
  result: CallToolResult,
): T {
  for (const text of texts(result).toReversed()) {
    try {
      return JSON.parse(text) as T;
    } catch {}
  }
  throw new Error(`Missing JSON output: ${texts(result).join("\n")}`);
}
export function cellId(result: CallToolResult): string {
  const id = texts(result)
    .join("\n")
    .match(/cell_[A-Za-z0-9_-]+/)?.[0];
  if (!id) throw new Error(`Missing cell_id: ${JSON.stringify(result)}`);
  return id;
}
export function nodeCommand(source: string): string {
  const script = `eval(Buffer.from('${Buffer.from(source).toString("base64")}','base64').toString())`;
  const quote = (value: string): string =>
    process.platform === "win32"
      ? `'${value.replaceAll("'", "''")}'`
      : `'${value.replaceAll("'", "'\\''")}'`;
  return `${process.platform === "win32" ? "& " : ""}${quote(process.execPath)} -e ${quote(script)}${process.platform === "win32" ? "; exit $LASTEXITCODE" : ""}`;
}
export async function connect(overrides: Partial<Config> = {}, legacy = false) {
  const server = await startServer({
    host: "127.0.0.1",
    port: 0,
    access: "openai-tunnel",
    mcpServers: [],
    ...overrides,
  });
  const client = new Client(
    { name: "exec-mcp-test", version: "1" },
    { versionNegotiation: { mode: legacy ? "legacy" : "auto" } },
  );
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(server.url)),
    );
  } catch (error) {
    await server.close();
    throw error;
  }
  return {
    ...server,
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

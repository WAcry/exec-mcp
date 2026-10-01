import crypto from "node:crypto";
import type { Implementation, Tool } from "@modelcontextprotocol/client";
import type { DownstreamTool } from "../types.js";
import type { DownstreamMcpServerConfig } from "./config.js";
import { SetupError } from "./errors.js";

const TOOL_ID_PREFIX = "mcp-id:v1:";
const MAX_CODE_NAME_LENGTH = 128;
const CODE_NAME_HASH_LENGTH = 12;

/** Opaque, reversible identity of one tool on one configured server. */
export function encodeDownstreamToolId(
  serverId: string,
  toolName: string,
): string {
  if (serverId.length === 0 || toolName.length === 0) {
    throw new Error("Downstream MCP server and tool names must not be empty.");
  }
  return (
    TOOL_ID_PREFIX +
    Buffer.from(JSON.stringify([serverId, toolName]), "utf8").toString(
      "base64url",
    )
  );
}

export function decodeDownstreamToolId(toolId: string): {
  serverId: string;
  toolName: string;
} {
  if (!toolId.startsWith(TOOL_ID_PREFIX))
    throw new Error("The downstream MCP tool ID is not valid.");
  try {
    const raw = Buffer.from(
      toolId.slice(TOOL_ID_PREFIX.length),
      "base64url",
    ).toString("utf8");
    const decoded: unknown = JSON.parse(raw);
    if (
      !Array.isArray(decoded) ||
      decoded.length !== 2 ||
      typeof decoded[0] !== "string" ||
      decoded[0].length === 0 ||
      typeof decoded[1] !== "string" ||
      decoded[1].length === 0 ||
      encodeDownstreamToolId(decoded[0], decoded[1]) !== toolId
    ) {
      throw new Error("invalid");
    }
    return { serverId: decoded[0], toolName: decoded[1] };
  } catch {
    throw new Error("The downstream MCP tool ID is not valid.");
  }
}

/**
 * JavaScript-safe name for tools.* and ALL_TOOLS. Plain names keep the
 * readable mcp__server__tool form; ambiguous or long ones get a hash suffix,
 * so different server/tool pairs never share a name.
 */
export function createDownstreamCodeName(
  serverId: string,
  toolName: string,
): string {
  const rawBase = `mcp__${serverId}__${toolName}`;
  const sanitized = sanitizeCodeName(rawBase);
  const unambiguous =
    !serverId.includes("__") &&
    !toolName.includes("__") &&
    !serverId.endsWith("_") &&
    !toolName.startsWith("_") &&
    sanitized === rawBase &&
    sanitized.length <= MAX_CODE_NAME_LENGTH;
  if (unambiguous) return sanitized;

  const suffix = `_${crypto
    .createHash("sha256")
    .update(serverId)
    .update("\0")
    .update(toolName)
    .digest("hex")
    .slice(0, CODE_NAME_HASH_LENGTH)}`;
  const prefix = "mcp_h__";
  const available = MAX_CODE_NAME_LENGTH - prefix.length - suffix.length;
  return `${prefix}${sanitized.slice("mcp__".length, "mcp__".length + available)}${suffix}`;
}

function sanitizeCodeName(value: string): string {
  const sanitized = [...value]
    .map((character) => (/[A-Za-z0-9_]/u.test(character) ? character : "_"))
    .join("");
  return sanitized.length === 0 ? "_" : sanitized;
}

/** Map one server's listed tools to bound contracts, applying enabled_tools. */
export function describeTools(
  server: {
    readonly config: DownstreamMcpServerConfig;
    readonly serverVersion?: Implementation;
    readonly namespaceInstructions?: string;
  },
  values: readonly Tool[],
): ReadonlyMap<string, DownstreamTool> {
  const state = server;
  const tools = new Map<string, DownstreamTool>();
  const seen = new Set<string>();
  const enabled =
    state.config.enabledTools === undefined
      ? undefined
      : new Set(state.config.enabledTools);
  for (const value of values) {
    if (seen.has(value.name)) {
      throw new SetupError(
        `Downstream MCP server ${JSON.stringify(state.config.name)} returned the tool name ${JSON.stringify(value.name)} more than once. Fix the server, or set enabled = false for it.`,
      );
    }
    seen.add(value.name);
    if (enabled !== undefined && !enabled.has(value.name)) continue;
    const tool = structuredClone(value);
    tools.set(value.name, {
      id: encodeDownstreamToolId(state.config.name, value.name),
      codeName: createDownstreamCodeName(state.config.name, value.name),
      serverId: state.config.name,
      ...(state.serverVersion === undefined
        ? {}
        : {
            serverName: state.serverVersion.name,
            ...(state.serverVersion.title === undefined
              ? {}
              : { serverTitle: state.serverVersion.title }),
          }),
      ...(state.namespaceInstructions === undefined
        ? {}
        : { namespaceInstructions: state.namespaceInstructions }),
      tool,
    });
  }
  for (const name of enabled ?? [])
    if (!seen.has(name))
      throw new SetupError(
        `Downstream MCP server ${JSON.stringify(state.config.name)}: enabled_tools lists ${JSON.stringify(name)}, which is not in the server's tool catalog. Fix enabled_tools in config.toml.`,
      );
  return tools;
}

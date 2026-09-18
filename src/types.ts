import type { Tool } from "@modelcontextprotocol/client";
export type JsonObject = Record<string, unknown>;
export interface DownstreamTool {
  id: string;
  codeName: string;
  serverId: string;
  serverName?: string;
  serverTitle?: string;
  namespaceInstructions?: string;
  tool: Tool;
}

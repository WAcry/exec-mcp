export interface McpPolicy {
  enabledTools?: readonly string[];
  startupTimeoutMs?: number;
  toolTimeoutMs?: number;
}
export type DownstreamMcpServerConfig = McpPolicy &
  (
    | {
        name: string;
        transport: "stdio";
        command: string;
        args: readonly string[];
        env: Readonly<Record<string, string>>;
        cwd?: string;
      }
    | {
        name: string;
        transport: "streamable-http";
        url: string;
        headers: Readonly<Record<string, string>>;
      }
  );
